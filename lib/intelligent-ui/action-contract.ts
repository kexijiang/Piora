import { isUiId } from "./protocol";
import type { UiState, UiSurface } from "./surface-document";
import type { UiActionProblem } from "./action-feedback";

/** Independently versioned action declarations; not expressions or generated code. */
export const UI_ACTION_VERSION = 1 as const;
export const UI_ACTION_LIMITS = Object.freeze({ actions: 8, pathCharacters: 240, fileBytes: 256_000, resultCharacters: 128_000 });
interface ActionBase { id: string; label: string; path: string }
export type UiAction =
  | (ActionBase & { kind: "read_json_parameters" })
  | (ActionBase & { kind: "save_snapshot"; format: "json" | "markdown" });
export interface UiActionDeclaration { version: 1; actions: UiAction[] }
/** Server-captured source; its digest is a compare token, never authorization. */
export interface UiActionSource {
  sessionId: string; toolCallId: string; operationId: string; leafId: string; publicationEntryId: string;
  surface: UiSurface; state: UiState; revision: number; actions: UiActionDeclaration; digest: string;
}
export class UiActionError extends Error {
  constructor(readonly code: "INVALID" | "TARGET" | "CONFLICT" | "LIMIT" | "UNAVAILABLE" | "CANCELLED" | "UNCERTAIN", message: string, readonly problem?: UiActionProblem) {
    super(message); this.name = "UiActionError";
  }
}
export function isUiActionError(error: unknown): error is UiActionError {
  return error instanceof Error && error.name === "UiActionError"
    && ["INVALID", "TARGET", "CONFLICT", "LIMIT", "UNAVAILABLE", "CANCELLED", "UNCERTAIN"].includes((error as UiActionError).code);
}
export function actionErrorProblem(error: unknown): UiActionProblem | undefined {
  if (!isUiActionError(error)) return undefined;
  const defaults: Record<UiActionError["code"], UiActionProblem> = { INVALID: "invalid", TARGET: "target", CONFLICT: "changed", LIMIT: "limit", UNAVAILABLE: "unavailable", CANCELLED: "cancelled", UNCERTAIN: "uncertain" };
  return error.problem ?? defaults[error.code];
}
export function assertUiAction(condition: unknown, code: UiActionError["code"], message: string, problem?: UiActionProblem): asserts condition {
  if (!condition) throw new UiActionError(code, message, problem);
}
const plain = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
function properties(value: unknown, allowed: string[]): asserts value is Record<string, unknown> {
  assertUiAction(plain(value), "INVALID", "Expected an action object");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  assertUiAction(Object.getOwnPropertySymbols(value).length === 0
    && Object.entries(descriptors).every(([key, descriptor]) => allowed.includes(key) && descriptor.enumerable && "value" in descriptor),
  "INVALID", "Only documented action data properties are accepted");
}
/** Portable project-relative names, with no shell, URI or SDK path aliases. */
export function validateActionPath(value: unknown): string {
  assertUiAction(typeof value === "string" && value.length > 0 && value.length <= UI_ACTION_LIMITS.pathCharacters
    && !value.startsWith("~") && !value.startsWith("@")
    && !/[\\:\x00-\x1f\x7f*?<>|"]/.test(value), "TARGET", "Use a bounded project-relative file path with forward slashes");
  const segments = value.split("/");
  assertUiAction(segments.every(segment => segment.length > 0 && segment.length <= 128 && !segment.startsWith(".")
    && segment.trim() === segment && !segment.endsWith(".")
    && !/^(?:con|conin\$|conout\$|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(segment)
    && !/^(?:auth\.json|credentials(?:\.[^/]*)?|id_rsa|id_ed25519|.*\.(?:pem|key|pfx|p12))$/i.test(segment)),
  "TARGET", "File paths must not contain hidden, parent, device or credential names");
  return value;
}
export function validateUiActions(input: unknown): UiActionDeclaration {
  properties(input, ["version", "actions"]);
  assertUiAction(input.version === UI_ACTION_VERSION, "INVALID", "Unsupported action declaration version");
  assertUiAction(Array.isArray(input.actions) && input.actions.length <= UI_ACTION_LIMITS.actions, "LIMIT", "At most eight registered actions are allowed");
  const entries = input.actions, descriptors = Object.getOwnPropertyDescriptors(entries);
  assertUiAction(Object.getPrototypeOf(entries) === Array.prototype && Object.getOwnPropertySymbols(entries).length === 0
    && Object.keys(descriptors).length === entries.length + 1 && Object.keys(descriptors).filter(key => key !== "length")
      .every((key, index) => key === String(index) && descriptors[key].enumerable && "value" in descriptors[key]), "INVALID", "Actions must be a dense ordinary data array");
  const ids = new Set<string>();
  const actions = entries.map((item: unknown): UiAction => {
    properties(item, ["id", "label", "kind", "path", "format"]);
    assertUiAction(isUiId(item.id) && !ids.has(item.id), "INVALID", "Action IDs must be unique bounded identifiers"); ids.add(item.id);
    assertUiAction(typeof item.label === "string" && item.label.trim().length > 0 && item.label.length <= 120, "INVALID", "Action labels must be nonempty and bounded");
    const path = validateActionPath(item.path), base = { id: item.id, label: item.label, path };
    if (item.kind === "read_json_parameters") {
      assertUiAction(!Object.hasOwn(item, "format") && path.endsWith(".json"), "INVALID", "Parameter queries read JSON files only");
      return { ...base, kind: "read_json_parameters" };
    }
    assertUiAction(item.kind === "save_snapshot" && ["json", "markdown"].includes(String(item.format)), "INVALID", "Unknown registered action or snapshot format");
    const format = item.format as "json" | "markdown";
    assertUiAction(path.endsWith(format === "json" ? ".json" : ".md"), "INVALID", "Snapshot filename must match its format");
    return { ...base, kind: "save_snapshot", format };
  });
  return { version: 1, actions };
}
