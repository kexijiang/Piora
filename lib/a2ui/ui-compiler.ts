import { compileUiRichPlan, type CompiledUiRichPlan, type UiPlanV2, type UiPlanV2Atom } from "../intelligent-ui/rich-plan";
import { UiPlanError } from "../intelligent-ui/plan-types";
import { validateRichState } from "../intelligent-ui/rich-protocol";
import { boundedJson } from "../mini-app/json";
import { a2uiKeys, a2uiMessages, a2uiPath, object, parseA2uiMessages, requireA2ui, type A2uiDocument } from "./document";
import { PIORA_A2UI_CATALOG, PIORA_A2UI_OPERATIONS } from "./catalog";

export interface A2uiUiSource { id: string; title: string; messages: unknown[]; actions?: unknown; conversion?: unknown }
export function a2uiExpression(value: unknown, depth = 0): UiPlanV2Atom {
  requireA2ui(depth <= 12, "expression", "At most 12 nested calls");
  if (typeof value === "string" || typeof value === "boolean" || typeof value === "number") return value;
  const input = a2uiPath(value, "inputs"); if (input) return { input };
  requireA2ui(object(value), "expression", "Use a scalar, /inputs/id binding or catalog function");
  a2uiKeys(value, ["@call", "args", "catalogId"], "expression");
  requireA2ui(value.catalogId === undefined || value.catalogId === PIORA_A2UI_CATALOG, "expression", "Use the registered catalog");
  requireA2ui(PIORA_A2UI_OPERATIONS.includes(value["@call"] as typeof PIORA_A2UI_OPERATIONS[number]), "expression", "Unsupported calculation function");
  requireA2ui(object(value.args), "expression/args", "Expected {values:[...]}");
  a2uiKeys(value.args, ["values"], "expression/args");
  requireA2ui(Array.isArray(value.args.values) && value.args.values.length <= 32, "expression/args/values", "Expected bounded operands");
  return { op: value["@call"] as typeof PIORA_A2UI_OPERATIONS[number], args: value.args.values.map(item => a2uiExpression(item, depth + 1)) };
}
function label(value: unknown, path: string): string { requireA2ui(typeof value === "string" && value.trim() && value.length <= 160, path, "Use a nonempty literal label"); return value; }

/** A2UI is the authoring and display contract. The old typed calculation graph
 * is an internal execution IR, retained to preserve its domain checks and journals. */
