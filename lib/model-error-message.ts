import type { Locale } from "./i18n/types";

const reasons: Array<[RegExp, string, string]> = [
  [/\b401\b|unauthori[sz]ed|invalid.*(?:api.?key|credential)|authentication failed/i, "身份验证失败，请检查 API Key 或重新登录。", "Authentication failed. Check the API key or sign in again."],
  [/\b402\b|insufficient.*(?:balance|credit)|payment required|quota.*exhausted/i, "账户余额或额度不足，请检查服务商账户。", "Insufficient balance or quota. Check your provider account."],
  [/\b403\b|forbidden|access denied/i, "没有访问权限，请检查账号权限和模型授权。", "Access denied. Check account permissions and model access."],
  [/\b429\b|rate.?limit|too many requests/i, "请求过于频繁或已达到额度上限，请稍后重试。", "Rate or quota limit reached. Try again later."],
  [/\b5\d\d\b|internal server error|bad gateway|service unavailable/i, "服务暂时异常，请稍后重试。", "The service is temporarily unavailable. Try again later."],
  [/timed?\s*out|timeout|aborted/i, "请求超时或已取消，请检查网络后重试。", "The request timed out or was cancelled. Check the connection and retry."],
  [/fetch failed|failed to fetch|network|ECONN|ENOTFOUND|certificate|SSL/i, "连接失败，请检查服务地址、网络、代理和证书。", "Connection failed. Check the service URL, network, proxy and certificate."],
  [/no api key|api.?key.*(?:required|missing|not found)/i, "尚未配置 API Key，请先填写凭据。", "No API key is configured. Add credentials first."],
  [/(?:base.?url|url).*(?:invalid|required)/i, "请输入有效的服务地址（Base URL）。", "Enter a valid service URL (Base URL)."],
  [/model.*(?:id).*(?:required|empty)|modelId is required/i, "请填写模型 ID。", "Enter a model ID."],
  [/provider(?:Name)? is required/i, "请填写服务商名称和配置。", "Enter the provider name and configuration."],
  [/model not found|unknown model|model.*does not exist/i, "未找到该模型，请检查模型 ID 和服务商配置。", "Model not found. Check the model ID and provider configuration."],
  [/duplicate|already exists/i, "此配置已存在，请使用不同的名称或 ID。", "This configuration already exists. Use a different name or ID."],
  [/not valid JSON|invalid JSON|unexpected token|JSON.*parse/i, "JSON 格式无效，请检查配置内容。", "Invalid JSON. Check the configuration."],
  [/no models found|empty catalog/i, "服务没有返回可用模型，请检查接口地址及权限。", "No models were returned. Check the endpoint and permissions."],
  [/EACCES|EPERM|permission denied/i, "无法保存文件，请检查存储目录权限。", "Cannot save the file. Check storage directory permissions."],
  [/ENOSPC|disk.*full/i, "存储空间不足，请释放空间后再保存。", "Storage is full. Free space before saving."],
];

export function modelErrorMessage(raw: string, locale: Locale): { summary: string; detail?: string } {
  const normalized = raw.replace(/^Error:\s*/i, "").trim();
  const reason = reasons.find(([pattern]) => pattern.test(normalized));
  if (reason) return { summary: reason[locale === "zh-CN" ? 1 : 2], detail: normalized };
  if (locale === "zh-CN" && /[\u3400-\u9fff]/.test(normalized)) return { summary: normalized };
  if (locale === "en" && !/[\u3400-\u9fff]/.test(normalized)) return { summary: normalized };
  return { summary: locale === "zh-CN" ? "操作未成功，请查看详细信息并检查配置。" : "The operation failed. Check the configuration and details.", detail: normalized };
}
