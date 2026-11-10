import type { MiniAppInput, MiniAppInputPreset } from "../mini-app/plan";
import type { MiniAppViewport } from "../mini-app/frame";
import { MiniAppError } from "../mini-app/limits";
import { parseFragment } from "parse5";
import { a2uiChildren, a2uiMessages, a2uiPath, object, parseA2uiMessages, requireA2ui, type A2uiDocument } from "./document";

const escape = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
const css = ".a2ui-column{display:flex;flex-direction:column;gap:16px;min-width:0}.a2ui-row{display:flex;flex-wrap:wrap;gap:16px}.a2ui-cell{flex:1;min-width:180px}.a2ui-card{padding:18px;border:1px solid var(--border);border-radius:12px;background:var(--bg-panel)}.a2ui-control{display:flex;flex-direction:column;gap:8px}.a2ui-caption{font-size:.85rem;color:var(--text-muted)}.a2ui-divider{border-top:1px solid var(--border);margin:8px 0}button{padding:8px 14px;border:1px solid var(--border);border-radius:8px;background:var(--bg-panel);color:var(--text)}input,select{padding:8px;border:1px solid var(--border);border-radius:8px;background:var(--bg);color:var(--text)}@media(max-width:600px){.a2ui-row{flex-direction:column}.a2ui-cell{min-width:0}}";

/** The renderer compiles catalog components to trusted native markup. Generated
 * programs still run only in the existing worker; A2UI never carries executable UI. */
