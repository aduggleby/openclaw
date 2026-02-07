import type {
  Browser,
  BrowserContext,
  ConsoleMessage,
  Page,
  Request,
  Response,
} from "playwright-core";
import { chromium } from "playwright-core";
import { formatErrorMessage } from "../infra/errors.js";
import { getHeadersWithAuth } from "./cdp.helpers.js";
import { getChromeWebSocketUrl } from "./chrome.js";

import { loadConfig } from "../config/config.js";
import { resolveBrowserConfig } from "./config.js";
export type BrowserConsoleMessage = {
  type: string;
  text: string;
  timestamp: string;
  location?: { url?: string; lineNumber?: number; columnNumber?: number };
};

export type BrowserPageError = {
  message: string;
  name?: string;
  stack?: string;
  timestamp: string;
};

export type BrowserNetworkRequest = {
  id: string;
  timestamp: string;
  method: string;
  url: string;
  resourceType?: string;
  status?: number;
  ok?: boolean;
  failureText?: string;
};

type SnapshotForAIResult = { full: string; incremental?: string };
type SnapshotForAIOptions = { timeout?: number; track?: string };

export type WithSnapshotForAI = {
  _snapshotForAI?: (options?: SnapshotForAIOptions) => Promise<SnapshotForAIResult>;
};

type TargetInfoResponse = {
  targetInfo?: {
    targetId?: string;
  };
};

type ConnectedBrowser = {
  browser: Browser;
  cdpUrl: string;
};

type PageState = {
  console: BrowserConsoleMessage[];
  errors: BrowserPageError[];
  requests: BrowserNetworkRequest[];
  requestIds: WeakMap<Request, string>;
  nextRequestId: number;
  armIdUpload: number;
  armIdDialog: number;
  armIdDownload: number;
  /**
   * Role-based refs from the last role snapshot (e.g. e1/e2).
   * Mode "role" refs are generated from ariaSnapshot and resolved via getByRole.
   * Mode "aria" refs are Playwright aria-ref ids and resolved via `aria-ref=...`.
   */
  roleRefs?: Record<string, { role: string; name?: string; nth?: number }>;
  roleRefsMode?: "role" | "aria";
  roleRefsFrameSelector?: string;
};

type RoleRefs = NonNullable<PageState["roleRefs"]>;
type RoleRefsCacheEntry = {
  refs: RoleRefs;
  frameSelector?: string;
  mode?: NonNullable<PageState["roleRefsMode"]>;
};

type ContextState = {
  traceActive: boolean;
};

const pageStates = new WeakMap<Page, PageState>();
const contextStates = new WeakMap<BrowserContext, ContextState>();
const observedContexts = new WeakSet<BrowserContext>();
const observedPages = new WeakSet<Page>();

// Best-effort cache to make role refs stable even if Playwright returns a different Page object
// for the same CDP target across requests.
const roleRefsByTarget = new Map<string, RoleRefsCacheEntry>();
const MAX_ROLE_REFS_CACHE = 50;

const MAX_CONSOLE_MESSAGES = 500;
const MAX_PAGE_ERRORS = 200;
const MAX_NETWORK_REQUESTS = 500;

let cached: ConnectedBrowser | null = null;
let connecting: Promise<ConnectedBrowser> | null = null;

function normalizeCdpUrl(raw: string) {
  return raw.replace(/\/$/, "");
}

function roleRefsKey(cdpUrl: string, targetId: string) {
  return `${normalizeCdpUrl(cdpUrl)}::${targetId}`;
}

export function rememberRoleRefsForTarget(opts: {
  cdpUrl: string;
  targetId: string;
  refs: RoleRefs;
  frameSelector?: string;
  mode?: NonNullable<PageState["roleRefsMode"]>;
}): void {
  const targetId = opts.targetId.trim();
  if (!targetId) {
    return;
  }
  roleRefsByTarget.set(roleRefsKey(opts.cdpUrl, targetId), {
    refs: opts.refs,
    ...(opts.frameSelector ? { frameSelector: opts.frameSelector } : {}),
    ...(opts.mode ? { mode: opts.mode } : {}),
  });
  while (roleRefsByTarget.size > MAX_ROLE_REFS_CACHE) {
    const first = roleRefsByTarget.keys().next();
    if (first.done) {
      break;
    }
    roleRefsByTarget.delete(first.value);
  }
}

