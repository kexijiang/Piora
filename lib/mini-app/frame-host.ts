import { MINI_APP_LIMITS, MiniAppError } from "./limits";
import { boundedJson, type JsonRecord } from "./json";
import { validateMiniAppFrame, type MiniAppFrame, type MiniAppViewport } from "./frame";
import type { MiniAppViewState } from "./scene-state";
import { validateMiniAppGraphicsReport, type MiniAppGraphicsReport } from "./environment-protocol";
import type { MiniAppDocument } from "./document";
import { readMiniAppResource } from "./resource";
import { observeMiniAppAppearance, loadMiniAppFonts } from "./appearance";

export interface MiniAppMount { document: MiniAppDocument; inputs: JsonRecord; viewports: MiniAppViewport[]; readOnly?: boolean; view?: MiniAppViewState; language?: string }
const baseStyles = `:root{color-scheme:light dark;--bg:#fff;--bg-panel:#f5f7fa;--bg-hover:#edf1f5;--bg-selected:#e2ecf7;--border:#d6dee7;--text:#1d2a36;--text-muted:#536575;--text-dim:#71818e;--accent:#246a84;--font-mono:monospace}
*{box-sizing:border-box}html{font:16px/1.5 system-ui}html,body{margin:0;padding:0;background:var(--bg);color:var(--text)}body{font:inherit}#mini-app-root{padding:1rem;max-width:100%;overflow:hidden}svg,canvas{max-width:100%}table{border-collapse:collapse;width:100%}th,td{padding:.5rem;border-bottom:1px solid var(--border);text-align:left}input,select,button{font:inherit;color:inherit;background:var(--bg-panel);border:1px solid var(--border);border-radius:8px;padding:.45rem .65rem;max-width:100%}button{cursor:pointer}input[type=checkbox]{width:auto}button:focus-visible,input:focus-visible,select:focus-visible,[tabindex]:focus-visible{outline:2px solid var(--accent);outline-offset:2px}p{margin:.5rem 0}h1,h2,h3,h4{line-height:1.3;margin:.5rem 0 .75rem}canvas{display:block;touch-action:none}`;

async function sha256(source:string):Promise<{hex:string;base64:string}> {
  const digest=new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(source)));
  return {hex:[...digest].map(n=>n.toString(16).padStart(2,"0")).join(""),base64:btoa(String.fromCharCode(...digest))};
}

/** Fixed runtime script and opaque-origin frame; only validated data crosses the port. */
export class MiniAppFrameHost {
  readonly iframe: HTMLIFrameElement;
  private readonly nonce=crypto.randomUUID();
  private readonly channel=new MessageChannel();
  private sequence=0;
  private closed=false;
  private mount?:MiniAppMount;
  private readyResolve?:()=>void;
  private readyReject?:(error:MiniAppError)=>void;
  private readyTimer?:ReturnType<typeof setTimeout>;
  private frameTimer?:ReturnType<typeof setTimeout>;
  private scheduleTimer?:ReturnType<typeof setTimeout>;
  private lastFrameAt=0;
  private frameSequence?:number;
  private queuedFrame?:{frame:MiniAppFrame;inputs:JsonRecord;identity?:{revision:number;ack:number;sceneRevision?:number;sceneEpoch?:number}};
  private cleanup?:()=>void;
  private appearanceCleanup?:()=>void;
  private readonly fontCancellation=new AbortController();
  private fontsStarted=false;
  private listener:(event:MessageEvent)=>void;
  private frozen?:{seq:number;promise:Promise<void>;resolve():void;reject(error:MiniAppError):void;timer:ReturnType<typeof setTimeout>};
  private probe?:{seq:number;promise:Promise<MiniAppGraphicsReport>;resolve(report:MiniAppGraphicsReport):void;reject(error:MiniAppError):void;timer:ReturnType<typeof setTimeout>};

