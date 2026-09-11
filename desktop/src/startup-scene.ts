import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const STARTUP_CINEMATIC_MS = 8_000;
// Allow media initialization without cutting the eight-second film's closing title.
export const STARTUP_MEDIA_TIMEOUT_MS = STARTUP_CINEMATIC_MS + 2_000;
export const STARTUP_CONTINUE_CHANNEL = "pi:startup-continue";

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}

export function loadStartupMedia(directory: string): { video?: string; poster?: string } {
  const asset = (name: string, mime: string, maximum: number) => {
    const path = join(directory, name);
    if (!existsSync(path)) return undefined;
    try {
      const data = readFileSync(path);
      return data.byteLength <= maximum ? `data:${mime};base64,${data.toString("base64")}` : undefined;
    } catch { return undefined; }
  };
  const video = asset("polaris-rover.mp4", "video/mp4", 12_000_000);
  const poster = asset("polaris-rover.jpg", "image/jpeg", 1_000_000);
  return { ...(video ? { video } : {}), ...(poster ? { poster } : {}) };
}

export function createStartupDocument(options: { chinese: boolean; version: string; updated: boolean; video?: string; poster?: string }): string {
  const { chinese: zh, updated, video, poster } = options;
  return `<!doctype html><html lang="${zh ? "zh-CN" : "en"}"><head>
<meta charset="utf-8"><title>Piora · ${zh ? "正在启动" : "Starting"}</title><meta name="color-scheme" content="dark"><meta name="theme-color" content="#080a0f">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; media-src data:; style-src 'unsafe-inline'; script-src 'nonce-piora-startup'; base-uri 'none'">
<style>
*{box-sizing:border-box}html,body{height:100%;width:100%;margin:0}body{overflow:hidden;background:#080a0f;color:#effaff;font-family:'Segoe UI','Microsoft YaHei UI',sans-serif}
.scene,.shade,.fallback{position:absolute;inset:0;width:100%;height:100%}.scene{object-fit:cover;object-position:center}.fallback{background:radial-gradient(ellipse at 65% 30%,#154256,transparent 60%),linear-gradient(145deg,#080a0f,#122938)}
.shade{background:linear-gradient(180deg,rgba(3,10,18,.4),transparent 30%,rgba(2,9,16,.1) 55%,rgba(2,8,14,.92));pointer-events:none}
.top{position:absolute;top:44px;left:5%;right:5%;display:flex;justify-content:space-between;gap:20px;align-items:center}.wordmark{font-size:16px;font-weight:700;letter-spacing:.22em}.mission{font:10px/1.6 ui-monospace,monospace;letter-spacing:.17em;color:#a9d4df;text-align:right}.live{display:inline-block;width:5px;height:5px;margin-right:9px;background:#72e7f4;border-radius:50%;box-shadow:0 0 16px #50d6ea}
main{position:absolute;top:25%;left:5%;right:5%;display:flex;align-items:flex-start;justify-content:space-between;gap:32px}.eyebrow{font:10px/1.8 ui-monospace,monospace;letter-spacing:.28em;color:#86dcec}.title{margin:9px 0 4px;font-size:clamp(42px,7.7vw,110px);font-weight:600;letter-spacing:.14em;line-height:1}.subtitle{font-size:13px;line-height:1.8;color:#b2c6d0;letter-spacing:.045em}.statusbox{position:fixed;right:5%;bottom:8%;width:230px;max-width:38vw;flex-shrink:0}.status{font-size:12px;line-height:1.7;color:#b2c6d0}.progress{height:2px;margin:13px 0 17px;background:#294552;overflow:hidden}.progress:after{content:'';display:block;width:40%;height:100%;background:linear-gradient(90deg,transparent,#8eedff);animation:sweep 1.8s ease-in-out 6 both}.actions{display:flex;justify-content:space-between;align-items:center;gap:12px}.version{font:10px ui-monospace,monospace;color:#82a0b0}button{background:transparent;cursor:pointer;padding:7px 12px;border:1px solid #416070;border-radius:8px;color:#d7f4ff;text-decoration:none;font-size:11px;white-space:nowrap}button:hover{background:#173746}button:focus-visible{outline:2px solid #8eedff;outline-offset:4px}
@keyframes sweep{from{transform:translateX(-100%)}to{transform:translateX(350%)}}@media(max-width:620px){.top{top:28px}.mission{font-size:8px}main{top:23%;display:block}.statusbox{left:5%;right:5%;bottom:6%;width:auto;max-width:none}.title{font-size:52px}.subtitle{font-size:11px}.eyebrow{font-size:8px}}
.film .scene{object-fit:contain}.film .fallback{background:#080a0f}.film .top,.film .intro-copy,.film .shade,.film .progress{display:none}.film .statusbox{top:18px;bottom:auto;left:auto;right:20px;width:auto;max-width:calc(100vw - 40px);display:flex;align-items:center;gap:16px;padding:7px 9px 7px 14px;background:rgba(8,10,15,.65);border:1px solid rgba(180,198,220,.12);border-radius:12px}.film .status{font-size:11px;color:#aeb8c8}.film button{border-color:rgba(180,198,220,.24)}.film .version{color:#8c98aa}
@media(prefers-reduced-motion:reduce){video{display:none}.progress:after{animation:none;width:70%}}
</style></head><body class="${video ? "film" : "poster"}">
<div class="fallback"></div>${poster ? `<img class="scene" src="${poster}" alt="">` : ""}${video ? `<video class="scene" autoplay muted playsinline preload="auto" ${poster ? `poster="${poster}"` : ""} aria-hidden="true"><source src="${video}" type="video/mp4"></video>` : ""}<div class="shade"></div>
<header class="top"><div class="wordmark">π / PIORA</div><div class="mission"><span class="live"></span>POLARIS EXPEDITION<br>PX-06 · 2076</div></header>
<main><div class="intro-copy"><div class="eyebrow">${updated ? "A NEW HORIZON AWAITS" : "BEYOND THE NEXT HORIZON"}</div><h1 class="title">PIORA</h1><div class="subtitle">${zh ? updated ? "更新就绪。下一程，驶向未知。" : "保持好奇，驶向未知。" : updated ? "Update ready. A new frontier awaits." : "Stay curious. Explore what comes next."}</div></div><div class="statusbox"><div class="status" role="status">${zh ? "正在启动 Piora" : "Starting Piora"}${video ? "" : `<br>${zh ? "正在准备你的工作区" : "Preparing your workspace"}`}</div><div class="progress" role="progressbar" aria-label="${zh ? "正在启动" : "Starting"}"></div><div class="actions"><span class="version">v${escapeHtml(options.version)}</span><button type="button" id="skip-intro">${zh ? "跳过动画" : "Skip intro"} ↗</button></div></div></main>
<script nonce="piora-startup">const clip=document.querySelector('video');const motion=matchMedia('(prefers-reduced-motion: reduce)');let continued=false;function continueStartup(){if(continued)return;continued=true;clip?.pause();window.piDesktop?.finishStartupIntro();}document.querySelector('#skip-intro')?.addEventListener('click',continueStartup);function settleMotion(){if(motion.matches)continueStartup();}motion.addEventListener('change',settleMotion);clip?.addEventListener('error',continueStartup,true);clip?.addEventListener('ended',continueStartup,{once:true});settleMotion();</script>
</body></html>`;
}