export function storeRoleRefsForTarget(opts: {
  page: Page;
  cdpUrl: string;
  targetId?: string;
  refs: RoleRefs;
  frameSelector?: string;
  mode: NonNullable<PageState["roleRefsMode"]>;
}): void {
  const state = ensurePageState(opts.page);
  state.roleRefs = opts.refs;
  state.roleRefsFrameSelector = opts.frameSelector;
  state.roleRefsMode = opts.mode;
  if (!opts.targetId?.trim()) {
    return;
  }
  rememberRoleRefsForTarget({
    cdpUrl: opts.cdpUrl,
    targetId: opts.targetId,
    refs: opts.refs,
    frameSelector: opts.frameSelector,
    mode: opts.mode,
  });
}

export function restoreRoleRefsForTarget(opts: {
  cdpUrl: string;
  targetId?: string;
  page: Page;
}): void {
  const targetId = opts.targetId?.trim() || "";
  if (!targetId) {
    return;
  }
  const cached = roleRefsByTarget.get(roleRefsKey(opts.cdpUrl, targetId));
  if (!cached) {
    return;
  }
  const state = ensurePageState(opts.page);
  if (state.roleRefs) {
    return;
  }
  state.roleRefs = cached.refs;
  state.roleRefsFrameSelector = cached.frameSelector;
  state.roleRefsMode = cached.mode;
}

export function ensurePageState(page: Page): PageState {
  const existing = pageStates.get(page);
  if (existing) {
    return existing;
  }

  const state: PageState = {
    console: [],
    errors: [],
    requests: [],
    requestIds: new WeakMap(),
    nextRequestId: 0,
    armIdUpload: 0,
    armIdDialog: 0,
    armIdDownload: 0,
  };
  pageStates.set(page, state);

  if (!observedPages.has(page)) {
    observedPages.add(page);
    page.on("console", (msg: ConsoleMessage) => {
      const entry: BrowserConsoleMessage = {
        type: msg.type(),
        text: msg.text(),
        timestamp: new Date().toISOString(),
        location: msg.location(),
      };
      state.console.push(entry);
      if (state.console.length > MAX_CONSOLE_MESSAGES) {
        state.console.shift();
      }
    });
    page.on("pageerror", (err: Error) => {
      state.errors.push({
        message: err?.message ? String(err.message) : String(err),
        name: err?.name ? String(err.name) : undefined,
        stack: err?.stack ? String(err.stack) : undefined,
        timestamp: new Date().toISOString(),
      });
      if (state.errors.length > MAX_PAGE_ERRORS) {
        state.errors.shift();
      }
    });
    page.on("request", (req: Request) => {
      state.nextRequestId += 1;
      const id = `r${state.nextRequestId}`;
      state.requestIds.set(req, id);
      state.requests.push({
        id,
        timestamp: new Date().toISOString(),
        method: req.method(),
        url: req.url(),
        resourceType: req.resourceType(),
      });
      if (state.requests.length > MAX_NETWORK_REQUESTS) {
        state.requests.shift();
      }
    });
    page.on("response", (resp: Response) => {
      const req = resp.request();
      const id = state.requestIds.get(req);
      if (!id) {
        return;
      }
      let rec: BrowserNetworkRequest | undefined;
      for (let i = state.requests.length - 1; i >= 0; i -= 1) {
        const candidate = state.requests[i];
        if (candidate && candidate.id === id) {
          rec = candidate;
          break;
        }
      }
      if (!rec) {
        return;
      }
      rec.status = resp.status();
      rec.ok = resp.ok();
    });
    page.on("requestfailed", (req: Request) => {
      const id = state.requestIds.get(req);
      if (!id) {
        return;
      }
      let rec: BrowserNetworkRequest | undefined;
      for (let i = state.requests.length - 1; i >= 0; i -= 1) {
        const candidate = state.requests[i];
        if (candidate && candidate.id === id) {
          rec = candidate;
          break;
        }
      }
      if (!rec) {
        return;
      }
      rec.failureText = req.failure()?.errorText;
      rec.ok = false;
    });
    page.on("close", () => {
      pageStates.delete(page);
      observedPages.delete(page);
    });
  }

  return state;
}


