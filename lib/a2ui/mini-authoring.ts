import { Type } from "typebox";
import { miniAppPlanSchema } from "../mini-app/plan-schema";
import { miniAppDecisionPrompt, miniAppCapabilityContext } from "../mini-app/decision-policy";
import type { MiniAppCapabilitySnapshot } from "../mini-app/capabilities";
import { readMiniAppCapabilities } from "../mini-app/capability-host";
import { a2uiMessagesSchema, A2UI_AUTHORING_GUIDELINES } from "./authoring";
import { PIORA_A2UI_CATALOG } from "./catalog";

export const a2uiMiniAppSchema = Type.Object({ ...miniAppPlanSchema.properties,
  document: Type.Object({ messages: a2uiMessagesSchema }, { additionalProperties: false,
    description: "A2UI 1.0 interface. In addition to standard layouts/controls: PioraSvg:{markup:bounded SVG}; PioraViewport:{viewportId:declaredViewportId}; PioraRepeat:{repeatId,template:bounded row markup}. Text binds to /frame/key. Buttons call pioraEvent or pioraPreset with args:{id}. No top-level html/css. Program/stateSchema/playback remain the separate isolated runtime contract." }),
}, { additionalProperties: false });
export function a2uiMiniAppExample() {
  return { planVersion: 1, id: "counter", title: "逐步计数", purpose: "观察计数随操作变化", assumptions: [], inputs: [], stateSchema: { type: "integer", minimum: 0, maximum: 10 },
    document: { messages: [{ version: "1.0", createSurface: { surfaceId: "counter", catalogId: PIORA_A2UI_CATALOG,
      components: [{ id: "root", component: "Column", children: ["result", "next"] }, { id: "result", component: "Text", text: { "@path": "/frame/count" } },
        { id: "next", component: "Button", child: "nextLabel", action: { functionCall: { "@call": "pioraEvent", args: { id: "next" } } } }, { id: "nextLabel", component: "Text", text: "下一步" }], dataModel: { inputs: {} } } }] },
    viewports: [], playback: { mode: "discrete", stepEvent: "next" },
    program: "function init(){return 0;} function reduce(s,e){return e.type==='click'&&e.id==='next'?Math.min(10,s+1):s;} function advance(s){return s;} function project(s){return {summary:'当前计数 '+s,bindings:{count:s},playback:{finished:s===10}};}", initialSnapshot: "从 0 开始，最多计数到 10。" };
}
export function a2uiMiniAppPrompt(capabilities: MiniAppCapabilitySnapshot = readMiniAppCapabilities()) {
  const legacy = miniAppDecisionPrompt(capabilities);
  const excluded = ["Submit complete MiniAppPlan1", "Inputs declare", "Document HTML is", "Use bounded layout CSS", "Compiler HTML allowlist", "Before calling piora_render_mini_app", "Complete valid JSON arguments", "Executable editable-list protocol example", "Executable spatial-interaction example"];
  const guidelines = legacy.promptGuidelines.filter(line => !excluded.some(prefix => line.startsWith(prefix)) && !line.includes("document contains only html and css"));
  return { ...legacy, description: legacy.description.replace(/using bounded HTML\/CSS[^.]*?and isolated deterministic JavaScript/, "using an A2UI 1.0 interface and isolated deterministic JavaScript"),
    promptGuidelines: [...guidelines, ...A2UI_AUTHORING_GUIDELINES,
      "Author the interface only as document:{messages:[A2UI 1.0 messages]}. The rest of the mini-app contract remains planVersion:1,id,title,purpose,assumptions,inputs,stateSchema,viewports,playback,program,initialSnapshot and optional registered actions/migration/conversion/inputPresets. Never submit document.html or document.css. The host compiles the catalog into native markup and owns layout styling; no arbitrary React or browser script.",
      "This mini-app layout profile uses responsive equal-width Row/Column/Card, default Button, horizontal Divider, and labeled TextField. Omit weight/justify/align, nondefault Button variants, vertical dividers and placeholders; these are rejected rather than silently ignored. Text supports body/caption variants.",
      "Declare input constraints and meanings in inputs as before, then mount each exactly once with PioraNumber(number), Slider(range), CheckBox(checkbox), PioraChoice(select) or TextField(text). Component ID is independent of the input ID; value:{'@path':'/inputs/inputId'} selects the declared input, literal label equals declared label, and dataModel.inputs exactly matches initial values. PioraChoice options are the declared option value strings. Slider max/min and optional steps must agree with runtime bounds/step. Results use Text with text:{'@path':'/frame/key'}; project() returns that key in bindings. Put computations in the isolated program, not A2UI calls for this tool.",
      "Local Button uses a literal Text child and action:{functionCall:{'@call':'pioraEvent',args:{id:'eventId'}}}; it maps to reduce click events. pioraPreset instead names a declared input preset with the same label. For a discrete process the event ID must match playback.stepEvent. Events never grant file/network/tool access.",
      "PioraSvg has markup containing exactly one bounded SVG root; existing SVG data-text/data-bind/data-event rules still apply inside it. PioraViewport has viewportId naming a declared Canvas/scene3d view. PioraRepeat has repeatId and one bounded HTML row template; existing row data-field/data-event bindings apply. These are specialized catalog components, not arbitrary documents. Use only capabilities declared available by the host.",
      "PioraSvg geometry is declared as static svg/g/path/circle/ellipse/rect/line/polyline/polygon/text/title/desc elements in markup. Bind ONLY SVG attributes with data-bind='attribute:frameKey;attribute:frameKey', and scalar text with data-text='frameKey'. Never inject SVG/HTML strings as bindings, use bare data-bind='key', or replace child markup from project(). Use numeric width/height and viewBox; percentage dimensions such as width='100%' are unsupported (the host handles responsive sizing). No xmlns, scripts, external resources, inline handlers or foreign namespaces.",
      "Generic moving-part example: PioraSvg.markup is <svg width='400' height='200' viewBox='0 0 400 200'><g data-bind='transform:offset;opacity:alpha'><circle cx='80' cy='80' r='24' fill='#32816a'/></g></svg>. project returns bindings:{offset:'translate('+state.x+' 0)',alpha:1}; keep the circle geometry in markup. Every declared binding must have a scalar value on every frame. Use the actual task's geometry and state, not this example's circle for every task.",
      `Complete A2UI mini-app example: ${JSON.stringify(a2uiMiniAppExample())}`,
    ] };
}
export function a2uiMiniAppEnvironmentContext(capabilities: MiniAppCapabilitySnapshot): string {
  const guidance = a2uiMiniAppPrompt(capabilities).promptGuidelines.filter(line => /^(Opt a scene3d|A scene is|Progress migration:|Registered actions:|Cross-form|Input presets:)/.test(line));
  return `${miniAppCapabilityContext(capabilities)}\nThe interface uses A2UI 1.0 document.messages; keep that authoring contract when revising.\n${guidance.join("\n")}`;
}
