/** Trusted iframe entry. This module is bundled as an app asset, never generated. */
import { validateMiniAppFrame, type CanvasCommand, type MiniAppViewport } from "./frame";
import { type MiniAppDocument, type MiniAppDocumentNode } from "./document";
import { boundedJson, type JsonRecord } from "./json";
import { MINI_APP_LIMITS } from "./limits";
import { applyMiniAppAppearance, applyMiniAppFonts } from "./appearance";
import { MiniAppRepeatRenderer } from "./repeat-renderer";
import { MiniAppSceneRenderer } from "./scene-renderer";
import type { MiniAppViewState } from "./scene-state";
import { MINI_APP_RENDERER_PROTOCOL } from "./environment-protocol";

interface Mount { document: MiniAppDocument; inputs: JsonRecord; viewports: MiniAppViewport[]; readOnly?: boolean; view?: MiniAppViewState; language?: string }
const root = document.getElementById("mini-app-root")!;
const nonce = root.dataset.instance;
delete root.dataset.instance;
let channel: MessagePort | undefined;
let mounted: Mount | undefined;
let disposed = false;
let sequence = 0;
let lastHeight = 0;
const controls = new Map<string, HTMLInputElement | HTMLSelectElement>();
const pendingControls = new Map<string, number>();
const texts = new Map<string, Element[]>();
const attributes: Array<{ element: Element; attribute: string; id: string }> = [];
const canvases = new Map<string, HTMLCanvasElement>();
const scenes = new Map<string, MiniAppSceneRenderer>();
const sceneInteractionTargets = new WeakSet<Element>();
const repeats = new Map<string, MiniAppRepeatRenderer>();
let rowSerial = 0;
let sceneEpoch = 0;
const style = document.createElement("style"); document.head.append(style);
let graphicsProbe:WebGL2RenderingContext|undefined;

function probeGraphics():boolean {
  if(graphicsProbe&&!graphicsProbe.isContextLost())return true;
  const canvas=document.createElement("canvas");canvas.width=2;canvas.height=2;
  const gl=canvas.getContext("webgl2",{alpha:true,antialias:true,powerPreference:"low-power"});
  if(!gl)return false;
  canvas.addEventListener("webglcontextlost",event=>{
    event.preventDefault();if(!disposed&&graphicsProbe===gl)send({type:"environment",report:{protocol:MINI_APP_RENDERER_PROTOCOL,webgl:false}});
  });
  gl.clearColor(.25,.5,.75,1);gl.clear(gl.COLOR_BUFFER_BIT);const pixel=new Uint8Array(4);
  gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixel);
  const ready=!gl.isContextLost()&&gl.getError()===gl.NO_ERROR&&pixel[0]>=60&&pixel[0]<=68&&pixel[1]>=124&&pixel[1]<=132&&pixel[2]>=187&&pixel[2]<=195&&pixel[3]===255;
  if(ready)graphicsProbe=gl;else gl.getExtension("WEBGL_lose_context")?.loseContext();
  return ready;
}

function send(value: unknown) {
  if (!disposed) channel?.postMessage(boundedJson(value, 16_384));
}
const resize = new ResizeObserver(() => {
  // documentElement.scrollHeight includes the current iframe viewport, which
  // prevents a short document from ever shrinking below its initial height.
  const height = Math.min(1600, Math.max(80, Math.ceil(Math.max(root.scrollHeight, root.getBoundingClientRect().height))));
  if (height !== lastHeight) { lastHeight = height; send({type:"height",height}); }
});
resize.observe(root);


function draw(canvas: HTMLCanvasElement, commands: CanvasCommand[]) {
  const context=canvas.getContext("2d");if(!context)throw new Error("CANVAS_UNAVAILABLE");
  context.clearRect(0,0,canvas.width,canvas.height);
  for(const command of commands) {
    context.save();context.fillStyle=command.fill??"#246A84";context.strokeStyle=command.stroke??"#246A84";context.lineWidth=command.strokeWidth??1;context.beginPath();
    if(command.kind==="rect")context.rect(command.x!,command.y!,command.width!,command.height!);
    else if(command.kind==="circle")context.arc(command.x!,command.y!,command.radius!,0,2*Math.PI);
    else if(command.kind==="line"){context.moveTo(command.x!,command.y!);context.lineTo(command.x2!,command.y2!);context.stroke();}
    else if(command.kind==="text"){context.font=`${command.fontSize}px system-ui`;context.fillText(command.text!,command.x!,command.y!);}
    else if(command.kind==="path"){const path=new Path2D(command.d!);if(command.fill)context.fill(path);if(command.stroke)context.stroke(path);}
    if(command.kind==="rect"||command.kind==="circle"){if(command.fill!=="transparent")context.fill();if(command.stroke)context.stroke();}
    context.restore();
  }
}