// ── Stealth init script ──
// Injected into every browser context to hide automation markers.
const STEALTH_INIT_SCRIPT = `
  // 1. Remove navigator.webdriver
  Object.defineProperty(navigator, "webdriver", { get: () => undefined });

  // 2. Override navigator.plugins to look like a real browser
  Object.defineProperty(navigator, "plugins", {
    get: () => {
      const p = [
        { name: "Chrome PDF Plugin", filename: "internal-pdf-viewer", description: "Portable Document Format" },
        { name: "Chrome PDF Viewer", filename: "mhjfbmdgcfjbbpaeojofohoefgiehjai", description: "" },
        { name: "Native Client", filename: "internal-nacl-plugin", description: "" },
      ];
      p.refresh = () => {};
      return p;
    },
  });

  // 3. Override navigator.languages
  Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });

  // 4. Fix chrome.runtime to look normal (not automated)
  if (!window.chrome) { window.chrome = {}; }
  if (!window.chrome.runtime) {
    window.chrome.runtime = {
      connect: () => {},
      sendMessage: () => {},
      onMessage: { addListener: () => {}, removeListener: () => {}, hasListener: () => false },
    };
  }

  // 5. Spoof permissions query for notifications
  if (navigator.permissions) {
    const originalQuery = navigator.permissions.query;
    navigator.permissions.query = (parameters) => (
      parameters.name === "notifications"
        ? Promise.resolve({ state: Notification.permission })
        : originalQuery.call(navigator.permissions, parameters)
    );
  }

  // 6. Remove Playwright/CDP-specific properties
  delete window.__playwright;
  delete window.__pw_manual;
`;


// ── Per-page CDP setup ──
// Applies stealth patches and proxy auth to each individual page.
// Called for both existing pages and newly created pages.
async function setupPageCdp(page: Page): Promise<void> {
  try {
    const cdpSession = await page.context().newCDPSession(page);

    // ── CDP stealth: remove cdc_ properties ──
    await cdpSession.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `
        const findAndDeleteCdc = () => {
          for (const key of Object.keys(document)) {
            if (key.match(/^cdc_|^\$cdc_/)) {
              delete document[key];
            }
          }
        };
        findAndDeleteCdc();
        const observer = new MutationObserver(findAndDeleteCdc);
        observer.observe(document, { attributes: true, childList: true, subtree: true });
      `,
    });

    // ── CDP stealth: realistic user-agent ──
    await cdpSession.send("Network.setUserAgentOverride", {
      userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36",
      acceptLanguage: "en-US,en;q=0.9",
      platform: "Linux",
    });

    // ── Proxy authentication via Fetch domain ──
    try {
      const _cfg = loadConfig();
      const _resolved = resolveBrowserConfig(_cfg.browser, _cfg);
      if (_resolved.proxy?.username) {
        await cdpSession.send("Fetch.enable", {
          handleAuthRequests: true,
          patterns: [{ requestStage: "Request" }, { requestStage: "Response" }],
        });
        cdpSession.on("Fetch.authRequired", async (event: Record<string, unknown>) => {
          try {
            await cdpSession.send("Fetch.continueWithAuth", {
              requestId: event.requestId,
              authChallengeResponse: {
                response: "ProvideCredentials",
                username: _resolved.proxy!.username,
                password: _resolved.proxy!.password || "",
              },
            });
          } catch {
            // Ignore auth failures
          }
        });
        cdpSession.on("Fetch.requestPaused", async (event: Record<string, unknown>) => {
          try {
            await cdpSession.send("Fetch.continueRequest", {
              requestId: event.requestId,
            });
          } catch {
            // Ignore
          }
        });
        // Don't detach - CDP session must stay alive for proxy auth events
      } else {
        await cdpSession.detach().catch(() => {});
      }
    } catch {
      // If config read fails, just detach the session
      await cdpSession.detach().catch(() => {});
    }
  } catch {
    // Non-critical: page may already be closed
  }
}

function observeContext(context: BrowserContext) {
  if (observedContexts.has(context)) {
    return;
  }
  observedContexts.add(context);
  ensureContextState(context);

  // Inject stealth scripts to hide automation markers from bot detectors.
  context.addInitScript(STEALTH_INIT_SCRIPT).catch(() => {});

  for (const page of context.pages()) {
    ensurePageState(page);
    setupPageCdp(page).catch(() => {});
  }
  context.on("page", (page) => {
    ensurePageState(page);
    setupPageCdp(page).catch(() => {});
  });
}

