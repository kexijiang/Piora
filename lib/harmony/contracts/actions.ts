import { Type, validateToolArguments } from "@earendil-works/pi-ai";
import { HarmonyError } from "../errors";
import { assertToolJsonObject } from "../../tool-json";

const string = (maxLength = 512) => Type.String({ minLength: 1, maxLength });
const optional = Type.Optional;
const number = (minimum: number, maximum: number) => Type.Number({ minimum, maximum });
const values = <T extends string>(items: T[]) => Type.Union(items.map(item => Type.Literal(item)));
export const keyNames = ["back", "home", "recents", "enter"] as const;
export const keySchema = values([...keyNames]);
const selectorFields = {
  id: optional(string()), text: optional(string()), type: optional(string()), hint: optional(string()),
  description: optional(string()), inWindow: optional(string()),
  match: optional(values(["exact", "contains", "starts_with", "ends_with"])),
  index: optional(Type.Integer({ minimum: 0, maximum: 999 })),
  ...Object.fromEntries(["clickable", "scrollable", "enabled", "focused", "selected", "checked", "visible"].map(key => [key, optional(Type.Boolean())])),
};
export const selectorSchema = Type.Object({ ...selectorFields,
  within: optional(Type.Object(selectorFields)), before: optional(Type.Object(selectorFields)), after: optional(Type.Object(selectorFields)),
});
export const conditionSchema = Type.Object({ selector: selectorSchema, exists: optional(Type.Boolean()),
  timeoutMs: optional(number(100, 60_000)), intervalMs: optional(number(100, 5_000)),
});
const wait = { waitFor: optional(conditionSchema) };
const semantic = { selector: selectorSchema, ...wait };
const point = { x: number(0, 100_000), y: number(0, 100_000) };
const coordinates = { coordinateSpace: optional(values(["native", "frame"])), geometryId: optional(string(128)), generation: optional(Type.Integer({ minimum: 0 })) };
const gesture = { fromX: point.x, fromY: point.y, toX: point.x, toY: point.y, durationMs: optional(number(50, 10_000)), ...coordinates };
const app = { bundleName: Type.String({ pattern: "^[A-Za-z][A-Za-z0-9_.]{0,255}$" }) };
type Fields = Parameters<typeof Type.Object>[0];
type Definition = { description: string; risk: "read" | "control"; scenario?: Fields; direct?: Fields };

