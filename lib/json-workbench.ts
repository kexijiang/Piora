import JSONBig from "json-bigint";

export type JsonWorkbenchAction =
  | "format"
  | "get"
  | "url"
  | "base64"
  | "serialize"
  | "timestamp"
  | "unicode"
  | "utf8"
  | "unescape"
  | "multi-unescape"
  | "minify"
  | "form-data"
  | "escape"
  | "minify-escape";

export interface JsonWorkbenchOptions {
  extractJson?: boolean;
  indent?: 2 | 4;
  multiEscape?: boolean;
  removeNbsp?: boolean;
}

export interface JsonWorkbenchResult {
  changed: boolean;
  kind: "json" | "query" | "serialize" | "timestamp" | "text";
  output: string;
}

export interface JsonSyntaxIssue {
  column: number;
  line: number;
  offset: number;
  reason: string;
}

const jsonBig = JSONBig({
  constructorAction: "error",
  protoAction: "error",
  useNativeBigInt: true,
});

export class JsonWorkbenchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JsonWorkbenchError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isStructured(value: unknown): value is unknown[] | Record<string, unknown> {
  return Array.isArray(value) || isRecord(value);
}

export function parseJsonValue(input: string): unknown {
  try {
    return jsonBig.parse(input);
  } catch (cause) {
    throw new JsonWorkbenchError(cause instanceof Error ? cause.message : String(cause));
  }
}

export function stringifyJsonValue(value: unknown, indent: 2 | 4 = 4): string {
  try {
    return jsonBig.stringify(value, null, indent);
  } catch (cause) {
    throw new JsonWorkbenchError(cause instanceof Error ? cause.message : String(cause));
  }
}

function tryParseJson(input: string): { parsed: boolean; value: unknown } {
  try {
    return { parsed: true, value: jsonBig.parse(input) };
  } catch {
    return { parsed: false, value: input };
  }
}

function jsonCandidate(input: string, options: JsonWorkbenchOptions): { offset: number; text: string } {
  const normalized = options.removeNbsp === false ? input : input.replace(/\u00a0/g, " ");
  if (options.extractJson === false) return { offset: 0, text: normalized };
  const match = /{[\s\S]*}|\[[\s\S]*]/.exec(normalized);
  return match ? { offset: match.index, text: match[0] } : { offset: 0, text: normalized };
}

function lineAndColumnAt(input: string, offset: number): { column: number; line: number } {
  const safeOffset = Math.max(0, Math.min(offset, input.length));
  const before = input.slice(0, safeOffset);
  const line = (before.match(/\n/g)?.length ?? 0) + 1;
  const lastLineBreak = before.lastIndexOf("\n");
  return { column: safeOffset - lastLineBreak, line };
}

/** Returns a source-mapped location for invalid standard JSON. */
export function findJsonSyntaxIssue(input: string, options: JsonWorkbenchOptions = {}): JsonSyntaxIssue | null {
  const candidate = jsonCandidate(input, options);
  try {
    jsonBig.parse(candidate.text);
    return null;
  } catch (cause) {
    const parserOffset = typeof (cause as { at?: unknown })?.at === "number"
      ? Math.max(0, Math.min(candidate.text.length, Math.round((cause as { at: number }).at) - 1))
      : 0;
    const offset = candidate.offset + parserOffset;
    const location = lineAndColumnAt(input, offset);
    return {
      ...location,
      offset,
      reason: cause instanceof Error ? cause.message : String(cause),
    };
  }
}

/** Matches json转's "复制压缩": whitespace outside strings is removed. */
export function minifyJsonText(input: string): string {
  let quote: false | "\"" | "'" = false;
  let result = "";
  const source = input.replace(/\r?\n/g, " ");
  for (let index = 0; index < source.length; index += 1) {
    let character = source[index];
    if (quote) {
      if (character === quote) {
        let slashCount = 0;
        for (let cursor = index - 1; cursor >= 0 && source[cursor] === "\\"; cursor -= 1) slashCount += 1;
        if (slashCount % 2 === 0) quote = false;
      }
    } else if (character === "\"" || character === "'") {
      quote = character;
    } else if (character === " " || character === "\t" || character === "\u00a0") {
      character = "";
    }
    result += character;
  }
  return result;
}