export function ensureContextState(context: BrowserContext): ContextState {
  const existing = contextStates.get(context);
  if (existing) {
    return existing;
  }
  const state: ContextState = { traceActive: false };
  contextStates.set(context, state);
  return state;
}

function observeBrowser(browser: Browser) {
  for (const context of browser.contexts()) {
    observeContext(context);
  }
}



// ── Proxy authentication via CDP ──
// When a proxy requires authentication, Chrome triggers Fetch.authRequired.
// We intercept it and provide credentials from the browser config.
async function setupProxyAuth(browser: Browser, proxy: { url: string; username?: string; password?: string }): Promise<void> {
  if (!proxy.username) return;
  try {
    for (const context of browser.contexts()) {
      for (const page of context.pages()) {
        try {
          const cdpSession = await page.context().newCDPSession(page);
          await cdpSession.send("Fetch.enable", {
            handleAuthRequests: true,
            patterns: [{ requestStage: "Request" }, { requestStage: "Response" }],
          });
          cdpSession.on("Fetch.authRequired", async (event: Record<string, unknown>) => {
            try {
              await cdpSession.send("Fetch.continueWithAuth", {
                requestId: event.requestId,
                authChallengeResponse: {
                  response: "ProvideCredentials",
                  username: proxy.username,
                  password: proxy.password || "",
                },
              });
            } catch {
              // Ignore auth failures
            }
          });
          cdpSession.on("Fetch.requestPaused", async (event: Record<string, unknown>) => {
            try {
              await cdpSession.send("Fetch.continueRequest", {
                requestId: event.requestId,
              });
            } catch {
              // Ignore
            }
          });
          // Don't detach - we need the session to stay alive for auth events
        } catch {
          // Ignore per-page errors
        }
      }
    }
  } catch {
    // Non-critical
  }
}

// ── CDP-level stealth ──
// Uses Chrome DevTools Protocol directly to patch automation artifacts
// that cannot be hidden via JavaScript alone.
async function applyCdpStealth(browser: Browser): Promise<void> {
  try {
    for (const context of browser.contexts()) {
      for (const page of context.pages()) {
        try {
          const cdpSession = await page.context().newCDPSession(page);
          // Remove the "cdc_" driver property from the DOM
          await cdpSession.send("Page.addScriptToEvaluateOnNewDocument", {
            source: `
              // Remove cdc_ properties that Chrome DevTools Protocol adds
              const findAndDeleteCdc = () => {
                for (const key of Object.keys(document)) {
                  if (key.match(/^cdc_|^\$cdc_/)) {
                    delete document[key];
                  }
                }
              };
              findAndDeleteCdc();
              // Also run on mutations in case it gets re-added
              const observer = new MutationObserver(findAndDeleteCdc);
              observer.observe(document, { attributes: true, childList: true, subtree: true });
            `,
          });
          // Set a realistic user-agent (strip "HeadlessChrome" if present)
          await cdpSession.send("Network.setUserAgentOverride", {
            userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36",
            acceptLanguage: "en-US,en;q=0.9",
            platform: "Linux",
          });
          await cdpSession.detach().catch(() => {});
        } catch {
          // Ignore per-page errors (e.g. page already closed)
        }
      }
    }
  } catch {
    // Non-critical: stealth is best-effort
  }
}

async function connectBrowser(cdpUrl: string): Promise<ConnectedBrowser> {
  const normalized = normalizeCdpUrl(cdpUrl);
  if (cached?.cdpUrl === normalized) {
    return cached;
  }
  if (connecting) {
    return await connecting;
  }

  const connectWithRetry = async (): Promise<ConnectedBrowser> => {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const timeout = 5000 + attempt * 2000;
        const wsUrl = await getChromeWebSocketUrl(normalized, timeout).catch(() => null);
        const endpoint = wsUrl ?? normalized;
        const headers = getHeadersWithAuth(endpoint);
        const browser = await chromium.connectOverCDP(endpoint, { timeout, headers });
        const connected: ConnectedBrowser = { browser, cdpUrl: normalized };
        cached = connected;
        observeBrowser(browser);
        // Apply CDP-level stealth patches (user-agent, cdc_ removal).
        await applyCdpStealth(browser);
        // Set up proxy authentication if configured.
        try {
          const _cfg = loadConfig();
          const _resolved = resolveBrowserConfig(_cfg.browser, _cfg);
          if (_resolved.proxy?.username) {
            await setupProxyAuth(browser, _resolved.proxy);
          }
        } catch {
          // Non-critical: proxy auth setup is best-effort
        }
        browser.on("disconnected", () => {
          if (cached?.browser === browser) {
            cached = null;
          }
        });
        return connected;
      } catch (err) {
        lastErr = err;
        const delay = 250 + attempt * 250;
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    if (lastErr instanceof Error) {
      throw lastErr;
    }
    const message = lastErr ? formatErrorMessage(lastErr) : "CDP connect failed";
    throw new Error(message);
  };

  connecting = connectWithRetry().finally(() => {
    connecting = null;
  });

  return await connecting;
}

