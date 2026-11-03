// Runs only in a separate isolated world. Return a boolean, never field values.
export function credentialFillScript(url: string, username: string, password: string, probe = false): string {
  return `(() => {
    if (location.origin + location.pathname !== ${JSON.stringify(url)} || location.protocol !== 'https:' || window !== window.top) return false;
    const visible = e => !e.disabled && !e.readOnly && e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden';
    const passwords = [...document.querySelectorAll('input[type="password"]')].filter(visible);
    if (passwords.length !== 1) return false;
    const secret = passwords[0];
    const form = secret.form;
    if (!form || new URL(form.action || location.href).origin !== location.origin || form.method.toLowerCase() !== 'post') return false;
    const danger = /payment|checkout|billing|credit.card|security|settings|reset|change.password|one.time|verification|\\botp\\b|\\b2fa\\b|\\bmfa\\b|支付|付款|验证码|安全设置|修改密码|重置密码/i;
    if (danger.test(location.pathname + ' ' + form.innerText) || form.querySelector('[autocomplete="new-password"], [autocomplete="one-time-code"], [autocomplete^="cc-"]')) return false;
    const users = [...form.querySelectorAll('input')].filter(e => visible(e) && ['text','email'].includes(e.type));
    if (users.length !== 1) return false;
    if (${JSON.stringify(probe)}) return true;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(users[0], ${JSON.stringify(username)}); setter.call(secret, ${JSON.stringify(password)});
    for (const field of [users[0], secret]) { field.dispatchEvent(new Event('input', {bubbles:true})); field.dispatchEvent(new Event('change', {bubbles:true})); }
    return true;
  })()`;
}
