import { boundedJson, exactKeys, jsonRecord, readId } from "./json";
import { MINI_APP_LIMITS, miniAppError } from "./limits";
import { MINI_APP_TRIANGLE_CONTRACT } from "./authoring-contract";
import { validateMiniAppAttribute, type MiniAppDocument } from "./document";
import { validateMiniAppRepeats, type MiniAppRepeatData } from "./repeat";
import { miniAppCameraReset, validateMiniAppCamera, type MiniAppCamera } from "./scene-state";

export interface MiniAppViewport { id: string; kind: "canvas2d" | "scene3d"; width: number; height: number; label: string; picking?: true; cameraControls?: true; groups?: true }
export type Vector3 = [number, number, number];
export interface CanvasCommand {
  kind: "rect" | "circle" | "line" | "path" | "text";
  x?: number; y?: number; width?: number; height?: number; radius?: number;
  x2?: number; y2?: number; d?: string; text?: string; fontSize?: number;
  fill?: string; stroke?: string; strokeWidth?: number;
}
export type MiniAppGeometry =
  | { kind: "box"; size: Vector3 }
  | { kind: "sphere"; radius: number; segments: number }
  | { kind: "cylinder"; radiusTop: number; radiusBottom: number; height: number; segments: number }
  | { kind: "plane"; width: number; height: number }
  | { kind: "mesh"; positions: number[]; indices?: number[] };
export interface MiniAppMesh {
  id: string; geometry: MiniAppGeometry; position: Vector3; rotation: Vector3; scale: Vector3;
  color: string; opacity?: number; label?: string; parent?: string;
}
export interface MiniAppSceneGroup { id: string; parent?: string; position: Vector3; rotation: Vector3; scale: Vector3 }
export interface MiniAppScene {
  camera: MiniAppCamera;
  cameraRevision?: number;
  selected?: string | null;
  meshes: MiniAppMesh[];
  groups?: MiniAppSceneGroup[];
}
export interface MiniAppFrame {
  summary: string;
  playback?: { finished: boolean };
  bindings: Record<string, string | number | boolean>;
  repeats?: MiniAppRepeatData;
  canvases?: Record<string, CanvasCommand[]>;
  scenes?: Record<string, MiniAppScene>;
}

