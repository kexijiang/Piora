import { parse, type Node } from "acorn";
import { MINI_APP_LIMITS, miniAppError } from "./limits";
import { MINI_APP_PROGRAM_SCOPE_CONTRACT } from "./authoring-contract";

export const MINI_APP_EXPORTS = ["init", "reduce", "advance", "project"] as const;

function primitiveLiteral(node: Node | null | undefined): boolean {
  if (!node) return false;
  if (node.type === "Literal") {
    const value = (node as Node & { value: unknown }).value;
    return value === null || typeof value === "boolean" || typeof value === "string"
      || typeof value === "number" && Number.isFinite(value);
  }
  if (node.type === "UnaryExpression") {
    const unary = node as Node & { operator: string; argument: Node & { value?: unknown } };
    return ["+", "-"].includes(unary.operator) && unary.argument.type === "Literal"
      && typeof unary.argument.value === "number" && Number.isFinite(unary.argument.value);
  }
  return false;
}

/** Fresh scope plus immutable primitive constants cannot carry unsaved module state. */
export function compileMiniAppProgram(source: unknown, migration = false): { factory: string; hasConstants: boolean; hasMigration: boolean } {
  if (typeof source !== "string" || !source.trim()) miniAppError("SYNTAX", "program", "Expected lifecycle function declarations");
  if (new TextEncoder().encode(source).byteLength > MINI_APP_LIMITS.programBytes) miniAppError("LIMIT", "program", "Program is too large");
  let ast;
  try { ast = parse(source, { ecmaVersion: 2022, sourceType: "script" }); }
  catch (error) {
    // Acorn's numeric location is useful for a single bounded correction. Never
    // echo its arbitrary source fragments or expose a VM stack in diagnostics.
    const location = (error as { loc?: { line?: unknown; column?: unknown } })?.loc;
    const at = Number.isSafeInteger(location?.line) && Number.isSafeInteger(location?.column)
      ? ` at line ${location!.line}, column ${Number(location!.column) + 1}` : "";
    miniAppError("SYNTAX", "program", `Invalid JavaScript syntax${at}. Check balanced quotes/braces and real line breaks in the decoded program string; a literal backslash followed by n outside a string is not a JavaScript newline. Resubmit the complete plan.`);
  }
  const names = new Set<string>();
  const functions = new Set<string>();
  let constants = 0;
  for (const node of ast.body) {
    if (node.type === "VariableDeclaration" && node.kind === "const") {
      for (const declaration of node.declarations) {
        if (declaration.id.type !== "Identifier" || !primitiveLiteral(declaration.init)) {
          miniAppError("SYNTAX", "program", "Top-level const needs a simple name and a finite primitive literal. " + MINI_APP_PROGRAM_SCOPE_CONTRACT);
        }
        if (names.has(declaration.id.name)) miniAppError("SYNTAX", "program", "Duplicate top-level name");
        names.add(declaration.id.name);
        if (++constants > 128) miniAppError("SYNTAX", "program", "At most 128 top-level constants are allowed");
      }
      continue;
    }
    if (node.type !== "FunctionDeclaration" || !node.id || node.async || node.generator) {
      miniAppError("SYNTAX", "program", "At module scope use synchronous function declarations or const primitive literals; put mutable state in init/reduce/advance return values");
    }
    if (names.has(node.id.name)) miniAppError("SYNTAX", "program", "Duplicate function name");
    names.add(node.id.name);
    functions.add(node.id.name);
  }
  if (functions.size > 128 || MINI_APP_EXPORTS.some(name => !functions.has(name))) {
    miniAppError("SYNTAX", "program", "Define init, reduce, advance and project, with at most 128 functions");
  }
  if (migration && !functions.has("migrate")) miniAppError("SYNTAX", "program", "A progress migration requires function migrate(previous,inputs,ctx)");
  return { factory: `(function(){"use strict";\n${source}\nreturn {init,reduce,advance,project${migration ? ",migrate" : ""}};})`, hasConstants: constants > 0, hasMigration: functions.has("migrate") };
}

export function miniAppProgramFactory(source: unknown, migration = false): string {
  return compileMiniAppProgram(source, migration).factory;
}