/** One action inventory for discovery, HTTP admission, scenario validation and docs. */
export const actionCatalog = {
  tap: { description: "Tap one fresh semantic target or an explicit geometry point", risk: "control", scenario: semantic, direct: { ...point, ...coordinates } },
  double_tap: { description: "Double tap a target", risk: "control", scenario: semantic, direct: { ...point, ...coordinates } },
  long_press: { description: "Provider-defined short long press; not continuous touch hold", risk: "control", scenario: semantic, direct: { ...point, ...coordinates } },
  tap_ref: { description: "Revalidate a retained reference against a fresh complete tree", risk: "control", direct: { ref: string(256), generation: Type.Integer({ minimum: 0 }) } },
  input_text: { description: "Set or append semantic text and verify exact readback", risk: "control", scenario: { ...semantic, text: string(8192), append: optional(Type.Boolean()) }, direct: { text: string(8192) } },
  clear_text: { description: "Clear semantic text and verify empty readback", risk: "control", scenario: semantic },
  scroll_find: { description: "Find within a bounded directional swipe budget", risk: "control", scenario: { ...semantic, container: optional(selectorSchema), direction: optional(values(["up", "down"])), maxSwipes: optional(Type.Integer({ minimum: 1, maximum: 30 })), tap: optional(Type.Boolean()) } },
  swipe: { description: "Bounded swipe", risk: "control", scenario: { direction: values(["up", "down", "left", "right"]), durationMs: gesture.durationMs, ...wait }, direct: gesture },
  fling: { description: "Fling using an explicit provider", risk: "control", scenario: { direction: values(["up", "down", "left", "right"]), durationMs: gesture.durationMs, ...wait }, direct: gesture },
  drag: { description: "Drag between geometry points", risk: "control", direct: gesture },
  press_key: { description: "Press a supported logical key", risk: "control", scenario: { key: keySchema, ...wait }, direct: { key: keySchema } },
  key_hold: { description: "Hold an exact calibrated physical key duration with bounded release", risk: "control", direct: { key: values(["power", "volume_up", "volume_down"]), durationMs: Type.Integer({ minimum: 50, maximum: 5000 }) } },
  open_assistant: { description: "Use a device-bound power-key profile and verify its calibrated assistant postcondition", risk: "control", direct: { profileId: string(64) } },
  touch_hold: { description: "Continuous calibrated touch with geometry and focus monitoring", risk: "control", direct: { ...point, ...coordinates, geometryId: string(128), durationMs: Type.Integer({ minimum: 50, maximum: 15_000 }) } },
  voice_input: { description: "Play an immutable asset over a calibrated acoustic route and verify the phone transcript", risk: "control", direct: { audioAssetId: string(64), profileId: string(64), requiredMode: optional(Type.Union([Type.Literal("tap"), Type.Literal("push-to-talk")])), timeoutMs: optional(Type.Integer({ minimum: 1000, maximum: 60_000 })), geometryId: optional(string(128)) }, scenario: { audioAssetId: string(64), profileId: string(64), requiredMode: optional(Type.Union([Type.Literal("tap"), Type.Literal("push-to-talk")])), timeoutMs: optional(Type.Integer({ minimum: 1000, maximum: 60_000 })), geometryId: optional(string(128)) } },
  geometry_assert: { description: "Verify native display rotation against a newly captured screenshot", risk: "read", scenario: { rotation: Type.Union([Type.Literal(0), Type.Literal(90), Type.Literal(180), Type.Literal(270)]) } },
  launch_app: { description: "Launch a bundle and optional ability", risk: "control", scenario: { ...app, abilityName: optional(string(256)), ...wait }, direct: { ...app, abilityName: optional(string(256)) } },
  stop_app: { description: "Stop the selected application", risk: "control", scenario: app, direct: app },
  clear_app_data: { description: "Clear data of the selected application", risk: "control", scenario: app, direct: app },
  clear_app_cache: { description: "Clear cache of the selected application for the active user", risk: "control", direct: app },
  uninstall_app: { description: "Uninstall the selected application", risk: "control", scenario: app, direct: app },
  enable_app: { description: "Enable an app for the active user on a root device build", risk: "control", direct: app },
  disable_app: { description: "Disable an app for the active user on a root device build", risk: "control", direct: app },
  install_app: { description: "Install an integrity-checked immutable HAP", risk: "control", scenario: { hapPath: string(4096), replace: optional(Type.Boolean()) }, direct: { hapPath: string(4096), replace: optional(Type.Boolean()) } },
  upload_file: { description: "Upload an immutable local file into a writable device path", risk: "control", direct: { kind: values(["shared", "sandbox"]), bundleName: optional(string(256)), sourcePath: string(4096), path: string(4096), overwrite: optional(Type.Boolean()) } },
  create_directory: { description: "Create one device directory without creating parents", risk: "control", direct: { kind: values(["shared", "sandbox"]), bundleName: optional(string(256)), path: string(4096) } },
  delete_path: { description: "Delete one regular device file or empty directory", risk: "control", direct: { kind: values(["shared", "sandbox"]), bundleName: optional(string(256)), path: string(4096) } },
  rename_path: { description: "Rename one device file or directory without overwriting", risk: "control", direct: { kind: values(["shared", "sandbox"]), bundleName: optional(string(256)), path: string(4096), newPath: string(4096) } },
  chmod_path: { description: "Set three-digit octal permissions on one regular device file or directory", risk: "control", direct: { kind: values(["shared", "sandbox"]), bundleName: optional(string(256)), path: string(4096), mode: Type.String({ pattern: "^[0-7]{3}$" }) } },
  initialize_mirror: { description: "Initialize the capture component on request; never unlock", risk: "control", direct: {} },
  wait_for: { description: "Wait for a valid semantic observation", risk: "read", scenario: { condition: conditionSchema } },
  assert: { description: "Assert a valid semantic observation", risk: "read", scenario: { condition: conditionSchema } },
  wait_idle: { description: "Report driver idle or explicitly bounded delay", risk: "read", scenario: { idleMs: optional(number(50, 10_000)), timeoutMs: optional(number(50, 60_000)) } },
  checkpoint: { description: "Persist an explicit execution boundary", risk: "read", scenario: { name: string(120) } },
  stop_device: { description: "Fence and stop only the selected device", risk: "control", direct: {} },
  emergency_stop: { description: "Fence and stop all devices", risk: "control", direct: { reason: optional(string(160)) } },
} satisfies Record<string, Definition>;

