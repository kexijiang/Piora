import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { createJiti } from "jiti";
import { chromium, _electron } from "playwright-core";
import { Input, BufferSource, MP4, EncodedPacketSink } from "mediabunny";
const require = createRequire(import.meta.url), repo = resolve(import.meta.dirname, "..");
const args = Object.fromEntries(process.argv.slice(2).map(arg => { const at = arg.indexOf("="); return [arg.slice(0, at), arg.slice(at + 1)]; }));
if (!args["--hdc"] || !args["--serial"]) throw new Error("Required: --hdc=path --serial=device [--seconds=30] [--phone=true]");
const duration = Number(args["--seconds"] ?? 30);
const runtime = args["--runtime"] ?? "electron";
const inputProbe = args["--input"] === "true";
const directTouchProbe = args["--direct-touch"] === "true";
const preparedInputProbe = args["--prepared-input"] === "true";
const managerPointerProbe = args["--pointer-manager"] === "true";
const pointerMoveProbe = args["--pointer-moves"] === "true";
const phaseFeedback = args["--phase-feedback"] === "true";
if (phaseFeedback && (!managerPointerProbe || pointerMoveProbe)) throw new Error("Phase feedback requires pointer manager without the separate move probe");
// Diagnostic capture variants are recorded explicitly; they do not alter the product default.
const captureVariant = {};
for (const [name, flag, min, max] of [["bitrate", "--capture-bitrate", 1000000, 50000000], ["repeat", "--capture-repeat", 1, 1000], ["fps", "--capture-fps", 30, 120]]) {
  if (args[flag] === undefined) continue;
  const value = Number(args[flag]);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Invalid ${flag}`);
  captureVariant[name] = value;
}
if (pointerMoveProbe && !managerPointerProbe) throw new Error("Pointer move probe requires the production pointer manager");
if (managerPointerProbe && (args["--manager"] !== "true" || !inputProbe)) throw new Error("Pointer manager probe requires --manager=true --input=true");
if (preparedInputProbe && !directTouchProbe) throw new Error("Prepared geometry is a direct transport experiment only");
if (directTouchProbe && (!inputProbe || args["--manager"] === "true")) throw new Error("Direct touch is a transport experiment; use --input=true without --manager");
if (!["electron", "edge"].includes(runtime)) throw new Error("Runtime must be electron or edge");
if (!Number.isFinite(duration) || duration < 5 || duration > 600) throw new Error("Duration must be 5–600 seconds");
const root = resolve(args["--output"] ?? `.verification/mirror-rewrite/performance-${Date.now()}`);
await mkdir(root, { recursive: true });
const jiti = createJiti(import.meta.url);
const { MirrorCaptureSession } = await jiti.import("../lib/harmony/mirror/capture-session.ts");
const { startOwnedRecording } = await jiti.import("../lib/harmony/media/owned-recording.ts");
const { HybridHarmonyBackend } = await jiti.import("../lib/harmony/hybrid-backend.ts");
const { HypiumWorkerClient } = await jiti.import("../lib/harmony/runtime/worker-client.ts");
const legacyWorker = args["--legacy-worker"] ? new HypiumWorkerClient(args["--hdc"], resolve(args["--legacy-worker"])) : undefined;
const control = inputProbe ? new HybridHarmonyBackend({ hdcPath: args["--hdc"], ...(legacyWorker ? { hypiumDriver: legacyWorker } : {}) }) : undefined;
const { HdcBackend } = await jiti.import("../lib/harmony/hdc-backend.ts");
const legacyGeometry = args["--legacy-geometry"] === "true" ? new HdcBackend({hdcPath:args["--hdc"]}) : undefined;
const geometryReader = legacyGeometry ?? control;
const { HarmonyDeviceManager } = await jiti.import("../lib/harmony/device-manager.ts");
const { GestureChannel } = await jiti.import("../lib/harmony/input/gesture-channel.ts");
const { LiveTouch } = await jiti.import("../lib/harmony/input/live-touch.ts");
let gestureChannel, gesturePort, liveTouch;
let manager, manualLease;
const execute = promisify(execFile);
const hdc = async argv => (await execute(args["--hdc"], ["-t", args["--serial"], ...argv], { encoding: "utf8", windowsHide: true, timeout: 15000, maxBuffer: 2 * 1024 * 1024 })).stdout;
let encoderProbePath;
const run = async (argv, operation) => {
  if (operation === "debug_video_file_cleanup") {
    const match = /\/data\/local\/tmp\/(piora_video_[a-f0-9]+\.so)\.log/.exec(argv.at(-1));
    if (match) await writeFile(join(root, "capture-log.txt"), await hdc(["shell", `cat /data/local/tmp/${match[1]}.log`]).catch(String));
  }
  if (operation === "debug_video_start" && encoderProbePath) argv = [...argv.slice(0, -1), `PIORA_ENCODER_PROBE_LOG=${encoderProbePath}.log LD_PRELOAD=${encoderProbePath} ${argv.at(-1)}`];
  if (operation === "debug_video_start") {
    let command = argv.at(-1);
    for (const [name, flag] of [["bitrate", "bitRate"], ["repeat", "repeatInterval"], ["fps", "frameRate"]]) {
      if (captureVariant[name] !== undefined) command = command.replace(new RegExp(`-${flag} \\d+`), `-${flag} ${captureVariant[name]}`);
    }
    argv = [...argv.slice(0, -1), command];
  }
  const result = await execute(args["--hdc"], argv, { encoding: "buffer", windowsHide: true, timeout: 8000, maxBuffer: 2 * 1024 * 1024 }); return { ...result, exitCode: 0, durationMs: 0 };
};

await writeFile(join(root, "loader.cjs"), `const ts=require(${JSON.stringify(require.resolve("typescript"))});module.exports=s=>ts.transpileModule(s,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;`);
await writeFile(join(root, "worker.ts"), `import ${JSON.stringify(join(repo, "scripts/helpers/mirror-performance-worker.ts"))};`);
await writeFile(join(root, "entry.ts"), `const canvas=document.querySelector('canvas');const worker=new Worker(new URL('./worker.ts',import.meta.url),{type:'module'});window.samples=[];window.events=[];window.markers=[];window.worker=worker;worker.onerror=e=>window.events.push({type:"worker-error",error:e.message});worker.onmessage=({data})=>{window.events.push(data);if(data.type==='marker')window.markers.push(data);if(data.type==='statistics'){window.samples.push(data.statistics);document.querySelector('pre').textContent=JSON.stringify(data.statistics,null,2);}if(data.type==='pixel')fetch('/observed',{method:'POST',body:JSON.stringify(data)});};const off=canvas.transferControlToOffscreen();worker.postMessage({type:'start',canvas:off,serial:${JSON.stringify(args["--serial"])}},[off]);`);
const { webpack } = require("next/dist/compiled/webpack/webpack.js");
const compiler = webpack({ mode: "development", target: "web", devtool: false, entry: join(root, "entry.ts"), output: { path: root, filename: "bundle.js" },
  resolve: { extensions: [".ts", ".js"], modules: [join(repo, "node_modules")] }, module: { rules: [{ test: /\.ts$/, exclude: /node_modules/, use: join(root, "loader.cjs") }] } });
await new Promise((resolveBuild, reject) => compiler.run((error, stats) => compiler.close(() => error || stats.hasErrors() ? reject(error || new Error(stats.toString({ all: false, errors: true }))) : resolveBuild())));

let capture, recorder, browser, electron, page, forward, phoneConnected = false, triggerTimer;
const phoneStreams = new Set(), trials = [], errors = [], phoneEvents = [];
let expected, phoneVisible = false, lastPhoneHeartbeat = 0;
const colors = ["255,0,0", "0,255,0", "0,0,255", "255,255,0", "255,0,255", "0,255,255"];
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, "http://localhost");
    if (url.pathname === "/clock") { response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify({ hostTime: performance.now() })); return; }
    if (url.pathname === "/phone") {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1"><style>html,body{margin:0;background:#111;overflow:hidden}canvas{width:100vw;height:100vh;touch-action:none}</style><canvas></canvas><script>const c=document.querySelector('canvas'),g=c.getContext('2d');let color='rgb(255,0,0)',tick=0,frames=0,last=performance.now();const colors=['255,0,0','0,255,0','0,0,255','255,255,0','255,0,255','0,255,255'];let colorIndex=0,pendingDraw=false,running=true;const phaseFeedback=${phaseFeedback};const report=(phase,event)=>{if(!running)return;if(phaseFeedback&&(phase==='down'||phase==='up')){color='rgb('+colors[(++colorIndex)%colors.length]+')';pendingDraw=true;}return fetch('/phone-input',{method:'POST',body:JSON.stringify({phase,sequence:colorIndex,at:performance.now(),x:event?.clientX,y:event?.clientY})});};document.addEventListener('pointerdown',e=>report('down',e));document.addEventListener('pointermove',e=>report('move',e));const heartbeat=()=>fetch('/phone-visible',{method:'POST',body:JSON.stringify({visible:!document.hidden})});const heartbeatTimer=setInterval(heartbeat,200);document.addEventListener('visibilitychange',heartbeat);heartbeat();document.addEventListener('pointerup',()=>{if(!phaseFeedback){color='rgb('+colors[(++colorIndex)%colors.length]+')';pendingDraw=true;}report('up');});const events=new EventSource('/phone-events');events.onmessage=e=>{const message=JSON.parse(e.data);if(message.stop){running=false;clearInterval(heartbeatTimer);events.close();return;}color='rgb('+message.color+')';};function draw(now){if(!running)return;c.width=innerWidth;c.height=innerHeight;g.fillStyle=color;g.fillRect(0,0,c.width,c.height);if(pendingDraw){pendingDraw=false;report('draw');}g.fillStyle='#fff';g.font='20px sans-serif';g.fillText('Piora 60 FPS / 50 ms',12,80);const size=26;for(let i=0;i<16;i++){const x=(now*.15+i*65)%c.width;g.fillRect(x,c.height*.15,size,size);g.fillRect(c.width-x,c.height*.8,size,size);}tick++;for(let bit=0;bit<16;bit++){g.fillStyle=tick&(1<<bit)?'#fff':'#000';g.fillRect(bit*c.width/16,c.height*.25,c.width/16+1,c.height*.18);}g.fillStyle='#000';g.fillText(String(tick),12,120);frames++;if(now-last>1000){fetch('/phone-fps',{method:'POST',body:JSON.stringify({fps:frames*1000/(now-last)})});frames=0;last=now;}requestAnimationFrame(draw);}requestAnimationFrame(draw);</script>`); return;
    }
    if (url.pathname === "/phone-visible") {
      let body="";for await(const chunk of request){body+=chunk;if(body.length>128)throw new Error("invalid heartbeat");}
      phoneVisible=JSON.parse(body).visible===true;lastPhoneHeartbeat=performance.now();response.end("ok");return;
    }
    if (url.pathname === "/phone-input") {
      let body = ""; for await (const chunk of request) { body += chunk; if (body.length > 256) throw new Error("invalid input observation"); }
      phoneEvents.push({ ...JSON.parse(body), hostReceivedAt: performance.now() }); response.end("ok"); return;
    }
    if (url.pathname === "/phone-events") {
      phoneConnected = true; response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
      phoneStreams.add(response); response.write(": ready\n\n"); request.on("close", () => phoneStreams.delete(response)); return;
    }
    if (url.pathname === "/phone-fps" || url.pathname === "/observed") {
      let body = ""; for await (const chunk of request) { body += chunk; if (body.length > 2048) throw new Error("oversized observation"); }
      const value = JSON.parse(body);
      if (url.pathname === "/phone-fps") phoneFps.push(value.fps);
      else if (expected && value.color === expected.color && !expected.latencyMs) {
        expected.canvasSubmitMs = value.submittedHostAt - expected.sentAt;
        expected.gpuConfirmedMs = value.confirmedHostAt - expected.sentAt;
        expected.clockUncertaintyMs = value.clockUncertaintyMs;
        expected.latencyMs = performance.now() - expected.sentAt;
        if (expected.upSentAt) expected.releaseToDrawAckMs = performance.now() - expected.upSentAt;
        trials.push(expected); expected = undefined;
      }
      response.end("ok"); return;
    }
    if (url.pathname === "/api/harmony/video") {
      if (request.method === "POST") { capture?.requestKeyframe(); response.end("{}"); return; }
      const abort = new AbortController(); response.on("close", () => abort.abort());
      const connection = manager ? await manager.openVideoStream({serial:args["--serial"],signal:abort.signal}) : capture.subscribe(abort.signal); const reader = connection.stream.getReader();
      response.writeHead(200, { "Content-Type": "application/vnd.piora.harmony-stream", "Cache-Control": "no-store", "X-Harmony-Generation": "1" });
      try { while (!abort.signal.aborted) { const next = await reader.read(); if (next.done) break; if (!response.write(next.value)) await new Promise(resolveDrain => { const done = () => { response.off("drain", done); response.off("close", done); resolveDrain(); }; response.once("drain", done); response.once("close", done); }); } }
      finally { await reader.cancel().catch(() => {}); await connection.close(); response.end(); } return;
    }
    if (url.pathname === "/recording.mp4") { response.setHeader("Content-Type", "video/mp4"); response.end(await readFile(join(root, "recording.mp4"))); return; }
    if (url.pathname.endsWith(".js") && /^[\w./-]+$/.test(url.pathname)) {
      const file = resolve(root, `.${url.pathname}`); if (!file.startsWith(root + "\\") && !file.startsWith(root + "/")) throw new Error("invalid asset path");
      response.setHeader("Content-Type", "text/javascript"); response.end(await readFile(file)); return;
    }
    response.setHeader("Content-Type", "text/html"); response.end('<!doctype html><style>body{margin:0;background:#111;color:#ddd;display:flex}canvas{width:420px;height:92vh;object-fit:contain}pre{font:14px monospace}</style><canvas></canvas><pre>Waiting for frames</pre><script src="/bundle.js"></script>');
  } catch (error) { errors.push(String(error)); if (!response.headersSent) response.statusCode = 500; response.end(); }
});
const phoneFps = [];
let evidence = {};
try {
  await new Promise(resolveListen => server.listen(0, "127.0.0.1", resolveListen));
  const port = server.address().port;
  await writeFile(join(root, "phone-forward.json"), JSON.stringify({ serial: args["--serial"], port, direction: "reverse" }));
  if (args["--phone"] === "true") {
    const result = await hdc(["rport", `tcp:${port}`, `tcp:${port}`]);
    if (/fail|error/i.test(result)) throw new Error(result);
    forward = port;
    const launched = await hdc(["shell", `aa start -a MainAbility -b com.huawei.hmos.browser -U http://127.0.0.1:${port}/phone`]);
    console.log(launched.trim());
    for (let count = 0; !phoneConnected && count < 100; count++) await new Promise(resolveDelay => setTimeout(resolveDelay, 100));
    if (!phoneConnected) throw new Error("Phone benchmark page did not connect; no performance verdict");
  }
  if (args["--video-source"]) throw new Error("Video uses only the bundled runtime; --video-source is no longer supported");
  if (args["--encoder-probe"]) {
    encoderProbePath = `/data/local/tmp/piora_encoder_probe_${randomUUID().replaceAll("-", "")}.so`;
    await hdc(["file", "send", resolve(args["--encoder-probe"]), encoderProbePath]);
  }
  capture = await MirrorCaptureSession.start(args["--serial"], run, () => {}, undefined, undefined, Number(args["--scale"] ?? 1));
  if (args["--manager"] === "true" && control) {
    control.openVideoStream = async (_serial,signal) => capture.subscribe(signal);
    manager = new HarmonyDeviceManager({backend:control,configPath:join(root,"manager.json"),arbitrationDirectory:join(root,"arbitration")});
    manualLease = await manager.acquireLease({serial:args["--serial"],owner:{kind:"manual",id:"latency-probe"}});
  }
  if (args["--record"] === "true") recorder = await startOwnedRecording(capture.subscribe(undefined, true), undefined, error => errors.push(`Recording: ${error.message}`), true);
  if (runtime === "electron") {
    await writeFile(join(root, "electron.cjs"), `const {app,BrowserWindow}=require("electron");app.setPath('userData',${JSON.stringify(join(root, "electron-profile"))});app.whenReady().then(()=>new BrowserWindow({width:900,height:900,title:'Piora mirror performance test',webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}}).loadURL('about:blank'));app.on('window-all-closed',()=>app.quit());`);
    electron = await _electron.launch({ executablePath: args["--electron-path"] ? resolve(args["--electron-path"]) : require("electron"), args: [join(root, "electron.cjs")], timeout: 30000 });
    page = await electron.firstWindow({ timeout: 30000 });
  } else {
    browser = await chromium.launch({ channel: "msedge", headless: args["--headless"] === "true", args: ["--disable-background-timer-throttling", "--disable-renderer-backgrounding"] });
    page = await browser.newPage({ viewport: { width: 900, height: 900 } });
  }
  page.setDefaultTimeout(30000);
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${port}`);
  await page.waitForFunction(() => window.events.some(event => event.type === "frame" || event.type === "worker-error"), undefined, { timeout: 30000 });
  const workerError = await page.evaluate(() => window.events.find(event => event.type === "worker-error"));
  if (workerError) throw new Error(workerError.error);
  await page.waitForTimeout(3000);
  await page.evaluate(() => { window.samples = []; window.markers = []; });
  const preparedGeometry = control ? await geometryReader.displayGeometry(args["--serial"]) : undefined;
  if (directTouchProbe) {
    const { getFreePort } = require("hypium-driver");
    gesturePort = await getFreePort();
    const forwarded = await hdc(["fport", `tcp:${gesturePort}`, "localabstract:uitest_socket"]);
    if (!/result:OK/.test(forwarded)) throw new Error(`Gesture forward failed: ${forwarded}`);
    gestureChannel = new GestureChannel(gesturePort);
    await gestureChannel.connect();
  }
  let colorIndex = 0;
  let inputPending = false;
  triggerTimer = setInterval(async () => {
    if (inputPending) return;
    if (expected) { trials.push({ ...expected, timeout: true }); expected = undefined; if(inputProbe){clearInterval(triggerTimer);errors.push("Input feedback was not observed; further injections stopped");return;} }
    if(inputProbe && (!phoneVisible || performance.now()-lastPhoneHeartbeat>750)){clearInterval(triggerTimer);errors.push("Phone test page lost foreground; further injections stopped");return;}
    if (!phoneStreams.size) return;
    const color = colors[(++colorIndex) % colors.length]; expected = { color, sequence: colorIndex, sentAt: performance.now() };
    if (control) {
      inputPending = true;
      const trial = expected;
      try {
        const initial = preparedInputProbe ? preparedGeometry : manager ? await manager.getFrameGeometry(args["--serial"],"video") : await geometryReader.displayGeometry(args["--serial"]);
        const current = preparedInputProbe || manager ? initial : await geometryReader.displayGeometry(args["--serial"]);
        if (JSON.stringify(initial) !== JSON.stringify(current)) throw new Error("Display changed during input probe");
        trial.geometryMs = performance.now() - trial.sentAt;
        if(!phoneVisible || performance.now()-lastPhoneHeartbeat>750)throw new Error("Phone test page lost foreground before dispatch");
        if (manager) {
          const options = {serial:args["--serial"],leaseToken:manualLease.token,geometryId:current.geometryId,generation:current.deviceEpoch,coordinateSpace:"frame",x:Math.round(current.frameWidth/2),y:Math.round(current.frameHeight/2)};
          if (managerPointerProbe) {
            if (phaseFeedback) trial.phase = "down";
            const { gestureId } = await manager.beginManualPointer(options);
            trial.downAckMs = performance.now() - trial.sentAt;
            if (phaseFeedback) trial.inputAckMs = trial.downAckMs;
            let releaseTrial;
            try {
              if (pointerMoveProbe) {
                trial.moves = [];
                for (const offset of [-0.08, 0.08, 0]) {
                  const started = performance.now();
                  await manager.updateManualPointer({ ...options, gestureId, phase: "move", x: Math.round(current.frameWidth * (.5 + offset)) });
                  trial.moves.push(performance.now() - started);
                  await new Promise(resolve => setTimeout(resolve, 16));
                }
              }
              // A held pointer is delivered before mouse-up, as in the actual UI.
              // The full trigger metric still includes this deliberate hold.
              if (phaseFeedback) {
                const deadline = performance.now() + 1000;
                while (expected === trial && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 1));
                if (expected === trial) throw new Error("DOWN feedback not observed");
                expected = releaseTrial = { color: colors[(++colorIndex) % colors.length], sequence: colorIndex, phase: "up", sentAt: performance.now() };
              } else {
                await new Promise(resolve => setTimeout(resolve, 80));
                trial.upSentAt = performance.now();
              }
            } finally {
              await manager.updateManualPointer({ ...options, gestureId, phase: "up" });
              if (releaseTrial) releaseTrial.inputAckMs = performance.now() - releaseTrial.sentAt;
            }
          } else await manager.tap(options);
        }
        else if (gestureChannel) {
          const point = { x: Math.round(current.nativeWidth / 2), y: Math.round(current.nativeHeight / 2) };
          liveTouch = new LiveTouch(gestureChannel, {
            validate() { if (!phoneVisible || performance.now() - lastPhoneHeartbeat > 750) throw new Error("Phone test page lost foreground"); },
            async recoverRelease(point) {
              const recovery = new GestureChannel(gesturePort);
              try { await recovery.connect(); await recovery.touch("up", point.x, point.y); }
              finally { recovery.close(); }
            },
            onError(error) { errors.push(`Gesture release: ${error}`); clearInterval(triggerTimer); },
          });
          trial.dispatchMs = performance.now() - trial.sentAt;
          await liveTouch.down(point);
          trial.downAckMs = performance.now() - trial.sentAt;
          await liveTouch.up(); liveTouch = undefined;
        } else await control.tap(args["--serial"], Math.round(current.nativeWidth / 2), Math.round(current.nativeHeight / 2));
        if (!phaseFeedback) trial.inputAckMs = performance.now() - trial.sentAt;
      } catch (error) { clearInterval(triggerTimer); errors.push(`Input: ${error.message}`); }
      finally { inputPending = false; }
    } else for (const stream of phoneStreams) stream.write(`data: ${JSON.stringify({ color })}\n\n`);
  }, 1000);
  await page.waitForTimeout(duration * 1000);
  clearInterval(triggerTimer);
  while(inputPending) await new Promise(resolve=>setTimeout(resolve,20));
  const samples = await page.evaluate(() => window.samples);
  const markers = await page.evaluate(() => window.markers);
  const frameShapes = await page.evaluate(() => window.events.filter(event => event.type === "frame"));
  const probeIssues = await page.evaluate(() => window.events.filter(event => event.type === "probe-error" || event.type === "probe-skipped"));
  let recording;
  if (recorder) {
    const bytes = await recorder.stop(join(root, "recording.mp4")); recorder = undefined;
    const input = new Input({ source: new BufferSource(await readFile(join(root, "recording.mp4"))), formats: [MP4] });
    try {
      const track = await input.getPrimaryVideoTrack(), sink = new EncodedPacketSink(track);
      let packets = 0, previous = -Infinity;
      for await (const packet of sink.packets()) {
        if (packet.timestamp < previous) throw new Error("Recording timestamps moved backwards");
        previous = packet.timestamp; packets++;
      }
      recording = { bytes, packets, duration: await input.computeDuration(), width: track.displayWidth, height: track.displayHeight, startsWithKeyframe: (await sink.getFirstPacket()).type === "key" };
      if (recording.duration < duration || !recording.startsWithKeyframe) throw new Error("Real recording failed duration/keyframe validation");
    } finally { input.dispose(); }
    recording.playback = await page.evaluate(async () => {
      const video = document.createElement("video"); video.muted = true; video.style.cssText = "position:fixed;width:8px;height:8px"; document.body.append(video);
      const url = URL.createObjectURL(await (await fetch("/recording.mp4")).blob()); video.src = url;
      let timer;
      try {
        const decoded = new Promise((resolve, reject) => {
          timer = setTimeout(() => reject(new Error("MP4 playback timed out")), 10000);
          video.onerror = () => reject(new Error(video.error?.message ?? "MP4 playback failed"));
          video.requestVideoFrameCallback(() => resolve({ width: video.videoWidth, height: video.videoHeight, duration: video.duration }));
        });
        await video.play(); return await decoded;
      } finally { clearTimeout(timer); video.pause(); video.remove(); URL.revokeObjectURL(url); }
    });
  }
  const latencies = trials.filter(trial => Number.isFinite(trial.latencyMs)).map(trial => trial.latencyMs).sort((a, b) => a - b);
  const average = key => samples.reduce((total, sample) => total + sample[key], 0) / Math.max(1, samples.length);
  evidence = { duration, runtime, phoneConnected, phoneFps, samples, trials, markers, frameShapes, phoneEvents, errors, probeIssues, recording, videoSource: "bundled",
    summary: { receiveFps: average("receivedFps"), decodeFps: average("decodedFps"), drawFps: average("presentedFps"), minDrawFps: Math.min(...samples.map(sample => sample.presentedFps)),
      triggerToDrawAckP95Ms: latencies[Math.floor(latencies.length * .95)] ?? null, triggerToDrawAckMaxMs: latencies.at(-1) ?? null,
      timedOutTrials: trials.filter(trial => trial.timeout).length,
      uniqueFrameFps: markers.length > 1 ? (markers.length - 1) * 1000 / (markers.at(-1).at - markers[0].at) : 0 },
    inputProbe, directTouchProbe, preparedInputProbe, managerPointerProbe, pointerMoveProbe, phaseFeedback, captureVariant, encoderProbe: args["--encoder-probe"], captureScale: Number(args["--scale"] ?? 1), managerProbe:Boolean(manager), legacyGeometry: Boolean(legacyGeometry),
    controlBoundary: directTouchProbe ? `Experimental persistent Gestures socket; ${preparedInputProbe ? "test page geometry prepared before the timed series" : "two real geometry queries per input"}. Bypasses manager and React/HTTP; NOT production/UI acceptance.` : "Existing control path",
    boundary: "Input mode uses real geometry checks and the selected control path (see controlBoundary); manager mode also includes the production lease, frame freshness, generation, queue and dispatch checks. React and HTTP routes are excluded; it is not full UI acceptance. Real HDC capture and real WebCodecs/OffscreenCanvas in the stated runtime. The isolated performance server bypasses Next and desktop authentication. Latency is host-trigger-to-phone-test-page-change-to-host-canvas-draw-to-host-ack upper bound, not optical display measurement. Draw FPS does not prove physical monitor refresh."
  };
  evidence.verdict = {
    passed: phoneConnected && duration >= 30 && samples.length >= 25 && latencies.length >= 25 && !errors.length && !probeIssues.length
      && (!phaseFeedback || ["down", "up"].every(phase => trials.filter(trial => trial.phase === phase && Number.isFinite(trial.latencyMs)).length >= 25))
      && evidence.summary.uniqueFrameFps >= 60 && evidence.summary.minDrawFps >= 60
      && evidence.summary.triggerToDrawAckMaxMs <= 50 && evidence.summary.timedOutTrials === 0,
    criteria: { uniqueFrameFpsMinimum: 60, minimumOneSecondDrawFps: 60, triggerToDrawAckMaxMsInclusive: 50, minimumDurationSeconds: 30, minimumLatencyTrials: 25 },
  };
  if (!evidence.verdict.passed) process.exitCode = 1;
  await page.screenshot({ path: join(root, "mirror.png") });
  console.log(JSON.stringify({ ...evidence.summary, phoneFpsAverage: phoneFps.reduce((a, b) => a + b, 0) / phoneFps.length, errors }, null, 2));
} catch (error) { evidence = { ...evidence, failed: String(error), errors, events: await page?.evaluate(() => window.events).catch(() => undefined) }; console.error(error); process.exitCode = 1; }
finally {
  clearInterval(triggerTimer);
  await page?.evaluate(() => window.worker?.postMessage({ type: "stop" })).catch(() => {});
  const cleanup = async (label, action) => { try { await action(); } catch (error) { errors.push(`${label}: ${error}`); } };
  await cleanup("Gesture release", async () => { await liveTouch?.up(); });
  gestureChannel?.close();
  if (gesturePort) await cleanup("Gesture forward cleanup", async () => {
    const removed = await hdc(["fport", "rm", `tcp:${gesturePort}`, "localabstract:uitest_socket"]);
    if (!/success|OK/i.test(removed)) throw new Error(removed);
  });
  if (recorder) await cleanup("Recording cleanup", () => recorder.stop(join(root, "interrupted-recording.mp4")));
  await cleanup("Browser cleanup", async () => { await browser?.close(); });
  await cleanup("Electron cleanup", async () => { await electron?.close(); });
  await cleanup("Control cleanup", async () => { if(manager) await manager.dispose(); else await control?.dispose(); await legacyGeometry?.dispose(); });
  await cleanup("Capture cleanup", async () => { await capture?.close(); });
  if (encoderProbePath) await cleanup("Encoder probe cleanup", async () => {
    await writeFile(join(root, "encoder-probe-log.txt"), await hdc(["shell", `cat ${encoderProbePath}.log`]));
    await hdc(["shell", `rm -f ${encoderProbePath} ${encoderProbePath}.log`]);
  });
  for (const stream of phoneStreams) { stream.write('data: {"stop":true}\n\n'); stream.end(); }
  server.closeAllConnections(); await new Promise(resolveClose => server.close(resolveClose));
  if (forward) await cleanup("Reverse forward cleanup", async () => {
    const removed = await hdc(["fport", "rm", `tcp:${forward}`, `tcp:${forward}`]);
    if (/\[fail\]/i.test(removed)) throw new Error(removed);
    const listing = await hdc(["fport", "ls"]);
    if (listing.split(/\r?\n/).some(line => line.trim().split(/\s+/).slice(0, 3).join(" ") === `${args["--serial"]} tcp:${forward} tcp:${forward}`)) throw new Error("Owned reverse forward remains after cleanup");
  });
  if (errors.length) { if (evidence.verdict) evidence.verdict.passed = false; process.exitCode = 1; }
  await writeFile(join(root, "result.json"), JSON.stringify(evidence, null, 2));
}
