// Adapted from Alentaoker/dsh-harmoneydev-tools @ 8b178a755d33cee9899160a7be283af2b23eb85d.
// SPDX-License-Identifier: Apache-2.0; see third_party/harmony-log-workbench/SOURCE.md.
export function redactLog(text, secrets = []) {
  let value = String(text ?? '').slice(0, 8192);
  for (const secret of secrets.filter(s => typeof s === 'string' && s.length > 3)) value = value.replaceAll(secret, '[redacted]');
  return value.replace(/\bBearer\s+[^\s,;"']+/gi, 'Bearer [redacted]')
    .replace(/((?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|passwd|cookie)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1[redacted]');
}
