import { PIORA_A2UI_CATALOG } from "./catalog";

/** Two original schematic assets exercise the same catalog/runtime contract.
 * They are teaching diagrams, not dimensionally accurate engineering drawings. */
export function a2uiExplodedExample(kind: "bike" | "fan" = "bike") {
  const parts = kind === "bike" ? [
    { name: "后轮", x: -65, y: 25, svg: '<circle cx="140" cy="220" r="65" fill="none" stroke="#334155" stroke-width="8"/>' },
    { name: "前轮", x: 70, y: 25, svg: '<circle cx="400" cy="220" r="65" fill="none" stroke="#334155" stroke-width="8"/>' },
    { name: "车架", x: 0, y: -20, svg: '<path d="M140 220 L210 120 L270 220 Z M210 120 L350 120 L270 220 M350 120 L400 220" fill="none" stroke="#32816a" stroke-width="12"/>' },
    { name: "座椅", x: -25, y: -65, svg: '<path d="M210 120 L200 90 M175 88 L225 88" fill="none" stroke="#334155" stroke-width="10"/>' },
    { name: "车把", x: 45, y: -65, svg: '<path d="M350 120 L340 78 L370 78" fill="none" stroke="#334155" stroke-width="9"/>' },
  ] : [
    { name: "底座", x: 0, y: 55, svg: '<rect x="185" y="275" width="190" height="20" rx="10" fill="#334155"/>' },
    { name: "支架", x: -90, y: 10, svg: '<rect x="268" y="175" width="24" height="105" rx="10" fill="#32816a"/>' },
    { name: "风叶", x: 100, y: -20, svg: '<circle cx="280" cy="150" r="18" fill="#334155"/><path d="M280 150 Q225 30 210 135 Z M280 150 Q405 155 320 215 Z M280 150 Q195 245 238 170 Z" fill="#32816a"/>' },
    { name: "网罩", x: 0, y: -75, svg: '<circle cx="280" cy="150" r="85" fill="none" stroke="#94a3b8" stroke-width="5"/>' },
  ];
  const id = `${kind}-assembly`, title = kind === "bike" ? "自行车拆解示意" : "风扇拆解示意";
  const svg = `<svg viewBox="0 0 560 380" width="560" height="380" role="img" aria-label="${title}">${parts.map((part, i) => `<g data-bind="transform:move${i};opacity:opacity${i}">${part.svg}</g>`).join("")}</svg>`;
  return { planVersion: 1, id, title, purpose: "查看部件位置、拆解过程及选中部件", assumptions: ["简化的二维教学示意，不代表真实装配尺寸或维修步骤"],
    inputs: [{ id: "part", label: "查看部件", meaning: "高亮选择的部件，其余部件变淡", type: "select", value: "全部", options: ["全部", ...parts.map(part => part.name)].map(value => ({ value, label: value })) }],
    stateSchema: { type: "number", minimum: 0, maximum: 1 }, playback: { mode: "continuous" }, viewports: [],
    document: { messages: [{ version: "1.0", createSurface: { surfaceId: id, catalogId: PIORA_A2UI_CATALOG, dataModel: { inputs: { part: "全部" } }, components: [
      { id: "root", component: "Column", children: ["picture", "part", "status", "buttons"] },
      { id: "picture", component: "PioraSvg", markup: svg },
      { id: "part", component: "PioraChoice", label: "查看部件", value: { "@path": "/inputs/part" }, options: ["全部", ...parts.map(part => part.name)] },
      { id: "status", component: "Text", text: { "@path": "/frame/status" } },
      { id: "buttons", component: "Row", children: ["explode", "assemble"] },
      ...[{ id: "explode", label: "完全展开" }, { id: "assemble", label: "组装复位" }].flatMap(action => [
        { id: action.id, component: "Button", child: `${action.id}Label`, action: { functionCall: { "@call": "pioraEvent", args: { id: action.id } } } },
        { id: `${action.id}Label`, component: "Text", text: action.label },
      ]),
    ] } }] },
    program: `function init(){return 0;} function reduce(s,e){return e.type==='click'&&e.id==='explode'?1:e.type==='click'&&e.id==='assemble'?0:s;} function advance(s,dt){return Math.min(1,s+dt/3);}
function project(s,inputs){var parts=${JSON.stringify(parts.map(({ name, x, y }) => ({ name, x, y })))};var bindings={status:'展开 '+Math.round(s*100)+'% · '+inputs.part};for(var i=0;i<parts.length;i++){bindings['move'+i]='translate('+parts[i].x*s+' '+parts[i].y*s+')';bindings['opacity'+i]=inputs.part==='全部'||inputs.part===parts[i].name?1:0.2;}return {summary:bindings.status,bindings:bindings,playback:{finished:s>=1}};}`,
    initialSnapshot: "从组装状态开始，播放可逐渐展开；可选择部件、完全展开或复位。" };
}
