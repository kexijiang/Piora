/** Public diagnostics use fixed text, never raw model values or server errors. */
export function surfaceDiagnostic(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  if (["UI surface too large", "UI expression budget exceeded", "UI requires 1 to 64 nodes"].includes(message)) {
    return { code: "UI_COMPLEXITY", path: "$.nodes", expected: "Keep the surface within 64 nodes, 4096 expression nodes, depth 12 and 64000 JSON characters.", repairable: false };
  }
  if (message === "Unknown UI control reference") {
    return { code: "UI_REFERENCE", path: "$.nodes", expected: "References must name input controls. Computed outputs cannot be referenced in Surface v1; use nested operations.", repairable: true };
  }
  if (["round requires one argument", "Binary operation requires two arguments", "if requires condition, true value, false value"].includes(message)) {
    return { code: "UI_ARITY", path: "$.nodes", expected: "round takes one argument; divide/subtract/equals take two; if takes condition, true value and false value.", repairable: true };
  }
  const structural = new Set(["UI surface must be an object", "Unknown UI property", "Unsupported UI version or surface id",
    "Invalid UI revision", "UI title is required", "Duplicate or invalid UI node id", "Invalid UI text", "Invalid numeric control",
    "Invalid control range", "Control step must be positive", "Invalid control bounds", "Control value below minimum",
    "Control value above maximum", "Slider requires finite min and max", "Invalid select control", "Invalid checkbox",
    "Invalid metric label", "Invalid table columns", "Too many table rows", "Invalid table row", "Invalid chart labels",
    "Invalid chart values", "Unsupported UI node type", "Invalid UI expression", "Unsupported UI operation", "Invalid UI operation arguments"]);
  return { code: "UI_SURFACE_INVALID", path: "$", expected: structural.has(message) ? message : "The surface could not be validated.", repairable: structural.has(message) };
}
