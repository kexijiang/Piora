import { Type } from "typebox";
import { uiRichPlanSchema } from "../intelligent-ui/rich-plan-schema";
import { intelligentUiDecisionPrompt } from "../intelligent-ui/decision-policy";
import { PIORA_A2UI_CATALOG } from "./catalog";

const components = Type.Array(Type.Object({ id: Type.String(), component: Type.String() }, {
  additionalProperties: true, description: "Catalog component. Row/Column:children:[ids],Card:child,Text:text,Divider:{},Slider:label,value,min,max,steps?,CheckBox:label,value,Button:child,action. PioraNumber:label,value,min?,max?,step?,unit?; PioraChoice:label,value,options:[strings]; PioraMetric:label,value,unit?; PioraTable:columns:[strings],rows:[[values]]; PioraBarChart:labels:[strings],values:[values]. Use @path for bindings, @call for catalog functions. All fields are checked by the official catalog schema and host profile.",
}), { minItems: 1, maxItems: 160 });
const strict = { additionalProperties: false };
const sid = Type.String({ pattern: "^[A-Za-z][A-Za-z0-9_-]{0,63}$" });
export const a2uiMessagesSchema = Type.Array(Type.Union([
  Type.Object({ version: Type.Literal("1.0"), createSurface: Type.Object({ surfaceId: sid, catalogId: Type.Literal(PIORA_A2UI_CATALOG), components: Type.Optional(components), dataModel: Type.Optional(Type.Record(Type.String(), Type.Unknown())) }, strict) }, strict),
  Type.Object({ version: Type.Literal("1.0"), updateComponents: Type.Object({ surfaceId: sid, components }, strict) }, strict),
  Type.Object({ version: Type.Literal("1.0"), updateDataModel: Type.Object({ surfaceId: sid, path: Type.Optional(Type.String()), value: Type.Unknown() }, strict) }, strict),
]), { minItems: 1, maxItems: 32, description: "A complete single-surface A2UI 1.0 message batch, starting with createSurface. Root component ID is root. Use the same surfaceId as id. No RPC, deleteSurface, HTML or external catalogs." });
export const a2uiUiSchema = Type.Object({ id: sid, title: Type.String({ minLength: 1, maxLength: 160 }), messages: a2uiMessagesSchema,
  actions: uiRichPlanSchema.properties.actions, conversion: uiRichPlanSchema.properties.conversion }, strict);
export function a2uiUiExample() {
  return { id: "cost", title: "费用比较", messages: [{ version: "1.0", createSurface: { surfaceId: "cost", catalogId: PIORA_A2UI_CATALOG,
    components: [{ id: "root", component: "Column", children: ["people", "total"] },
      { id: "people", component: "PioraNumber", label: "人数", value: { "@path": "/inputs/people" }, min: 1, step: 1 },
      { id: "total", component: "PioraMetric", label: "总费用", unit: "元", value: { "@call": "multiply", args: { values: [{ "@path": "/inputs/people" }, 30] } } }],
    dataModel: { inputs: { people: 2 } } } }] };
}
export const A2UI_AUTHORING_GUIDELINES = [
  `Use A2UI 1.0 and the registered catalog ${PIORA_A2UI_CATALOG}. Begin each complete submission with createSurface, optionally inline components and dataModel, then updateComponents/updateDataModel. The host publishes atomically after validation. Root ID is root; children are IDs in a bounded tree, every component reachable exactly once. Never include another protocol's fields, external catalog URLs, scripts, RPC or deleteSurface.`,
  "Use Row/Column/Card for actual layout, Text for prose, Divider for separators. Arrange controls compactly beside results where useful, and place comparisons in separate Cards inside a Row. The host applies its theme and responsive layout. Standard Button has child:TextId and action:{functionCall:{'@call':name,args:{...}}}.",
];
export function a2uiUiPrompt() {
  const decision = intelligentUiDecisionPrompt();
  return { ...decision, description: "Create or revise an interactive answer using A2UI 1.0. Supports native layouts, controls, local calculations, tables and charts. Use it when exploration helps and business facts are known. Use text for simple answers; clarify missing business rules. SVG, 3D, animation and dynamic lists use the A2UI mini-app tool.",
    promptSnippet: "Use piora_render_ui_plan with A2UI messages when interaction helps; answer directly or clarify otherwise",
    promptGuidelines: [...decision.promptGuidelines, ...A2UI_AUTHORING_GUIDELINES,
      "Submit {id,title,messages,actions?,conversion?}. No planVersion, inputs/derived/views/layout authoring fields. A2UI control value is {'@path':'/inputs/<inputId>'}; dataModel.inputs supplies exactly these initial scalars. Component IDs and input IDs are independent; each input is mounted by one control. Preserve stable IDs and acknowledged values when revising. Labels and bounds are literal; computations update locally. PioraNumber is the numeric default; Slider is only for justified continuous bounds, and steps means number of divisions (step size=(max-min)/steps). PioraChoice selects a string, CheckBox uses a boolean.",
      "Values are scalars, /inputs/id bindings, or {'@call':'add|subtract|multiply|divide|round|min|max|if|equals|lt|lte|gt|gte',args:{values:[...]}}. Every function uses ONLY args.values, never named condition/then/else or other arguments. if uses [condition,whenTrue,whenFalse]; comparisons/subtract/divide use [left,right]; round uses [number] or [number,digits]. if is lazy, equals is strict, comparisons are numeric. Text can use {'@call':'concat',args:{values:[literal prose,binding,calculation,...]}} for changing explanations. Never freeze calculated claims in literal prose.",
      "The official SDK permits at most FIVE nested @call levels, counting concat and if too. Keep formulas shallow; split long explanations across Text components or display separate labeled metrics instead of nesting multiple conditional paragraphs. Do not duplicate a deeply nested total inside several rounds/divisions/conditions. For deeper computation, use the mini-app tool with its separate deterministic program.",
      "Buttons in component answers may only call pioraSet with args:{input:'inputId',value:literalScalar}; values must satisfy that control. File actions still use the separate host declaration and approval workflow. Candidate publication, acknowledgements, conversion and field migration retain the host's existing semantics.",
      `Complete A2UI example; replace its business assumptions with the actual task: ${JSON.stringify(a2uiUiExample())}`,
    ] };
}
