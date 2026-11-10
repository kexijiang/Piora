export type UiInputProtocol = "surface" | "plan-1" | "plan-2" | "a2ui-1";

/** Selected once when the bundled extension loads; Beta remains the user-facing switch. */
export function uiInputProtocol(value = process.env.PIORA_UI_INPUT_PROTOCOL): UiInputProtocol {
  if (value === undefined || value === "a2ui-1") return "a2ui-1";
  if (value === "plan-2") return "plan-2";
  if (value === "plan-1") return "plan-1";
  // Retain the explicit legacy override and historical fallback for unknown values.
  return "surface";
}