export function compileA2uiMiniDocument(messages: unknown, options: { id: string; inputs: MiniAppInput[]; viewports: MiniAppViewport[]; presets?: MiniAppInputPreset[] }): { html: string; css: string; a2ui: A2uiDocument } {
  try {
    const document = parseA2uiMessages(messages, options.id);
    const components = new Map(document.components.map(c => [c.id, c]));
    const initial = Object.fromEntries(options.inputs.map(input => [input.id, input.value]));
    requireA2ui(object(document.dataModel.inputs ?? {}) && JSON.stringify(Object.entries(document.dataModel.inputs ?? {}).sort()) === JSON.stringify(Object.entries(initial).sort()), "dataModel/inputs", "A2UI input defaults must exactly match the runtime input declarations");
    function render(id: string): string {
      const c = components.get(id)!;
      // Unsupported presentation properties must produce a repair diagnostic,
      // never silently change the meaning of an official component.
      requireA2ui(c.weight === undefined && c.justify === undefined && c.align === undefined, id, "The mini-app profile currently uses responsive equal-width layout; omit weight/justify/align");
      requireA2ui(c.component !== "Divider" || c.axis === undefined || c.axis === "horizontal", id, "The mini-app profile currently supports horizontal dividers");
      requireA2ui(c.component !== "TextField" || c.placeholder === undefined, id, "Use the literal field label; placeholders are not yet supported in the mini-app profile");
      requireA2ui(c.component !== "Button" || c.variant === undefined || c.variant === "default", id, "The mini-app profile currently supports default buttons");
      if (c.component === "Row" || c.component === "Column") return `<div class="a2ui-${c.component.toLowerCase()}">${a2uiChildren(c).map(child => c.component === "Row" ? `<div class="a2ui-cell">${render(child)}</div>` : render(child)).join("")}</div>`;
      if (c.component === "Card") return `<section class="a2ui-card">${render(c.child as string)}</section>`;
      if (c.component === "Divider") return '<div class="a2ui-divider"></div>';
      if (c.component === "Text") {
        if (typeof c.text === "string") return `<p${c.variant === "caption" ? ' class="a2ui-caption"' : ""}>${escape(c.text)}</p>`;
        const binding = a2uiPath(c.text, "frame"); requireA2ui(binding, id, "Mini-app Text binds to /frame/<binding>; calculations belong in project()");
        return `<p${c.variant === "caption" ? ' class="a2ui-caption"' : ""} data-text="${binding}"></p>`;
      }
      if (["PioraNumber", "PioraChoice", "Slider", "CheckBox", "TextField"].includes(c.component)) {
        const input = options.inputs.find(input => input.id === a2uiPath(c.value, "inputs"));
        requireA2ui(input, id, "Bind a declared input using /inputs/<input id>");
        const expected: Record<string, string> = { number: "PioraNumber", range: "Slider", select: "PioraChoice", checkbox: "CheckBox", text: "TextField" };
        requireA2ui(c.component === expected[input.type] && (c.label === undefined || c.label === input.label), id, "Component type and literal label must match the declared input");
        if (c.component === "PioraChoice") requireA2ui(JSON.stringify(c.options) === JSON.stringify(input.type === "select" ? input.options.map(option => option.value) : []), id, "Choice options must match runtime input values");
        if (input.type === "number" || input.type === "range") {
          for (const key of ["min", "max"] as const) requireA2ui(c[key] === undefined || c[key] === input[key], id, "Control bounds must match the runtime");
          requireA2ui(c.step === undefined || c.step === input.step, id, "Control step must match the runtime");
          if (c.steps !== undefined) requireA2ui(Math.abs((input.max - input.min) / Number(c.steps) - input.step) < 1e-9, id, "Slider divisions must match the runtime step");
        }
        const field = input.type === "select" ? `<select data-input="${input.id}"></select>` : `<input type="${input.type}" data-input="${input.id}">`;
        return `<label class="a2ui-control">${escape(input.label)}${field}</label>`;
      }
      if (c.component === "Button") {
        requireA2ui(object(c.action) && object(c.action.functionCall), id, "Use a local pioraEvent or pioraPreset functionCall");
        const call = c.action.functionCall;
        requireA2ui(object(call.args) && typeof call.args.id === "string" && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(call.args.id), id, "Expected a bounded action ID");
        const child = components.get(c.child as string); requireA2ui(child?.component === "Text" && typeof child.text === "string", id, "Use literal Text for the button child");
        if (call["@call"] === "pioraPreset") {
          const presetId = call.args.id;
          requireA2ui(options.presets?.some(preset => preset.id === presetId && preset.label === child.text), id, "Preset and label must match the declaration");
          return `<button data-preset="${call.args.id}"></button>`;
        }
        requireA2ui(call["@call"] === "pioraEvent", id, "Mini-app buttons dispatch only declared local events or presets");
        return `<button data-event="${call.args.id}">${escape(child.text)}</button>`;
      }
      if (c.component === "PioraViewport") {
        requireA2ui(options.viewports.some(view => view.id === c.viewportId), id, "Unknown viewport");
        return `<div data-viewport="${escape(String(c.viewportId))}"></div>`;
      }
      if (c.component === "PioraSvg") {
        requireA2ui(typeof c.markup === "string" && /^\s*<svg[\s>]/.test(c.markup), id, "PioraSvg requires a bounded SVG root");
        const roots = parseFragment(c.markup).childNodes.filter(node => node.nodeName !== "#text" || ("value" in node && node.value.trim()));
        requireA2ui(roots.length === 1 && roots[0].nodeName === "svg", id, "PioraSvg must contain exactly one SVG root");
        return c.markup;
      }
      if (c.component === "PioraRepeat") return `<div data-repeat="${escape(String(c.repeatId))}">${String(c.template)}</div>`;
      throw new Error(`Component ${c.component} is not available in the mini-app profile; use Text /frame bindings for results`);
    }
    return { html: render("root"), css, a2ui: document };
  } catch (error) { throw new MiniAppError("SCHEMA", error instanceof Error ? error.message : "Invalid A2UI document", "document/messages", true); }
}
export function recompileA2uiMiniDocument(document: A2uiDocument, options: Parameters<typeof compileA2uiMiniDocument>[1]) { return compileA2uiMiniDocument(a2uiMessages(document), options); }
