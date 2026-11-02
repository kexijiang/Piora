import type { MiniAppPlan1 } from "./plan";

/** Executable protocol example with explicit coordinate/rotation conventions. */
export function miniAppSceneExample(): MiniAppPlan1 {
  return {
    planVersion: 1, id: "aircraft-orientation", title: "飞机姿态与空间坐标", purpose: "旋转飞机，理解三个轴的作用；选择对象并保存观察镜头。",
    assumptions: ["右手坐标系：X 向右、Y 向上，机头初始朝 -Z。角度采用 Three.js 的 XYZ 欧拉旋转约定，不模拟飞行动力学。"],
    playback: { mode: "none" },
    inputs: ["pitch", "yaw", "roll"].map((id, i) => ({ id, type: "number" as const, label: ["绕 X 轴（俯仰）", "绕 Y 轴（偏航）", "绕 Z 轴（横滚）"][i], meaning: "右手系角度，单位度", value: 0, min: -180, max: 180, step: 1 })),
    stateSchema: { type: "object", properties: { selected: { type: "string", maxLength: 20, enum: ["", "aircraft", "xAxis", "yAxis", "zAxis"] }, cameraRevision: { type: "integer", minimum: 0, maximum: 1000000 } }, required: ["selected", "cameraRevision"], additionalProperties: false },
    document: {
      html: '<section><h2>飞机姿态与空间坐标</h2><p>改角度观察机头和机翼；拖动旋转视角，滚轮缩放，也可用下方按钮。选择飞机或坐标轴查看说明。</p><div class="angles"><label>绕 X 轴（度）<input data-input="pitch" type="number" aria-label="俯仰角"></label><label>绕 Y 轴（度）<input data-input="yaw" type="number" aria-label="偏航角"></label><label>绕 Z 轴（度）<input data-input="roll" type="number" aria-label="横滚角"></label></div><div data-viewport="airspace"></div><p data-text="selection"></p><p data-text="angles"></p><button data-event="cameraReset">重新观察初始视角</button><p>右手系：X 向右，Y 向上，机头初始朝 -Z。使用 XYZ 欧拉旋转约定；坐标轴保持固定。</p></section>',
      css: 'section{display:grid;gap:12px}.angles{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}label{display:grid;gap:4px}p{color:var(--text-muted)}[data-viewport]{border:1px solid var(--border);border-radius:12px;background:var(--bg-panel)}',
    },
    viewports: [{ id: "airspace", kind: "scene3d", width: 640, height: 380, label: "飞机与坐标轴", picking: true, cameraControls: true }],
    program: `
function init(inputs,ctx){return {selected:"",cameraRevision:0};}
function reduce(state,event,ctx){
  if(event.type==="scene-pick"&&event.id==="airspace")return {...state,selected:event.object||""};
  if(event.type==="click"&&event.id==="cameraReset")return {...state,cameraRevision:state.cameraRevision+1};
  return state;
}
function advance(state,dt,ctx){return state;}
function project(state,inputs,ctx){
  const names={aircraft:"飞机",xAxis:"X 轴（红色）",yAxis:"Y 轴（绿色）",zAxis:"Z 轴（蓝色）"};
  const selection=state.selected?"已选择："+names[state.selected]:"尚未选择对象";
  const angles="X："+inputs.pitch+"°，Y："+inputs.yaw+"°，Z："+inputs.roll+"°";
  return {summary:selection+"。"+angles,bindings:{selection:selection,angles:angles},scenes:{airspace:{
    camera:{position:[5,4,6],target:[0,0,0],fov:45},cameraRevision:state.cameraRevision,selected:state.selected||null,
    meshes:[
      {id:"aircraft",label:"飞机",geometry:{kind:"mesh",positions:[0,0,-2,-.28,0,1,.28,0,1, -2,0,.3,2,0,.3,0,0,-.5, -.8,0,1.2,.8,0,1.2,0,0,.7, 0,0,.7,0,.6,1.2,0,0,1.2]},position:[0,0,0],rotation:[inputs.pitch*Math.PI/180,inputs.yaw*Math.PI/180,inputs.roll*Math.PI/180],scale:[1,1,1],color:state.selected==="aircraft"?"#e8a838":"#246a84"},
      {id:"xAxis",label:"X 轴",geometry:{kind:"box",size:[6,.035,.035]},position:[0,0,0],rotation:[0,0,0],scale:[1,1,1],color:"#c74444"},
      {id:"yAxis",label:"Y 轴",geometry:{kind:"box",size:[.035,6,.035]},position:[0,0,0],rotation:[0,0,0],scale:[1,1,1],color:"#378352"},
      {id:"zAxis",label:"Z 轴",geometry:{kind:"box",size:[.035,.035,6]},position:[0,0,0],rotation:[0,0,0],scale:[1,1,1],color:"#4268c4"}
    ]}}};
}`,
    initialSnapshot: "飞机尚未旋转，未选择对象。",
  };
}