function element(node: MiniAppDocumentNode): Node {
  if(node.type==="text")return document.createTextNode(node.text);
  const target=node.svg?document.createElementNS("http://www.w3.org/2000/svg",node.tag):document.createElement(node.tag);
  // Retain validated binding labels for CSS. Event dispatch still uses the
  // compiled bindings and trusted native events, never mutable DOM attributes.
  for(const [name,value] of Object.entries(node.attrs))if(!name.startsWith("data-")||["data-input","data-event","data-viewport","data-text","data-repeat","data-preset"].includes(name))target.setAttribute(name,value);
  if(node.attrs["data-repeat"]) {
    const id=node.attrs["data-repeat"], definition=mounted!.document.repeats!.find(item=>item.id===id)!;
    repeats.set(id,new MiniAppRepeatRenderer(target as HTMLElement,definition,()=>++rowSerial,event=>send({type:"event",event})));
  }
  if(node.attrs["data-text"]){const id=node.attrs["data-text"];texts.set(id,[...(texts.get(id)??[]),target]);}
  for(const binding of (node.attrs["data-bind"]??"").split(";").filter(Boolean)){const [attribute,id]=binding.trim().split(":");attributes.push({element:target,attribute,id});}
  const inputId=node.attrs["data-input"];
  if(inputId) {
    const input=target as HTMLInputElement|HTMLSelectElement;controls.set(inputId,input);
    if(!input.hasAttribute("aria-label"))input.setAttribute("aria-label",inputId);
    input.addEventListener("input",event=>{
      if(!event.isTrusted)return;
      const value=input instanceof HTMLInputElement&&input.type==="checkbox"?input.checked:input instanceof HTMLInputElement&&["number","range"].includes(input.type)?input.value===""?null:Number(input.value):input.value;
      if(value===null||typeof value==="number"&&!Number.isFinite(value))return;
      const serial=++rowSerial;pendingControls.set(inputId,serial);
      send({type:"event",event:{type:"input",id:inputId,value,serial}});
    });
  }
  const eventId=node.attrs["data-event"];
  if(eventId)bindEvents(target,eventId);
  const presetId=node.attrs["data-preset"];
  if(presetId)target.addEventListener("click",event=>{
    if(event.isTrusted&&!root.inert)send({type:"event",event:{type:"input-preset",id:presetId}});
  });
  for(const child of node.children)target.append(element(child));
  const viewportId=node.attrs["data-viewport"];
  if(viewportId) {
    const view=mounted!.viewports.find(v=>v.id===viewportId)!;
    // Layout previews never allocate GPU contexts or execute generated code.
    if(mounted!.readOnly) {
      const placeholder=document.createElement("div");
      placeholder.setAttribute("role","img");placeholder.setAttribute("aria-label",view.label);
      placeholder.textContent=view.label;
      placeholder.style.cssText=`height:${Math.min(view.height,320)}px;display:grid;place-items:center;border:1px dashed var(--border);background:var(--bg-panel);color:var(--text-muted);border-radius:8px`;
      target.append(placeholder);return target;
    }
    const canvas=target instanceof HTMLCanvasElement?target:document.createElement("canvas");
    canvas.width=view.width;canvas.height=view.height;canvas.style.maxWidth="100%";canvas.style.height="auto";canvas.setAttribute("aria-label",view.label);canvas.setAttribute("role","img");
    if(canvas!==target)target.append(canvas);
    if(view.kind==="scene3d") {
      canvas.style.marginInline="auto";
      if(view.picking||view.cameraControls)sceneInteractionTargets.add(target);
      const scene=new MiniAppSceneRenderer(canvas,view,event=>{
        if(event.type==="scene-pick") { const serial=++rowSerial;send({type:"event",event:{...event,serial}});return serial; }
        send({type:"event",event:event.type==="scene-camera"?{...event,epoch:sceneEpoch}:event});
      },()=>send({type:"error",code:"CONTEXT_LOST"}),mounted!.view?.cameras[viewportId],mounted!.language);
      scenes.set(viewportId,scene);queueMicrotask(()=>scene.attach());
    } else canvases.set(viewportId,canvas);
  }
  return target;
}