export function escapeJsonText(input: string): string {
  return input.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export function unescapeJsonText(input: string): string {
  return input.replace(/\\\\/g, "\\").replace(/\\"/g, '"');
}

export function decodeUnicodeText(input: string): string {
  let result = input.replace(/\\u([\dA-Fa-f]{4})/g, (_match, code: string) =>
    String.fromCharCode(Number.parseInt(code, 16)));
  result = result.replace(/(?:\\x[\dA-Fa-f]{2})+/g, (match) => {
    const bytes = match.match(/[\dA-Fa-f]{2}/g)?.map((part) => Number.parseInt(part, 16)) ?? [];
    try {
      return new TextDecoder().decode(new Uint8Array(bytes));
    } catch {
      return match;
    }
  });
  return result;
}

export function decodeUtf8Text(input: string): string {
  try {
    const bytes = Uint8Array.from(input, (character) => character.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (cause) {
    throw new JsonWorkbenchError(cause instanceof Error ? cause.message : "UTF-8 解码失败");
  }
}

export function parseGetParameters(input: string): Record<string, string> {
  const result = Object.create(null) as Record<string, string>;
  const query = input.replace(/^[^?]*\?/, "");
  let cursor = 0;
  while (cursor < query.length) {
    const equals = query.indexOf("=", cursor);
    if (equals === -1) break;
    const ampersand = query.indexOf("&", equals);
    const end = ampersand === -1 ? query.length : ampersand;
    try {
      const key = decodeURIComponent(query.slice(cursor, equals));
      const value = decodeURIComponent(query.slice(equals + 1, end)).replace(/\+/g, " ");
      if (key !== "__proto__" && key !== "prototype" && key !== "constructor") result[key] = value;
    } catch (cause) {
      throw new JsonWorkbenchError(cause instanceof Error ? cause.message : "URL 参数解码失败");
    }
    cursor = end + 1;
  }
  if (Object.keys(result).length === 0) throw new JsonWorkbenchError("没有识别到 URL 参数");
  return result;
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

/** Parses the scalar/array subset supported by PHP serialize and the original plugin. */
export function parsePhpSerialized(input: string): unknown {
  const source = input.trim();

  const parseAt = (start: number): { next: number; value: unknown } => {
    const type = source[start]?.toLowerCase();
    if (!type) throw new JsonWorkbenchError("serialize 数据不完整");
    if (type === "n") {
      if (source[start + 1] !== ";") throw new JsonWorkbenchError("无效的 null serialize 数据");
      return { next: start + 2, value: null };
    }
    if (source[start + 1] !== ":") throw new JsonWorkbenchError("无效的 serialize 数据");

    const readUntil = (from: number, marker: string) => {
      const end = source.indexOf(marker, from);
      if (end === -1) throw new JsonWorkbenchError("serialize 数据缺少结束标记");
      return { end, text: source.slice(from, end) };
    };

    if (type === "i" || type === "b" || type === "d") {
      const token = readUntil(start + 2, ";");
      const number = Number(token.text);
      if (!Number.isFinite(number)) throw new JsonWorkbenchError("serialize 数值无效");
      return {
        next: token.end + 1,
        value: type === "b" ? number !== 0 : type === "i" ? Number.parseInt(token.text, 10) : number,
      };
    }

    if (type === "s") {
      const lengthToken = readUntil(start + 2, ":");
      const byteLength = Number.parseInt(lengthToken.text, 10);
      const quoteStart = lengthToken.end + 1;
      if (!Number.isFinite(byteLength) || source[quoteStart] !== '"') throw new JsonWorkbenchError("serialize 字符串无效");
      let cursor = quoteStart + 1;
      let value = "";
      while (cursor < source.length && utf8ByteLength(value) < byteLength) {
        const codePoint = source.codePointAt(cursor);
        if (codePoint === undefined) break;
        const character = String.fromCodePoint(codePoint);
        value += character;
        cursor += character.length;
      }
      if (utf8ByteLength(value) !== byteLength || source.slice(cursor, cursor + 2) !== '";') {
        throw new JsonWorkbenchError("serialize 字符串长度不匹配");
      }
      return { next: cursor + 2, value };
    }

    if (type === "a") {
      const countToken = readUntil(start + 2, ":");
      const count = Number.parseInt(countToken.text, 10);
      let cursor = countToken.end + 1;
      if (!Number.isFinite(count) || source[cursor] !== "{") throw new JsonWorkbenchError("serialize 数组无效");
      cursor += 1;
      const entries: Array<[unknown, unknown]> = [];
      for (let index = 0; index < count; index += 1) {
        const key = parseAt(cursor);
        const value = parseAt(key.next);
        entries.push([key.value, value.value]);
        cursor = value.next;
      }
      if (source[cursor] !== "}") throw new JsonWorkbenchError("serialize 数组缺少结束大括号");
      const isArray = entries.every(([key], index) => key === index);
      if (isArray) return { next: cursor + 1, value: entries.map(([, value]) => value) };
      const value = Object.create(null) as Record<string, unknown>;
      for (const [key, entry] of entries) {
        const safeKey = String(key);
        if (safeKey !== "__proto__" && safeKey !== "prototype" && safeKey !== "constructor") value[safeKey] = entry;
      }
      return { next: cursor + 1, value };
    }

    throw new JsonWorkbenchError(`不支持的 serialize 类型：${type}`);
  };

  try {
    const parsed = parseAt(0);
    if (parsed.next !== source.length) throw new JsonWorkbenchError("serialize 数据末尾存在多余内容");
    return parsed.value;
  } catch (firstCause) {
    const unescaped = unescapeJsonText(source);
    if (unescaped !== source) {
      try {
        return parsePhpSerialized(unescaped);
      } catch {
        // Report the first failure, matching the plugin's direct-then-unescape order.
      }
    }
    throw firstCause;
  }
}

function decodeEscapedValue(value: unknown, recursive: boolean, depth = 0): unknown {
  if (depth > 24) return value;
  if (typeof value === "string") {
    if (!Number.isNaN(Number(value)) || value === "false" || value === "true" || value === "null") return value;
    let parsed = tryParseJson(value);
    if (!parsed.parsed) parsed = tryParseJson(unescapeJsonText(value));
    return parsed.parsed && recursive ? decodeEscapedValue(parsed.value, true, depth + 1) : parsed.value;
  }
  if (Array.isArray(value) && recursive) return value.map((entry) => decodeEscapedValue(entry, true, depth + 1));
  if (isRecord(value) && recursive) {
    const result = Object.create(null) as Record<string, unknown>;
    for (const [key, entry] of Object.entries(value)) result[key] = decodeEscapedValue(entry, true, depth + 1);
    return result;
  }
  return value;
}

export function smartFormatJson(input: string, options: JsonWorkbenchOptions = {}): JsonWorkbenchResult {
  const indent = options.indent ?? 4;
  const multiEscape = options.multiEscape ?? true;
  const candidate = jsonCandidate(input, options).text;

  for (const source of [candidate, decodeUnicodeText(candidate)]) {
    const parsed = tryParseJson(source);
    const value = decodeEscapedValue(source, multiEscape);
    if (parsed.parsed || isStructured(value)) {
      const output = stringifyJsonValue(value, indent);
      return { changed: output !== input, kind: "json", output };
    }
  }
  return { changed: false, kind: "text", output: input };
}

function decodeBase64(input: string): string {
  const decode = (value: string) => {
    try {
      return atob(value);
    } catch (cause) {
      throw new JsonWorkbenchError(cause instanceof Error ? cause.message : "Base64 解码失败");
    }
  };
  try {
    return decode(input);
  } catch (firstCause) {
    if (input.includes("%")) {
      try {
        return decode(decodeURIComponent(input));
      } catch {
        // Report the original error, matching the plugin's fallback order.
      }
    }
    throw firstCause;
  }
}

function transformDecodedText(input: string, options: JsonWorkbenchOptions): string {
  const formatted = smartFormatJson(input, options);
  return formatted.changed ? formatted.output : input;
}

export function transformTimestamp(input: string): string {
  const value = input.trim();
  if (/^\d{10}$/.test(value) || /^\d{13}$/.test(value)) {
    const milliseconds = value.length === 10 ? Number(value) * 1_000 : Number(value);
    const date = new Date(milliseconds);
    if (Number.isNaN(date.getTime())) throw new JsonWorkbenchError("时间戳无效");
    const part = (number: number, length = 2) => String(number).padStart(length, "0");
    const base = `${date.getFullYear()}-${part(date.getMonth() + 1)}-${part(date.getDate())} ${part(date.getHours())}:${part(date.getMinutes())}:${part(date.getSeconds())}`;
    return value.length === 13 ? `${base}.${part(date.getMilliseconds(), 3)}` : base;
  }
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) throw new JsonWorkbenchError("没有识别到时间戳或日期");
  return String(timestamp).slice(0, value.length === 23 ? 13 : 10);
}

function flattenFormData(value: unknown, prefix = "", lines: string[] = []): string[] {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => flattenFormData(entry, prefix ? `${prefix}[${index}]` : String(index), lines));
    return lines;
  }
  if (isRecord(value)) {
    for (const [key, entry] of Object.entries(value)) flattenFormData(entry, prefix ? `${prefix}[${key}]` : key, lines);
    return lines;
  }
  lines.push(`${prefix}:${value === null ? "null" : String(value)}`);
  return lines;
}

export function toFormDataText(input: string): string {
  const value = decodeEscapedValue(input, true);
  if (!isStructured(value)) throw new JsonWorkbenchError("form-data 需要 JSON 对象或数组");
  return `${flattenFormData(value).join("\n")}\n`;
}

export function runJsonWorkbenchAction(
  input: string,
  action: JsonWorkbenchAction,
  options: JsonWorkbenchOptions = {},
): JsonWorkbenchResult {
  if (!input) throw new JsonWorkbenchError("请先输入或选中内容");
  const indent = options.indent ?? 4;
  let output = input;
  let kind: JsonWorkbenchResult["kind"] = "text";

  switch (action) {
    case "format":
    case "multi-unescape":
      return smartFormatJson(input, { ...options, multiEscape: action === "multi-unescape" ? true : options.multiEscape });
    case "get":
      output = stringifyJsonValue(parseGetParameters(input), indent);
      kind = "query";
      break;
    case "url":
      try {
        output = transformDecodedText(decodeURIComponent(input), options);
      } catch (cause) {
        throw new JsonWorkbenchError(cause instanceof Error ? cause.message : "URL 解码失败");
      }
      break;
    case "base64":
      output = transformDecodedText(decodeBase64(input), options);
      break;
    case "serialize":
      output = stringifyJsonValue(parsePhpSerialized(input), indent);
      kind = "serialize";
      break;
    case "timestamp":
      output = transformTimestamp(input);
      kind = "timestamp";
      break;
    case "unicode":
      output = transformDecodedText(decodeUnicodeText(input), options);
      break;
    case "utf8":
      output = transformDecodedText(decodeUtf8Text(input), options);
      break;
    case "unescape":
      output = transformDecodedText(unescapeJsonText(input), { ...options, multiEscape: false });
      break;
    case "minify":
      output = minifyJsonText(input);
      break;
    case "form-data":
      output = toFormDataText(input);
      break;
    case "escape":
      output = escapeJsonText(input);
      break;
    case "minify-escape":
      output = escapeJsonText(minifyJsonText(input));
      break;
  }
  return { changed: output !== input, kind, output };
}