async function getAllPages(browser: Browser): Promise<Page[]> {
  const contexts = browser.contexts();
  const pages = contexts.flatMap((c) => c.pages());
  return pages;
}

async function pageTargetId(page: Page): Promise<string | null> {
  const session = await page.context().newCDPSession(page);
  try {
    const info = (await session.send("Target.getTargetInfo")) as TargetInfoResponse;
    const targetId = String(info?.targetInfo?.targetId ?? "").trim();
    return targetId || null;
  } finally {
    await session.detach().catch(() => {});
  }
}

async function findPageByTargetId(
  browser: Browser,
  targetId: string,
  cdpUrl?: string,
): Promise<Page | null> {
  const pages = await getAllPages(browser);
  // First, try the standard CDP session approach
  for (const page of pages) {
    const tid = await pageTargetId(page).catch(() => null);
    if (tid && tid === targetId) {
      return page;
    }
  }
  // If CDP sessions fail (e.g., extension relay blocks Target.attachToBrowserTarget),
  // fall back to URL-based matching using the /json/list endpoint
  if (cdpUrl) {
    try {
      const baseUrl = cdpUrl
        .replace(/\/+$/, "")
        .replace(/^ws:/, "http:")
        .replace(/\/cdp$/, "");
      const listUrl = `${baseUrl}/json/list`;
      const response = await fetch(listUrl, { headers: getHeadersWithAuth(listUrl) });
      if (response.ok) {
        const targets = (await response.json()) as Array<{
          id: string;
          url: string;
          title?: string;
        }>;
        const target = targets.find((t) => t.id === targetId);
        if (target) {
          // Try to find a page with matching URL
          const urlMatch = pages.filter((p) => p.url() === target.url);
          if (urlMatch.length === 1) {
            return urlMatch[0];
          }
          // If multiple URL matches, use index-based matching as fallback
          // This works when Playwright and the relay enumerate tabs in the same order
          if (urlMatch.length > 1) {
            const sameUrlTargets = targets.filter((t) => t.url === target.url);
            if (sameUrlTargets.length === urlMatch.length) {
              const idx = sameUrlTargets.findIndex((t) => t.id === targetId);
              if (idx >= 0 && idx < urlMatch.length) {
                return urlMatch[idx];
              }
            }
          }
        }
      }
    } catch {
      // Ignore fetch errors and fall through to return null
    }
  }
  return null;
}

export async function getPageForTargetId(opts: {
  cdpUrl: string;
  targetId?: string;
}): Promise<Page> {
  const { browser } = await connectBrowser(opts.cdpUrl);
  const pages = await getAllPages(browser);
  if (!pages.length) {
    throw new Error("No pages available in the connected browser.");
  }
  const first = pages[0];
  if (!opts.targetId) {
    return first;
  }
  const found = await findPageByTargetId(browser, opts.targetId, opts.cdpUrl);
  if (!found) {
    // Extension relays can block CDP attachment APIs (e.g. Target.attachToBrowserTarget),
    // which prevents us from resolving a page's targetId via newCDPSession(). If Playwright
    // only exposes a single Page, use it as a best-effort fallback.
    if (pages.length === 1) {
      return first;
    }
    throw new Error("tab not found");
  }
  return found;
}