let pointerTimer: ReturnType<typeof setTimeout>|undefined;
let pointerValue: unknown;
const capturedPointers = new Map<number, { target: Element; id: string; x: number; y: number }>();
const heldKeys = new Set<string>();
function flushPointer() {
  if(!pointerTimer)return;
  clearTimeout(pointerTimer);pointerTimer=undefined;
  send(pointerValue);pointerValue=undefined;
}
function releaseInputState(notify = true) {
  if(notify)for(const scene of scenes.values())scene.release();
  if (notify) flushPointer();
  else { if(pointerTimer)clearTimeout(pointerTimer);pointerTimer=undefined;pointerValue=undefined; }
  const pointers = [...capturedPointers]; capturedPointers.clear(); heldKeys.clear();
  for (const [pointerId, { target }] of pointers) {
    try { if(target.hasPointerCapture(pointerId))target.releasePointerCapture(pointerId); } catch { /* The browser may already have released this pointer. */ }
  }
  if (notify) send({type:"event",event:{type:"blur"}});
}
const eventTargets = new WeakSet<Element>();
function bindEvents(target: Element,id: string) {
  eventTargets.add(target);
  target.addEventListener("focusout",()=>{
    if([...heldKeys].some(key=>key.startsWith(id+"\0"))||[...capturedPointers.values()].some(pointer=>pointer.target===target))releaseInputState();
  });
  const owns=(event:Event)=>!event.composedPath().some(node=>node instanceof Element&&sceneInteractionTargets.has(node))&&event.composedPath().find(node=>node instanceof Element&&eventTargets.has(node))===target;
  target.addEventListener("click",event=>{if(event.isTrusted&&owns(event))send({type:"event",event:{type:"click",id}});});
  const point=(event:PointerEvent)=>{
    const svg=target instanceof SVGElement?(target instanceof SVGSVGElement?target:target.ownerSVGElement):null;
    const canvas=target instanceof HTMLCanvasElement?target:target.querySelector("canvas");
    const bounds=(svg??canvas??target).getBoundingClientRect();const view=svg?.viewBox.baseVal;
    return {x:(event.clientX-bounds.left)/Math.max(1,bounds.width)*(view?.width??canvas?.width??bounds.width)+(view?.x??0),y:(event.clientY-bounds.top)/Math.max(1,bounds.height)*(view?.height??canvas?.height??bounds.height)+(view?.y??0)};
  };
  for(const name of ["pointerdown","pointermove","pointerup","pointercancel"] as const)target.addEventListener(name,(event:Event)=>{
    if(!event.isTrusted||!owns(event))return;const pointer=event as PointerEvent;
    const position=point(pointer);
    if(name==="pointerdown"){target.setPointerCapture(pointer.pointerId);capturedPointers.set(pointer.pointerId,{target,id,...position});}
    else if(name==="pointermove"&&capturedPointers.has(pointer.pointerId))capturedPointers.set(pointer.pointerId,{target,id,...position});
    else if(name==="pointerup"||name==="pointercancel")capturedPointers.delete(pointer.pointerId);
    const value={type:"event",event:{type:name,id,...position,buttons:pointer.buttons}};
    if(name==="pointermove") {pointerValue=value;if(!pointerTimer)pointerTimer=setTimeout(flushPointer,1000/MINI_APP_LIMITS.framesPerSecond);}
    else {flushPointer();send(value);}
  });
  target.addEventListener("lostpointercapture",event=>{
    const pointer=event as PointerEvent, held=capturedPointers.get(pointer.pointerId);
    if(!held||held.target!==target)return;
    capturedPointers.delete(pointer.pointerId);flushPointer();
    send({type:"event",event:{type:"pointercancel",id:held.id,x:held.x,y:held.y,buttons:0}});
  });
  for(const type of ["keydown","keyup"] as const)target.addEventListener(type,(event:Event)=>{
    const keyboard=event as KeyboardEvent;if(!keyboard.isTrusted||!owns(event)||keyboard.key.length>32||keyboard.ctrlKey||keyboard.metaKey||keyboard.altKey)return;
    const key=id+"\0"+keyboard.key;
    if(type==="keydown"){if(keyboard.repeat&&!heldKeys.has(key))return;heldKeys.add(key);}
    else heldKeys.delete(key);
    if(["ArrowLeft","ArrowRight","ArrowUp","ArrowDown"," "].includes(keyboard.key))keyboard.preventDefault();
    send({type:"event",event:{type,id,key:keyboard.key,repeat:keyboard.repeat}});
  });
}