  private constructor(private readonly onEvent:(event:JsonRecord)=>void,private readonly onError:(error:MiniAppError)=>void,
    readonly rendererDigest:string,private readonly onEnvironment?:(report:MiniAppGraphicsReport)=>void) {
    this.iframe=document.createElement("iframe");this.iframe.title="Interactive answer";
    this.iframe.setAttribute("sandbox","allow-scripts");this.iframe.referrerPolicy="no-referrer";
    this.iframe.style.cssText="display:block;width:100%;height:300px;border:0;background:transparent;visibility:hidden";
    this.listener=event=>{
      if(this.closed||event.source!==this.iframe.contentWindow||event.data?.type!=="piora-mini-app-frame-ready"||event.data.nonce!==this.nonce)return;
      window.removeEventListener("message",this.listener);
      this.iframe.contentWindow!.postMessage({type:"piora-mini-app-connect",nonce:this.nonce},"*",[this.channel.port2]);
    };
    this.channel.port1.onmessage=event=>this.receive(event.data);this.channel.port1.start();
    window.addEventListener("message",this.listener);
  }

  static async create(container:HTMLElement,options:{source?:string;signal?:AbortSignal;onEvent(event:JsonRecord):void;onError(error:MiniAppError):void;onEnvironment?(report:MiniAppGraphicsReport):void}):Promise<MiniAppFrameHost> {
    const signal=options.signal?AbortSignal.any([options.signal,AbortSignal.timeout(10_000)]):AbortSignal.timeout(10_000);
    let source=options.source;
    if(source===undefined) {
      const response=await fetch("/api/mini-app/renderer",{signal,cache:"no-store"});
      // JSON escapes can expand the fixed renderer source. Bound wire bytes
      // before parsing, then independently bound and verify the decoded source.
      const body=JSON.parse(new TextDecoder().decode(await readMiniAppResource(response,8*1024*1024)));
      if(typeof body.source!=="string"||body.source.length>4*1024*1024||(await sha256(body.source)).hex!==body.sha256)throw new MiniAppError("RUNTIME","Invalid renderer asset");
      source=body.source;
    }
    if(signal.aborted||typeof source!=="string"||source.length>4*1024*1024)throw new MiniAppError("STOPPED","Mini app renderer cannot start");
    const code=source.replace(/<\/script/gi,"<\\/script");const digest=await sha256(code);
    if(signal.aborted)throw new MiniAppError("STOPPED","Mini app renderer cannot start");
    const host=new MiniAppFrameHost(options.onEvent,options.onError,(await sha256(source)).hex,options.onEnvironment);
    const policy=`default-src 'none'; script-src 'sha256-${digest.base64}'; style-src 'unsafe-inline'; img-src 'none'; connect-src 'none'; font-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'none'`;
    host.iframe.srcdoc=`<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${policy}"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${baseStyles}</style></head><body><main id="mini-app-root" data-instance="${host.nonce}"></main><script>${code}</script></body></html>`;
    const ready=new Promise<void>((resolve,reject)=>{host.readyResolve=resolve;host.readyReject=reject;host.readyTimer=setTimeout(()=>host.fail(new MiniAppError("WATCHDOG","Mini app renderer did not become ready")),5000);});
    const abort=()=>host.dispose();options.signal?.addEventListener("abort",abort,{once:true});
    host.cleanup=()=>options.signal?.removeEventListener("abort",abort);
    container.append(host.iframe);
    try {
      await ready;
      host.appearanceCleanup=observeMiniAppAppearance(appearance=>{
        if(host.closed)return;
        host.send({type:"appearance",appearance});
        if(!host.fontsStarted&&/\bInter\b/i.test(appearance.fontFamily)) {
          host.fontsStarted=true;
          void loadMiniAppFonts(AbortSignal.any([host.fontCancellation.signal,AbortSignal.timeout(10_000)]))
            .then(fonts=>{if(!host.closed)host.send({type:"fonts",fonts});})
            .catch(()=>{/* Local fallback fonts keep the app usable when assets are unavailable. */});
        }
      });
      return host;
    }catch(error){host.dispose();throw error;}
  }