export function refLocator(page: Page, ref: string) {
  const normalized = ref.startsWith("@")
    ? ref.slice(1)
    : ref.startsWith("ref=")
      ? ref.slice(4)
      : ref;

  if (/^e\d+$/.test(normalized)) {
    const state = pageStates.get(page);
    if (state?.roleRefsMode === "aria") {
      const scope = state.roleRefsFrameSelector
        ? page.frameLocator(state.roleRefsFrameSelector)
        : page;
      return scope.locator(`aria-ref=${normalized}`);
    }
    const info = state?.roleRefs?.[normalized];
    if (!info) {
      throw new Error(
        `Unknown ref "${normalized}". Run a new snapshot and use a ref from that snapshot.`,
      );
    }
    const scope = state?.roleRefsFrameSelector
      ? page.frameLocator(state.roleRefsFrameSelector)
      : page;
    const locAny = scope as unknown as {
      getByRole: (
        role: never,
        opts?: { name?: string; exact?: boolean },
      ) => ReturnType<Page["getByRole"]>;
    };
    const locator = info.name
      ? locAny.getByRole(info.role as never, { name: info.name, exact: true })
      : locAny.getByRole(info.role as never);
    return info.nth !== undefined ? locator.nth(info.nth) : locator;
  }

  return page.locator(`aria-ref=${normalized}`);
}

export async function closePlaywrightBrowserConnection(): Promise<void> {
  const cur = cached;
  cached = null;
  if (!cur) {
    return;
  }
  await cur.browser.close().catch(() => {});
}

/**
 * List all pages/tabs from the persistent Playwright connection.
 * Used for remote profiles where HTTP-based /json/list is ephemeral.
 */
export async function listPagesViaPlaywright(opts: { cdpUrl: string }): Promise<
  Array<{
    targetId: string;
    title: string;
    url: string;
    type: string;
  }>
> {
  const { browser } = await connectBrowser(opts.cdpUrl);
  const pages = await getAllPages(browser);
  const results: Array<{
    targetId: string;
    title: string;
    url: string;
    type: string;
  }> = [];

  for (const page of pages) {
    const tid = await pageTargetId(page).catch(() => null);
    if (tid) {
      results.push({
        targetId: tid,
        title: await page.title().catch(() => ""),
        url: page.url(),
        type: "page",
      });
    }
  }
  return results;
}

/**
 * Create a new page/tab using the persistent Playwright connection.
 * Used for remote profiles where HTTP-based /json/new is ephemeral.
 * Returns the new page's targetId and metadata.
 */
export async function createPageViaPlaywright(opts: { cdpUrl: string; url: string }): Promise<{
  targetId: string;
  title: string;
  url: string;
  type: string;
}> {
  const { browser } = await connectBrowser(opts.cdpUrl);
  const context = browser.contexts()[0] ?? (await browser.newContext());
  ensureContextState(context);

  const page = await context.newPage();
  ensurePageState(page);

  // Navigate to the URL
  const targetUrl = opts.url.trim() || "about:blank";
  if (targetUrl !== "about:blank") {
    await page.goto(targetUrl, { timeout: 30_000 }).catch(() => {
      // Navigation might fail for some URLs, but page is still created
    });
  }

  // Get the targetId for this page
  const tid = await pageTargetId(page).catch(() => null);
  if (!tid) {
    throw new Error("Failed to get targetId for new page");
  }

  return {
    targetId: tid,
    title: await page.title().catch(() => ""),
    url: page.url(),
    type: "page",
  };
}

/**
 * Close a page/tab by targetId using the persistent Playwright connection.
 * Used for remote profiles where HTTP-based /json/close is ephemeral.
 */
export async function closePageByTargetIdViaPlaywright(opts: {
  cdpUrl: string;
  targetId: string;
}): Promise<void> {
  const { browser } = await connectBrowser(opts.cdpUrl);
  const page = await findPageByTargetId(browser, opts.targetId, opts.cdpUrl);
  if (!page) {
    throw new Error("tab not found");
  }
  await page.close();
}

/**
 * Focus a page/tab by targetId using the persistent Playwright connection.
 * Used for remote profiles where HTTP-based /json/activate can be ephemeral.
 */
export async function focusPageByTargetIdViaPlaywright(opts: {
  cdpUrl: string;
  targetId: string;
}): Promise<void> {
  const { browser } = await connectBrowser(opts.cdpUrl);
  const page = await findPageByTargetId(browser, opts.targetId, opts.cdpUrl);
  if (!page) {
    throw new Error("tab not found");
  }
  try {
    await page.bringToFront();
  } catch (err) {
    const session = await page.context().newCDPSession(page);
    try {
      await session.send("Page.bringToFront");
      return;
    } catch {
      throw err;
    } finally {
      await session.detach().catch(() => {});
    }
  }
}