export function compileA2uiUi(input: unknown, options: { revision: number }): CompiledUiRichPlan {
  try {
    boundedJson(input, 128_000, "answer"); requireA2ui(object(input), "answer", "Expected a complete A2UI answer");
    a2uiKeys(input, ["id", "title", "messages", "actions", "conversion"], "answer");
    const id = label(input.id, "id"), title = label(input.title, "title");
    const document = parseA2uiMessages(input.messages, id);
    const data = document.dataModel.inputs ?? {};
    requireA2ui(object(data), "dataModel/inputs", "Expected a plain input object");
    const plan: UiPlanV2 = { planVersion: 2, id, title, inputs: [], derived: [], views: [], layout: [],
      ...(input.actions ? { actions: input.actions as UiPlanV2["actions"] } : {}), ...(input.conversion ? { conversion: input.conversion as UiPlanV2["conversion"] } : {}) };
    for (const c of document.components) {
      const control = ["PioraNumber", "PioraChoice", "Slider", "CheckBox"].includes(c.component);
      if (control) {
        const inputId = a2uiPath(c.value, "inputs");
        requireA2ui(inputId && Object.hasOwn(data, inputId), c.id, "Bind each control to /inputs/<input id> and supply that initial value");
        requireA2ui(!plan.inputs.some(input => input.id === inputId), c.id, "This profile supports one control per input binding");
        const name = label(c.label, `${c.id}/label`), value = data[inputId];
        if (c.component === "CheckBox") {
          requireA2ui(typeof value === "boolean", c.id, "Expected a boolean initial value");
          plan.inputs.push({ id: inputId, label: name, valueType: "boolean", value });
        } else if (c.component === "PioraChoice") {
          requireA2ui(typeof value === "string", c.id, "Expected a string initial value");
          plan.inputs.push({ id: inputId, label: name, valueType: "string", value, options: c.options as string[] });
        } else {
          requireA2ui(typeof value === "number", c.id, "Expected a numeric initial value");
          const min = c.min ?? (c.component === "Slider" ? 0 : undefined);
          const step = c.component === "Slider" && c.steps !== undefined ? (Number(c.max) - Number(min)) / Number(c.steps) : c.step;
          plan.inputs.push({ id: inputId, label: name, valueType: "number", value, presentation: c.component === "Slider" ? "slider" : "number",
            ...(min !== undefined ? { min: Number(min) } : {}), ...(c.max !== undefined ? { max: Number(c.max) } : {}), ...(step !== undefined ? { step: Number(step) } : {}), ...(c.unit ? { unit: c.unit as string } : {}) });
        }
      } else if (c.component === "Text") {
        if (typeof c.text === "string") plan.views.push({ id: c.id, kind: "text", text: c.text });
        else if (object(c.text) && c.text["@call"] === "concat") {
          a2uiKeys(c.text, ["@call", "args"], c.id); requireA2ui(object(c.text.args), c.id, "Expected concat arguments"); a2uiKeys(c.text.args, ["values"], c.id);
          requireA2ui(Array.isArray(c.text.args.values), c.id, "Expected concat values");
          plan.views.push({ id: c.id, kind: "dynamicText", parts: c.text.args.values.map(value => a2uiExpression(value)) });
        } else plan.views.push({ id: c.id, kind: "dynamicText", parts: [a2uiExpression(c.text)] });
      } else if (c.component === "PioraMetric") plan.views.push({ id: c.id, kind: "metric", label: label(c.label, c.id), value: a2uiExpression(c.value), ...(c.unit ? { unit: c.unit as string } : {}) });
      else if (c.component === "PioraTable") plan.views.push({ id: c.id, kind: "table", columns: c.columns as string[], rows: (c.rows as unknown[][]).map(row => row.map(cell => a2uiExpression(cell))) });
      else if (c.component === "PioraBarChart") plan.views.push({ id: c.id, kind: "barChart", labels: c.labels as string[], values: (c.values as unknown[]).map(value => a2uiExpression(value)) });
      else requireA2ui(["Row", "Column", "Card", "Divider", "Button"].includes(c.component), c.id, "Use the A2UI mini-app tool for text editing, SVG, repeated rows and viewports");
    }
    requireA2ui(Object.keys(data).length === plan.inputs.length, "dataModel/inputs", "Declare exactly the inputs used by controls");
    const nodeIds = [...plan.inputs, ...plan.views].map(node => node.id);
    let layoutId = "pioraLayout"; while (nodeIds.includes(layoutId)) layoutId += "x";
    plan.layout = [{ id: layoutId, type: "group", title, columns: 1, nodeIds }];
    const compiled = compileUiRichPlan(plan, options);
    for (const component of document.components.filter(c => c.component === "Button")) {
      const action = component.action;
      requireA2ui(object(action) && object(action.functionCall), component.id, "Use a local pioraSet functionCall");
      const call = action.functionCall;
      requireA2ui(call["@call"] === "pioraSet" && object(call.args) && typeof call.args.input === "string", component.id, "Component answers support only pioraSet buttons");
      const child = document.components.find(c => c.id === component.child);
      requireA2ui(child?.component === "Text" && typeof child.text === "string", component.id, "Button child must be literal Text");
      validateRichState(compiled.surface, { ...data, [call.args.input]: call.args.value });
    }
    compiled.surface.a2ui = document;
    // Surface and journal versions describe the internal persistence format;
    // protocol version stays explicitly 1.0 in the A2UI document messages.
    return { ...compiled, compilerVersion: "a2ui-1.0/1" };
  } catch (error) {
    if (error instanceof UiPlanError) throw error;
    throw new UiPlanError("PLAN_SHAPE", "$.messages", error instanceof Error ? error.message : "Invalid A2UI document");
  }
}

export function validateA2uiSurface(input: Record<string, unknown>) {
  const source = input.a2ui as A2uiDocument;
  const compiled = compileA2uiUi({ id: input.id, title: input.title, messages: a2uiMessages(source) }, { revision: Number(input.revision) });
  requireA2ui(JSON.stringify(compiled.surface) === JSON.stringify(input), "surface", "Saved A2UI and calculation projection do not match");
  return compiled.surface;
}
