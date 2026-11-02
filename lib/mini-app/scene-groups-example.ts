import type { MiniAppPlan1 } from "./plan";

/** A connected assembly and an independent joint, not task-specific geometry. */
export function miniAppSceneGroupsExample(): MiniAppPlan1 {
  return {
    planVersion: 1, id: "joint-demo", title: "组合结构与关节", purpose: "观察整体旋转和局部关节旋转的区别", assumptions: ["示意模型，角度以度输入，场景采用右手坐标系"],
    playback: { mode: "none" },
    inputs: [
      { id: "bodyAngle", type: "number", label: "整体绕 Z 轴", meaning: "整体结构绕场景原点的角度（度）", value: 0, min: -180, max: 180, step: 1 },
      { id: "jointAngle", type: "number", label: "关节绕 Z 轴", meaning: "关节相对整体结构的局部角度（度）", value: 0, min: -180, max: 180, step: 1 },
    ],
    stateSchema: { type: "object", properties: {
      selected: { type: "string", maxLength: 4, enum: ["", "body", "arm", "tip"] },
      cameraRevision: { type: "integer", minimum: 0, maximum: 1000000 },
    }, required: ["selected", "cameraRevision"], additionalProperties: false },
    document: { html: '<section><h2>整体与局部旋转</h2><label>整体绕 Z 轴<input type="number" data-input="bodyAngle"></label><label>关节绕 Z 轴<input type="number" data-input="jointAngle"></label><div data-viewport="assembly"></div><p data-text="result"></p><button data-event="cameraReset">恢复观察视角</button></section>', css: 'section{display:flex;flex-direction:column;gap:12px}label{display:flex;gap:8px;align-items:center}' },
    viewports: [{ id: "assembly", kind: "scene3d", label: "组合结构", width: 400, height: 300, picking: true, cameraControls: true, groups: true }],
    initialSnapshot: "整体和关节均为 0°，部件连接并可独立选择。",
    program: `function init(inputs,ctx){return {selected:"",cameraRevision:0};}
function reduce(state,event,ctx){if(event.type==="scene-pick")state.selected=event.object||"";if(event.type==="click"&&event.id==="cameraReset")state.cameraRevision=(state.cameraRevision+1)%1000001;return state;}
function advance(state,dt,ctx){return state;}
function project(state,inputs,ctx){
  const text="整体 "+inputs.bodyAngle+"°，关节 "+inputs.jointAngle+"°；选中："+(state.selected||"无");
  return {summary:text,bindings:{result:text},scenes:{assembly:{camera:{position:[0,0,9],target:[0,0,0],fov:45},cameraRevision:state.cameraRevision,selected:state.selected||null,
    groups:[{id:"root",position:[0,0,0],rotation:[0,0,inputs.bodyAngle*Math.PI/180],scale:[1,1,1]},
      {id:"joint",parent:"root",position:[1.5,0,0],rotation:[0,0,inputs.jointAngle*Math.PI/180],scale:[1,1,1]}],
    meshes:[{id:"body",label:"主体",parent:"root",geometry:{kind:"box",size:[3,0.5,0.5]},position:[0,0,0],rotation:[0,0,0],scale:[1,1,1],color:"#246a84"},
      {id:"arm",label:"活动臂",parent:"joint",geometry:{kind:"box",size:[2,0.3,0.3]},position:[1,0,0],rotation:[0,0,0],scale:[1,1,1],color:"#c74444"},
      {id:"tip",label:"末端",parent:"joint",geometry:{kind:"sphere",radius:0.25,segments:12},position:[2,0,0],rotation:[0,0,0],scale:[1,1,1],color:"#378352"}]
  }}};
}`,
  };
}
