export type BrowserWaitPurpose = "login" | "confirmation";

/** Older callers only supplied a reason. Keep non-login handoffs explicit. */
export function browserWaitPurpose(reason: string, purpose?: unknown): BrowserWaitPurpose {
  if (purpose === "confirmation" || purpose === "login") return purpose;
  if (/payment|checkout|billing|purchase|支付|付款|购买|账号安全|account.security/i.test(reason)) return "confirmation";
  return /log[ -]?in|sign[ -]?in|authenticat|2fa|one.time|\botp\b|登录|登入|两步|双重认证/i.test(reason) ? "login" : "confirmation";
}
