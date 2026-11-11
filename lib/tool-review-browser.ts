import { randomUUID } from "node:crypto";
import type { Page } from "playwright-core";
import { callDesktopAgentBrowser, hasDesktopAgentBridge } from "./desktop-browser-agent";
import { readAgentBrowserMode } from "./browser-mode";
import { selectBrowserBackend } from "./browser-backend";

const pageIdentities = new WeakMap<Page, { id: string; navigation: number }>();
function pageIdentity(page: Page) {
  let identity = pageIdentities.get(page);
  if (!identity) {
    identity = { id: randomUUID(), navigation: 0 };
    pageIdentities.set(page, identity);
    const observed = identity;
    page.on("framenavigated", frame => { if (frame === page.mainFrame()) observed.navigation++; });
  }
  return { ...identity, url: page.url() };
}

/** Read-only page identity. Never creates a page, launches a browser or navigates. */
export async function readBrowserReviewTarget(sessionId: string, input: unknown, signal: AbortSignal): Promise<unknown> {
  const args = input && typeof input === "object" ? input as { tabId?: string; action?: string } : {};
  if (args.action === "open" || args.action === "new_tab") return undefined;
  if (hasDesktopAgentBridge() && selectBrowserBackend({ desktopIpc: true, mode: readAgentBrowserMode() }) === "desktop") {
    try {
      const value = await callDesktopAgentBrowser({ sessionId, action: "evaluate_check", tabId: args.tabId, signal: AbortSignal.any([signal, AbortSignal.timeout(3000)]) });
      const target = value as { navigationToken?: string; url?: string; allowed?: boolean };
      return target?.navigationToken ? { navigationToken: target.navigationToken, url: target.url, allowed: target.allowed } : undefined;
    } catch { return undefined; }
  }
  const runtime = (globalThis as unknown as { __pioraBrowserRuntime?: { revision: number; sessions: Map<string, { page: Page; pages: Page[] }> } }).__pioraBrowserRuntime;
  const session = runtime?.sessions.get(sessionId);
  return session ? { revision: runtime!.revision, active: pageIdentity(session.page), pages: session.pages.map(pageIdentity) } : undefined;
}
