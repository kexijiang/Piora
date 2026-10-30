import { UI_PLAN_LIMITS } from "./plan-types";
import { plan2JsonDepthLimit, type JsonPath } from "./plan2-expressions";

export interface UiPlanPrefix {
  status: "partial" | "complete" | "invalid";
  values: Record<string, unknown>;
  completeKeys: string[];
  characters: number;
  diagnostic?: string;
}
const incomplete = Symbol("incomplete");
const forbidden = new Set(["__proto__", "constructor", "prototype"]);

/** Strict JSON prefix scanning. Only closed root fields/array members escape. */
export function parseUiPlanPrefix(source: string): UiPlanPrefix {
  const values: Record<string, unknown> = {}, completeKeys: string[] = [];
  let position = 0, count = 0;
  const invalid = () => { throw new Error("Invalid or excessive JSON prefix"); };
  const whitespace = () => { while (/[\x20\t\r\n]/.test(source[position] ?? "!")) position++; };
  const need = () => { if (position === source.length) throw incomplete; };
  function string(): string {
    const start = position++;
    while (position < source.length) {
      const char = source[position++];
      if (char === '"') return JSON.parse(source.slice(start, position)) as string;
      if (char.charCodeAt(0) < 32) invalid();
      if (char === "\\") {
        need(); const escape = source[position++];
        if (escape === "u") {
          for (let i = 0; i < 4; i++) { need(); if (!/[0-9a-fA-F]/.test(source[position++])) invalid(); }
        } else if (!'"\\/bfnrt'.includes(escape)) invalid();
      }
    }
    throw incomplete;
  }
  function value(path: JsonPath, rootArray?: unknown[]): unknown {
    if (++count > UI_PLAN_LIMITS.jsonValues || path.length > plan2JsonDepthLimit(path)) invalid();
    whitespace(); need();
    const char = source[position];
    if (char === '"') return string();
    if (char === "{") return object(path);
    if (char === "[") {
      const array = rootArray ?? []; position++; whitespace(); need();
      if (source[position] === "]") { position++; return array; }
      for (;;) {
        array.push(value([...path, array.length])); whitespace(); need();
        if (source[position] === "]") { position++; return array; }
        if (source[position++] !== ",") invalid();
        whitespace(); need(); if (source[position] === "]") invalid();
      }
    }
    for (const literal of ["true", "false", "null"]) if (literal[0] === char) {
      for (const expected of literal) { need(); if (source[position++] !== expected) invalid(); }
      return literal === "null" ? null : literal === "true";
    }
    if (char === "-" || /[0-9]/.test(char)) {
      const start = position;
      if (char === "-") { position++; need(); }
      if (source[position] === "0") position++;
      else {
        if (!/[1-9]/.test(source[position])) invalid();
        while (/[0-9]/.test(source[position] ?? "!")) position++;
      }
      if (source[position] === ".") {
        position++; need(); if (!/[0-9]/.test(source[position])) invalid();
        while (/[0-9]/.test(source[position] ?? "!")) position++;
      }
      if (source[position] === "e" || source[position] === "E") {
        position++; need(); if (source[position] === "+" || source[position] === "-") { position++; need(); }
        if (!/[0-9]/.test(source[position])) invalid();
        while (/[0-9]/.test(source[position] ?? "!")) position++;
      }
      // At buffer end a number may still acquire more digits/exponent digits.
      need(); if (!/[\x20\t\r\n,}\]]/.test(source[position])) invalid();
      const number = Number(source.slice(start, position)); if (!Number.isFinite(number)) invalid();
      return number;
    }
    return invalid();
  }
  function object(path: JsonPath, root = false): Record<string, unknown> {
    const target = root ? values : {}, keys = new Set<string>();
    position++; whitespace(); need();
    if (source[position] === "}") { position++; return target; }
    for (;;) {
      if (source[position] !== '"') invalid();
      const key = string();
      if (forbidden.has(key) || keys.has(key)) invalid(); keys.add(key);
      whitespace(); need(); if (source[position++] !== ":") invalid(); whitespace(); need();
      const array = root && source[position] === "[" ? [] : undefined;
      if (array) target[key] = array;
      target[key] = value([...path, key], array);
      if (root) completeKeys.push(key);
      whitespace(); need(); if (source[position] === "}") { position++; return target; }
      if (source[position++] !== ",") invalid(); whitespace(); need();
      if (source[position] === "}") invalid();
    }
  }
  try {
    if (typeof source !== "string" || source.length > UI_PLAN_LIMITS.characters) invalid();
    whitespace(); need(); if (source[position] !== "{") invalid();
    count++; object([], true); whitespace(); if (position !== source.length) invalid();
    return { status: "complete", values, completeKeys, characters: source.length };
  } catch (error) {
    return error === incomplete
      ? { status: "partial", values, completeKeys, characters: source.length }
      : { status: "invalid", values: {}, completeKeys: [], characters: source?.length ?? 0, diagnostic: "Invalid or excessive JSON prefix" };
  }
}