export function miniAppColor(value: unknown, path: string): string {
  if (typeof value !== "string" || !/^(?:#[0-9a-fA-F]{3}|#[0-9a-fA-F]{6}|black|white|red|green|blue|orange|purple|gray|yellow|transparent)$/.test(value)) miniAppError("FRAME", path, "Expected a supported literal color");
  return value;
}
export function miniAppNumber(value: unknown, path: string, min = -10_000, max = 10_000): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) miniAppError("FRAME", path, "Number is outside the renderer range");
  return value;
}
function vector(value: unknown, path: string, min = -10_000, max = 10_000): Vector3 {
  if (!Array.isArray(value) || value.length !== 3) miniAppError("FRAME", path, "Expected a three-dimensional vector");
  return value.map((v, i) => miniAppNumber(v, `${path}/${i}`, min, max)) as Vector3;
}
function sceneGroups(value: unknown, path: string): MiniAppSceneGroup[] {
  if (!Array.isArray(value) || value.length > MINI_APP_LIMITS.sceneGroups) miniAppError("FRAME", path, "Expected at most 64 transform groups");
  const ids = new Map<string, MiniAppSceneGroup>();
  const groups = value.map((item, index) => {
    const p = `${path}/${index}`, group = jsonRecord(item, p);
    exactKeys(group, ["id", "parent", "position", "rotation", "scale"], p);
    const id = readId(group.id, `${p}/id`);
    if (ids.has(id)) miniAppError("FRAME", `${p}/id`, "Duplicate transform group id");
    const parsed: MiniAppSceneGroup = { id,
      ...(group.parent === undefined ? {} : { parent: readId(group.parent, `${p}/parent`) }),
      position: vector(group.position, `${p}/position`), rotation: vector(group.rotation, `${p}/rotation`, -100, 100),
      scale: vector(group.scale, `${p}/scale`, 0.001, 100) };
    ids.set(id, parsed); return parsed;
  });
  for (const [index, group] of groups.entries()) {
    const visited = new Set<string>(); let current: MiniAppSceneGroup | undefined = group;
    while (current) {
      if (visited.has(current.id)) miniAppError("FRAME", `${path}/${index}/parent`, "Transform group parents must not form a cycle");
      visited.add(current.id);
      if (visited.size > MINI_APP_LIMITS.sceneGroupDepth) miniAppError("FRAME", `${path}/${index}/parent`, "Transform group nesting exceeds 8 levels");
      if (current.parent !== undefined && !ids.has(current.parent)) miniAppError("FRAME", `${path}/${index}/parent`, "Transform group parent must exist in the same scene");
      current = current.parent === undefined ? undefined : ids.get(current.parent);
    }
  }
  return groups;
}
function geometry(value: unknown, path: string): { value: MiniAppGeometry; triangles: number } {
  const v = jsonRecord(value, path);
  const positive = (key: string) => miniAppNumber(v[key], `${path}/${key}`, 0.001, 1000);
  const segments = () => {
    const n = miniAppNumber(v.segments, `${path}/segments`, 4, 32);
    if (!Number.isInteger(n)) miniAppError("FRAME", path, "Segments must be an integer");
    return n;
  };
  if (v.kind === "box") { exactKeys(v,["kind","size"],path); return { value:{kind:"box",size:vector(v.size,`${path}/size`,0.001,1000)},triangles:12 }; }
  if (v.kind === "sphere") { exactKeys(v,["kind","radius","segments"],path); const n=segments(); return {value:{kind:"sphere",radius:positive("radius"),segments:n},triangles:2*n*(n-1)}; }
  if (v.kind === "cylinder") {
    exactKeys(v,["kind","radiusTop","radiusBottom","height","segments"],path); const n=segments();
    return {value:{kind:"cylinder",radiusTop:miniAppNumber(v.radiusTop,path,0,1000),radiusBottom:miniAppNumber(v.radiusBottom,path,0,1000),height:positive("height"),segments:n},triangles:4*n};
  }
  if (v.kind === "plane") { exactKeys(v,["kind","width","height"],path); return {value:{kind:"plane",width:positive("width"),height:positive("height")},triangles:2}; }
  if (v.kind !== "mesh") miniAppError("FRAME", path, "Unsupported geometry");
  exactKeys(v,["kind","positions","indices"],path);
  if (!Array.isArray(v.positions) || v.positions.length < 9 || v.positions.length % 3 || v.positions.length > 150_000) miniAppError("FRAME", path, "Invalid vertex data");
  const positions = v.positions.map((n,i)=>miniAppNumber(n,`${path}/positions/${i}`));
  if (v.indices !== undefined) {
    if (!Array.isArray(v.indices) || !v.indices.length || v.indices.length % 3 || v.indices.length > 150_000) miniAppError("FRAME",`${path}/indices`,"Expected a nonempty flat array of at most 150000 triangle indices, in groups of 3");
    const indices=v.indices.map((n,i)=>{ const id=miniAppNumber(n,`${path}/indices/${i}`,0,positions.length/3-1); if(!Number.isInteger(id)) miniAppError("FRAME",path,"Indices must be integers"); return id; });
    return {value:{kind:"mesh",positions,indices},triangles:indices.length/3};
  }
  if (positions.length % 9) miniAppError("FRAME",`${path}/positions`,`Unindexed geometry has ${positions.length / 3} vertices (${positions.length} numbers), which cannot form complete triangles. ${MINI_APP_TRIANGLE_CONTRACT}`);
  return {value:{kind:"mesh",positions},triangles:positions.length/9};
}

