/** Fixed, read-only probe. Never returns input values, storage, cookies or page text. */
export const BROWSER_LOGIN_STATE_SCRIPT = String.raw`(() => {
  const visible = el => {
    if (!el || !el.isConnected || !el.getClientRects().length) return false;
    for (let node = el; node instanceof Element; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (node.hidden || node.getAttribute('aria-hidden') === 'true' || style.display === 'none' || style.visibility !== 'visible' || Number(style.opacity) === 0) return false;
    }
    return true;
  };
  const all = selector => [...document.querySelectorAll(selector)].filter(visible);
  const label = el => (el.getAttribute('aria-label') || el.innerText || '').trim();
  const loginWords = /log[ -]?in|sign[ -]?in|登录|登入|扫码登录|scan.*(?:sign|log).*in/i;
  const controls = all('input:not([type="hidden"]), button, [role="button"], a, form, [role="dialog"]');
  const password = all('input[type="password"], input[autocomplete="one-time-code"]').length > 0;
  const form = controls.some(el => (el.tagName === 'FORM' || el.getAttribute('role') === 'dialog') && loginWords.test(label(el)) && [...el.querySelectorAll('input, canvas, img, svg')].some(visible));
  const authRoute = /(?:^|\/)(?:login|signin|sign-in|auth|oauth|sso|verify|2fa)(?:\/|$)/i.test(location.pathname);
  const loginVisible = password || form || (authRoute && controls.some(el => loginWords.test(label(el))));
  const logout = controls.some(el => /^(?:log[ -]?out|sign[ -]?out|退出登录|退出登入|注销)(?:\s|$)/i.test(label(el)) || /(?:^|\/)(?:logout|signout|sign-out)(?:\/|$|\?)/i.test(el.getAttribute('href') || ''));
  const userMenu = all('[data-testid="user-menu"], [data-testid="user-avatar"], [data-testid="account-menu"], [aria-label="User menu" i], [aria-label="Account menu" i], [aria-label="用户菜单"], [aria-label="个人头像"]').length > 0;
  return { ready: document.readyState === 'complete', loginVisible, authenticated: logout || userMenu, url: location.href };
})()`;

export interface BrowserLoginState { ready: boolean; loginVisible: boolean; authenticated: boolean; url: string }

export function readBrowserLoginState(value: unknown): BrowserLoginState | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Partial<BrowserLoginState>;
  if (typeof row.ready !== "boolean" || typeof row.loginVisible !== "boolean" || typeof row.authenticated !== "boolean" || typeof row.url !== "string") return null;
  if (!/^https?:\/\//i.test(row.url)) return null;
  return row as BrowserLoginState;
}

/** Closing a login dialog or navigating away alone is never evidence of sign-in. */
export function browserLoginCompleted(before: BrowserLoginState | null, after: BrowserLoginState | null): boolean {
  return Boolean(before && !before.authenticated && after?.ready && !after.loginVisible && after.authenticated);
}