  private receive(data:unknown) {
    if(this.closed||typeof data!=="string"||data.length>16_384)return;
    try {
      const value=JSON.parse(data);boundedJson(value,16_384);
      if(value.type==="ready"){if(this.readyTimer)clearTimeout(this.readyTimer);this.readyTimer=undefined;this.readyResolve?.();this.readyResolve=undefined;this.readyReject=undefined;}
      else if(value.type==="appearance-applied"){this.iframe.style.visibility="visible";}
      else if(value.type==="height"&&Number.isFinite(value.height)){this.iframe.style.height=`${Math.min(1600,Math.max(80,value.height))}px`;}
      else if(value.type==="event"&&value.event&&typeof value.event==="object"&&!Array.isArray(value.event)){this.onEvent(value.event);}
      else if(value.type==="environment") {
        const report=validateMiniAppGraphicsReport(value.report);
        this.onEnvironment?.(report);
        if(this.probe&&this.probe.seq===value.probeSeq){const pending=this.probe;this.probe=undefined;clearTimeout(pending.timer);pending.resolve(report);}
      }
      else if(value.type==="frozen"&&value.seq===this.frozen?.seq){const pending=this.frozen!;this.frozen=undefined;clearTimeout(pending.timer);pending.resolve();}
      else if(value.type==="rendered"&&value.seq===this.frameSequence){
        if(this.frameTimer)clearTimeout(this.frameTimer);this.frameTimer=undefined;this.frameSequence=undefined;
        if(this.queuedFrame)this.scheduleFrame();
      }
      else if(value.type==="error") {
        if(value.code==="CONTEXT_LOST")window.dispatchEvent(new Event("piora-mini-app-graphics-lost"));
        this.fail(value.code==="CONTEXT_LOST"?new MiniAppError("CONTEXT_LOST","The graphics context was lost. The last checkpoint is retained; resume to try a new renderer."):new MiniAppError("RENDER","Mini app could not render this frame"));
      }
    }catch{this.fail(new MiniAppError("PROTOCOL","Invalid renderer message"));}
  }
  private send(message:Record<string,unknown>) {
    if(this.closed)throw new MiniAppError("STOPPED","Mini app renderer is stopped");
    this.channel.port1.postMessage(boundedJson({...message,seq:++this.sequence},MINI_APP_LIMITS.replyBytes));
  }
  setDocument(mount:MiniAppMount) {
    if(this.mount)throw new MiniAppError("STATE","A new mini app document requires a new renderer instance");
    boundedJson(mount,MINI_APP_LIMITS.replyBytes);
    if(mount.viewports.length>3||mount.viewports.some(view=>!Number.isSafeInteger(view.width)||!Number.isSafeInteger(view.height)||view.width<32||view.width>1024||view.height<32||view.height>1024))throw new MiniAppError("LIMIT","Viewport dimensions exceed the renderer budget");
    this.mount={...JSON.parse(JSON.stringify(mount)),language:document.documentElement.lang||navigator.language} as MiniAppMount;this.send({type:"mount",mount:this.mount});
  }
  probeEnvironment():Promise<MiniAppGraphicsReport> {
    if(this.closed)return Promise.reject(new MiniAppError("STOPPED","Renderer is stopped"));
    if(this.probe)return this.probe.promise;
    let resolve!:(report:MiniAppGraphicsReport)=>void,reject!:(error:MiniAppError)=>void;
    const promise=new Promise<MiniAppGraphicsReport>((yes,no)=>{resolve=yes;reject=no;});
    const timer=setTimeout(()=>this.fail(new MiniAppError("WATCHDOG","Graphics environment probe timed out")),2500);
    this.probe={seq:this.sequence+1,promise,resolve,reject,timer};this.send({type:"probe-environment"});return promise;
  }
  freezeInputs():Promise<void> {
    if(this.closed||!this.mount)return Promise.reject(new MiniAppError("STOPPED","Mini app renderer is not available"));
    if(this.frozen)return this.frozen.promise;
    let resolve!:()=>void,reject!:(error:MiniAppError)=>void;
    const promise=new Promise<void>((yes,no)=>{resolve=yes;reject=no;});
    const timer=setTimeout(()=>this.fail(new MiniAppError("WATCHDOG","Mini app inputs did not settle")),MINI_APP_LIMITS.watchdogMs);
    this.frozen={seq:this.sequence+1,promise,resolve,reject,timer};
    this.send({type:"freeze"});return promise;
  }
  resumeInputs():void {if(!this.closed)this.send({type:"resume-inputs"});}
  releaseInputs():void {if(!this.closed&&this.mount)this.send({type:"release-inputs"});}
  render(frame:unknown,inputs:JsonRecord,identity?:{revision:number;ack:number;sceneRevision?:number;sceneEpoch?:number}):MiniAppFrame {
    if(!this.mount)throw new MiniAppError("STATE","Mini app document is not mounted");
    const validated=validateMiniAppFrame(frame,this.mount.document,this.mount.viewports);
    const next={frame:validated,inputs:JSON.parse(boundedJson(inputs,MINI_APP_LIMITS.stateBytes)) as JsonRecord,...(identity?{identity}:{})};
    this.queuedFrame=next;this.scheduleFrame();
    return validated;
  }
  private scheduleFrame() {
    if(this.closed||this.frameSequence!==undefined||this.scheduleTimer||!this.queuedFrame)return;
    const delay=Math.max(0,1000/MINI_APP_LIMITS.framesPerSecond-(performance.now()-this.lastFrameAt));
    this.scheduleTimer=setTimeout(()=>{
      this.scheduleTimer=undefined;
      const next=this.queuedFrame;this.queuedFrame=undefined;
      if(!this.closed&&next)this.sendFrame(next);
    },delay);
  }
  private sendFrame(value:{frame:MiniAppFrame;inputs:JsonRecord;identity?:{revision:number;ack:number;sceneRevision?:number;sceneEpoch?:number}}) {
    this.lastFrameAt=performance.now();
    this.send({type:"frame",...value});this.frameSequence=this.sequence;
    this.frameTimer=setTimeout(()=>this.fail(new MiniAppError("WATCHDOG","Mini app rendering stopped responding")),MINI_APP_LIMITS.watchdogMs);
  }
  private fail(error:MiniAppError){this.readyReject?.(error);this.readyReject=undefined;this.onError(error);this.dispose();}
  dispose() {
    if(this.closed)return;
    try{this.send({type:"dispose"});}catch{/* Removal also destroys the frame realm. */}
    this.closed=true;if(this.readyTimer)clearTimeout(this.readyTimer);
    if(this.probe){clearTimeout(this.probe.timer);this.probe.reject(new MiniAppError("STOPPED","Graphics environment probe was cancelled"));this.probe=undefined;}
    this.appearanceCleanup?.();this.appearanceCleanup=undefined;this.fontCancellation.abort();
    if(this.frozen){clearTimeout(this.frozen.timer);this.frozen.reject(new MiniAppError("STOPPED","Mini app input checkpoint was cancelled"));this.frozen=undefined;}
    if(this.frameTimer)clearTimeout(this.frameTimer);this.queuedFrame=undefined;
    if(this.scheduleTimer)clearTimeout(this.scheduleTimer);this.scheduleTimer=undefined;
    this.cleanup?.();this.cleanup=undefined;
    this.readyReject?.(new MiniAppError("STOPPED","Mini app renderer is stopped"));this.readyReject=undefined;
    window.removeEventListener("message",this.listener);this.channel.port1.close();this.channel.port2.close();this.iframe.remove();
  }
}