export function validateMiniAppFrame(value: unknown, document: MiniAppDocument, viewports: readonly MiniAppViewport[]): MiniAppFrame {
  boundedJson(value, MINI_APP_LIMITS.frameBytes);
  const v=jsonRecord(value,"frame"); exactKeys(v,["summary","bindings","canvases","scenes","playback","repeats"],"frame");
  const repeats=validateMiniAppRepeats(v.repeats,document,validateMiniAppAttribute);
  let playback: MiniAppFrame["playback"];
  if(v.playback!==undefined) {
    const p=jsonRecord(v.playback,"frame/playback");exactKeys(p,["finished"],"frame/playback");
    if(typeof p.finished!=="boolean")miniAppError("FRAME","frame/playback/finished","Expected a boolean completion flag");
    playback={finished:p.finished};
  }
  if(typeof v.summary!=="string" || !v.summary.trim() || v.summary.length>4000) miniAppError("FRAME","frame/summary","A readable current result is required");
  const sourceBindings=jsonRecord(v.bindings,"frame/bindings"), bindings:MiniAppFrame["bindings"]={};
  for(const [key,item] of Object.entries(sourceBindings)) {
    readId(key,"frame/bindings");
    if(!["string","number","boolean"].includes(typeof item) || typeof item==="number"&&!Number.isFinite(item) || typeof item==="string"&&item.length>16_000) miniAppError("FRAME",`frame/bindings/${key}`,"Expected a finite scalar binding");
    bindings[key]=item as string|number|boolean;
  }
  for(const binding of document.bindings) {
    if(!Object.hasOwn(bindings,binding.id)) miniAppError("BINDING",`frame/bindings/${binding.id}`,"Missing required binding");
    if(binding.attribute) validateMiniAppAttribute(binding.attribute,String(bindings[binding.id]));
  }
  const canvases:Record<string,CanvasCommand[]>={}, scenes:Record<string,MiniAppScene>={};
  let commands=0, meshes=0, triangles=0, groupCount=0;
  for(const [id,data] of Object.entries(v.canvases===undefined?{}:jsonRecord(v.canvases,"frame/canvases"))) {
    if(!viewports.some(view=>view.id===id&&view.kind==="canvas2d") || !Array.isArray(data)) miniAppError("FRAME",`frame/canvases/${id}`,"Unknown canvas");
    canvases[id]=data.map((item,i)=>{
      if(++commands>MINI_APP_LIMITS.drawingCommands) miniAppError("LIMIT","frame/canvases","Too many drawing commands");
      const p=`frame/canvases/${id}/${i}`, c=jsonRecord(item,p);
      if(!["rect","circle","line","path","text"].includes(String(c.kind))) miniAppError("FRAME",p,"Unknown drawing command");
      const fields:Record<string,string[]>={rect:["x","y","width","height"],circle:["x","y","radius"],line:["x","y","x2","y2"],path:["d"],text:["x","y","text","fontSize"]};
      exactKeys(c,["kind","fill","stroke","strokeWidth",...fields[String(c.kind)]],p);
      for(const field of fields[String(c.kind)]) {
        if(field==="d") {if(typeof c.d!=="string") miniAppError("FRAME",p,"Expected SVG path data");validateMiniAppAttribute("d",c.d);}
        else if(field==="text") {if(typeof c.text!=="string"||c.text.length>1000) miniAppError("FRAME",p,"Drawing text is too long");}
        else miniAppNumber(c[field],`${p}/${field}`,["width","height","radius","fontSize"].includes(field)?0:-10_000,field==="fontSize"?64:10_000);
      }
      if(c.fill!==undefined)miniAppColor(c.fill,p);
      if(c.stroke!==undefined)miniAppColor(c.stroke,p);
      if(c.strokeWidth!==undefined)miniAppNumber(c.strokeWidth,p,0,32);
      return c as unknown as CanvasCommand;
    });
  }
  for(const [id,data] of Object.entries(v.scenes===undefined?{}:jsonRecord(v.scenes,"frame/scenes"))) {
    if(!viewports.some(view=>view.id===id&&view.kind==="scene3d"))miniAppError("FRAME",`frame/scenes/${id}`,"Unknown 3D view");
    const viewport=viewports.find(view=>view.id===id)!;
    const s=jsonRecord(data,`frame/scenes/${id}`);exactKeys(s,["camera","meshes","cameraRevision","selected","groups"],"scene");
    if (s.groups !== undefined && !viewport.groups) miniAppError("FRAME", `frame/scenes/${id}/groups`, "Transform groups require groups:true on this scene3d viewport");
    const groups = s.groups === undefined ? undefined : sceneGroups(s.groups, `frame/scenes/${id}/groups`);
    groupCount += groups?.length ?? 0;
    if (groupCount > MINI_APP_LIMITS.sceneGroups) miniAppError("LIMIT", "frame/scenes", "Transform group budget exceeded across scenes");
    const groupIds = new Set(groups?.map(group => group.id));
    if(s.cameraRevision!==undefined&&!viewport.cameraControls)miniAppError("FRAME","cameraRevision","Camera reset requires declared camera controls");
    const c=jsonRecord(s.camera,"camera");exactKeys(c,["position","target","fov"],"camera");
    const camera={position:vector(c.position,"camera/position"),target:vector(c.target,"camera/target"),fov:miniAppNumber(c.fov,"camera/fov",15,90)};
    if(camera.position.every((n,i)=>n===camera.target[i]))miniAppError("FRAME","camera","Camera position and target must differ");
    if(viewport.cameraControls)validateMiniAppCamera(camera);
    if(!Array.isArray(s.meshes))miniAppError("FRAME","meshes","Expected meshes");
    const ids=new Set<string>();
    const entries=s.meshes.map((item, meshIndex)=>{
      if(++meshes>MINI_APP_LIMITS.meshes)miniAppError("LIMIT","meshes","Too many 3D objects");
      const m=jsonRecord(item,"mesh");exactKeys(m,["id","geometry","position","rotation","scale","color","opacity","label","parent"],"mesh");
      if(m.label!==undefined&&(typeof m.label!=="string"||!m.label.trim()||m.label.length>160))miniAppError("FRAME","mesh/label","Expected a short object label");
      if(viewport.picking&&m.label===undefined)miniAppError("FRAME","mesh/label","Selectable objects require readable labels");
      const meshId=readId(m.id,"mesh/id");if(ids.has(meshId))miniAppError("FRAME","mesh/id","Duplicate mesh id");ids.add(meshId);
      if (groupIds.has(meshId)) miniAppError("FRAME", `frame/scenes/${id}/meshes/${meshIndex}/id`, "Meshes and transform groups must have distinct ids");
      const parent = m.parent === undefined ? undefined : readId(m.parent, `frame/scenes/${id}/meshes/${meshIndex}/parent`);
      if (parent !== undefined && (!viewport.groups || !groupIds.has(parent))) miniAppError("FRAME", `frame/scenes/${id}/meshes/${meshIndex}/parent`, "Mesh parent requires a declared transform group in this scene");
      const g=geometry(m.geometry,`frame/scenes/${id}/meshes/${meshIndex}/geometry`);triangles+=g.triangles;
      if(triangles>MINI_APP_LIMITS.triangles)miniAppError("LIMIT","meshes","Triangle budget exceeded");
      return {id:meshId,geometry:g.value,position:vector(m.position,"mesh/position"),rotation:vector(m.rotation,"mesh/rotation",-100,100),scale:vector(m.scale,"mesh/scale",0.001,100),color:miniAppColor(m.color,"mesh/color"),...(m.opacity===undefined?{}:{opacity:miniAppNumber(m.opacity,"mesh/opacity",0,1)}),...(m.label===undefined?{}:{label:m.label as string}),...(parent===undefined?{}:{parent})};
    });
    if(viewport.picking&&(s.selected!==null&&(typeof s.selected!=="string"||!ids.has(s.selected))))miniAppError("FRAME","scene/selected","Selectable scenes must report selected as a current object id or null");
    if(s.selected!==undefined&&!viewport.picking)miniAppError("FRAME","scene/selected","Selection requires declared picking");
    scenes[id]={camera,meshes:entries,...(groups===undefined?{}:{groups}),...(s.cameraRevision===undefined?{}:{cameraRevision:miniAppCameraReset(s.cameraRevision)}),...(s.selected===undefined?{}:{selected:s.selected as string|null})};
  }
  for(const viewport of viewports)if(!(viewport.id in (viewport.kind==="canvas2d"?canvases:scenes)))miniAppError("FRAME",viewport.id,"Every viewport requires a frame");
  return {summary:v.summary,bindings,...(Object.keys(repeats).length?{repeats}:{}),...(playback?{playback}:{}),...(Object.keys(canvases).length?{canvases}:{}),...(Object.keys(scenes).length?{scenes}:{})};
}