function clear() {
  releaseInputState(false);
  for(const scene of scenes.values())scene.dispose();scenes.clear();canvases.clear();controls.clear();texts.clear();attributes.length=0;
  repeats.clear();rowSerial=0;sceneEpoch=0;
  if(pointerTimer)clearTimeout(pointerTimer);pointerTimer=undefined;pointerValue=undefined;root.replaceChildren();
}
function updateInputs(inputs:JsonRecord,acknowledged=rowSerial) {
  for(const [id,target] of controls) {
    // An older projection must not rewind native typing or keyboard selection.
    // All events share the host's ordered serial space; coalescing acknowledges
    // the newest event only once its result is installed.
    if((pendingControls.get(id)??0)>acknowledged)continue;
    pendingControls.delete(id);
    const value=inputs[id];
    if(target instanceof HTMLInputElement&&target.type==="checkbox")target.checked=Boolean(value);
    else if(target.value!==String(value??""))target.value=String(value??"");
  }
}
window.addEventListener("blur",()=>{if(!root.inert)releaseInputState();});
window.addEventListener("message",event=>{
  if(channel||disposed||event.source!==parent||event.data?.type!=="piora-mini-app-connect"||event.data.nonce!==nonce||event.ports.length!==1)return;
  channel=event.ports[0];
  channel.onmessage=event=>{
    if(disposed||typeof event.data!=="string"||event.data.length>MINI_APP_LIMITS.replyBytes)return;
    try {
      const message=JSON.parse(event.data);boundedJson(message,MINI_APP_LIMITS.replyBytes);
      if(!Number.isSafeInteger(message.seq)||message.seq!==sequence+1)return;sequence=message.seq;
      if(message.type==="dispose") {clear();resize.disconnect();send({type:"disposed"});disposed=true;graphicsProbe?.getExtension("WEBGL_lose_context")?.loseContext();graphicsProbe=undefined;channel?.close();return;}
      if(message.type==="appearance") {
        applyMiniAppAppearance(message.appearance);send({type:"appearance-applied"});
      } else if(message.type==="fonts") {
        void applyMiniAppFonts(message.fonts).then(()=>{if(!disposed)document.documentElement.dataset.miniAppFonts="loaded";})
          .catch(()=>{if(!disposed)document.documentElement.dataset.miniAppFonts="fallback";});
      } else if(message.type==="probe-environment") {
        let webgl=false;try{webgl=probeGraphics();}catch{/* An unavailable graphics context is a capability result. */}
        send({type:"environment",probeSeq:sequence,report:{protocol:MINI_APP_RENDERER_PROTOCOL,webgl}});
      } else if(message.type==="mount") {
        const probe=graphicsProbe;graphicsProbe=undefined;probe?.getExtension("WEBGL_lose_context")?.loseContext();
        clear();pendingControls.clear();mounted=message.mount as Mount;
        if(!mounted||!Array.isArray(mounted.viewports)||mounted.viewports.length>3)throw new Error("MOUNT");
        style.textContent=mounted.document.css;
        root.inert=mounted.readOnly===true;
        for(const node of mounted.document.nodes)root.append(element(node));
        updateInputs(mounted.inputs);send({type:"mounted"});
      } else if(message.type==="freeze"&&mounted) {
        releaseInputState();root.inert=true;
        // Same-port ordering puts every preceding input before this barrier.
        send({type:"frozen",seq:sequence});
      } else if(message.type==="resume-inputs"&&mounted) {
        root.inert=mounted.readOnly===true;
      } else if(message.type==="release-inputs"&&mounted) {
        releaseInputState();
      } else if(message.type==="frame"&&mounted) {
        const frame=validateMiniAppFrame(message.frame,mounted.document,mounted.viewports);
        if(repeats.size && (!Number.isSafeInteger(message.identity?.revision)||!Number.isSafeInteger(message.identity?.ack)))throw new Error("IDENTITY");
        for(const [id,renderer] of repeats)renderer.update(frame.repeats![id],message.identity);
        for(const [id,targets] of texts)for(const target of targets)target.textContent=String(frame.bindings[id]);
        for(const binding of attributes)binding.element.setAttribute(binding.attribute,String(frame.bindings[binding.id]));
        for(const [id,commands] of Object.entries(frame.canvases??{}))draw(canvases.get(id)!,commands);
        if(message.identity?.sceneEpoch!==undefined&&message.identity.sceneEpoch!==sceneEpoch) {
          sceneEpoch=message.identity.sceneEpoch;for(const scene of scenes.values())scene.resetView();
        }
        for(const [id,scene] of Object.entries(frame.scenes??{}))scenes.get(id)!.update(scene,message.identity?.sceneRevision??message.seq,message.identity?.ack??0);
        if(message.inputs)updateInputs(message.inputs,message.identity?.ack??rowSerial);
        send({type:"rendered",seq:sequence});
      } else throw new Error("PROTOCOL");
    } catch { clear();send({type:"error",code:"RENDER"});disposed=true;resize.disconnect();channel?.close(); }
  };
  channel.start();send({type:"ready"});
});
parent.postMessage({type:"piora-mini-app-frame-ready",nonce},"*");