export type HarmonyActionName = keyof typeof actionCatalog;
export function actionDescriptor(action: HarmonyActionName) {
  const definition = actionCatalog[action];
  return { protocolVersion: 1, action, description: definition.description, risk: definition.risk,
    capability: action, retry: "only-before-dispatch", cleanup: ["key_hold", "touch_hold", "open_assistant"].includes(action) ? "release-input" : action === "voice_input" ? "release-input-and-audio" : "owned-resources",
    result: definition.risk === "read" ? "observation-with-quality" : "dispatch-receipt-with-separate-verification",
    modes: (["direct", "scenario"] as const).filter(mode => mode in definition),
  };
}
export function actionSchema(action: string, mode: "scenario" | "direct") {
  const definition = (actionCatalog as Record<string, Definition>)[action];
  const fields = definition?.[mode];
  if (!fields) throw new HarmonyError("INVALID_ARGUMENT", `Unsupported ${mode} action`);
  return Type.Object({ action: Type.Literal(action), ...fields,
    ...(mode === "scenario" ? { id: optional(string(120)) } : { serial: optional(string(256)), leaseToken: optional(string(256)) }),
  }, { additionalProperties: false });
}
export function validateAction(value: unknown, mode: "scenario" | "direct"): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HarmonyError("INVALID_ARGUMENT", "Action must be an object");
  const action = (value as { action?: unknown }).action;
  if (typeof action !== "string") throw new HarmonyError("INVALID_ARGUMENT", "Action name is required");
  const parameters = actionSchema(action, mode);
  try {
    assertToolJsonObject(value);
    const parsed = validateToolArguments({ name: action, description: actionCatalog[action as HarmonyActionName].description, parameters },
      { type: "toolCall", id: "harmony-admission", name: action, arguments: value });
    if (JSON.stringify(parsed) !== JSON.stringify(value)) throw new Error("Coercion is not allowed at the device boundary");
  }
  catch { throw new HarmonyError("INVALID_ARGUMENT", `Invalid parameters for ${action}`, { details: { action, dispatchState: "not-sent" } }); }
}

/** Compact discovery form; each execution still uses the discriminated action schema. */
export const scenarioStepSchema = (() => {
  const definitions = Object.entries(actionCatalog).filter(([, definition]) => "scenario" in definition);
  const fields: Fields = {};
  for (const [, definition] of definitions) for (const [key, schema] of Object.entries((definition as Definition).scenario!)) {
    fields[key] = optional(schema);
  }
  // Shared direction fields have different subsets; runtime per-action schema narrows them.
  fields.direction = optional(values(["up", "down", "left", "right"]));
  return Type.Object({ id: optional(string(120)), action: values(definitions.map(([name]) => name)), ...fields });
})();
