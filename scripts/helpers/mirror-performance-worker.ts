import { MirrorVideoEngine } from "../../lib/harmony/mirror/video-engine";
let engine: MirrorVideoEngine | undefined;
let lastColor = "", lastMarker = -1, lastTimestamp = -1;
let clockOffset = 0, clockUncertaintyMs = Infinity;
type Probe = { buffer: WebGLBuffer; fence: WebGLSync; at: number; timestamp: number };

/** Test only: sample 17 pixels on the GPU, then read a tiny asynchronous PBO. */
function createProbe() {
  const canvas = new OffscreenCanvas(17, 1);
  const gl = canvas.getContext("webgl2", { alpha: false, antialias: false, depth: false, powerPreference: "high-performance" });
  if (!gl) throw new Error("WebGL2 measurement unavailable");
  const shader = (type: number, source: string) => {
    const value = gl.createShader(type)!; gl.shaderSource(value, source); gl.compileShader(value);
    if (!gl.getShaderParameter(value, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(value) ?? "Probe shader failed");
    return value;
  };
  const program = gl.createProgram()!;
  gl.attachShader(program, shader(gl.VERTEX_SHADER, `#version 300 es
  void main(){vec2 p=vec2(float((gl_VertexID<<1)&2),float(gl_VertexID&2));gl_Position=vec4(p*2.0-1.0,0,1);}`));
  gl.attachShader(program, shader(gl.FRAGMENT_SHADER, `#version 300 es
  precision highp float;uniform sampler2D picture;out vec4 pixel;
  void main(){float bit=floor(gl_FragCoord.x);vec2 uv=bit<16.0?vec2((bit+.5)/16.0,.4):vec2(.5,.5);pixel=texture(picture,uv);}`));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? "Probe linking failed");
  gl.useProgram(program); gl.viewport(0, 0, 17, 1);
  const texture = gl.createTexture()!; gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const waiting: Probe[] = [], pool: WebGLBuffer[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined, skipped = 0;
  const collect = () => {
    timer = undefined;
    while (waiting.length) {
      const item = waiting[0], status = gl.clientWaitSync(item.fence, 0, 0);
      if (status === gl.TIMEOUT_EXPIRED) break;
      waiting.shift(); gl.deleteSync(item.fence);
      if (status === gl.WAIT_FAILED) { postMessage({ type: "probe-error", error: "GPU measurement fence failed" }); continue; }
      const pixels = new Uint8Array(68);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, item.buffer); gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, pixels);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null); pool.push(item.buffer);
      if (item.timestamp <= lastTimestamp) continue; lastTimestamp = item.timestamp;
      const color = Array.from(pixels.subarray(64, 67), value => value > 128 ? 255 : 0).join(",");
      if (color !== lastColor) { lastColor = color; postMessage({ type: "pixel", color, at: item.at,
        submittedHostAt: item.at + clockOffset, confirmedHostAt: performance.now() + clockOffset, clockUncertaintyMs }); }
      let marker = 0;
      for (let bit = 0; bit < 16; bit++) if (pixels[bit * 4] > 128 && pixels[bit * 4 + 1] > 128 && pixels[bit * 4 + 2] > 128) marker |= 1 << bit;
      if (marker !== lastMarker) { lastMarker = marker; postMessage({ type: "marker", marker, at: item.at }); }
    }
    if (waiting.length) timer = setTimeout(collect, 1);
  };
  return (frame: VideoFrame) => {
    // The decoder may deliver a healthy burst of up to 13 frames before this
    // timer gets a turn. Keep enough tiny PBOs to observe that burst instead of
    // making the measurement instrument discard frames that the player drew.
    if (waiting.length >= 16) { postMessage({ type: "probe-skipped", skipped: ++skipped }); return; }
    const at = performance.now();
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frame);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    const buffer = pool.pop() ?? gl.createBuffer()!;
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buffer); gl.bufferData(gl.PIXEL_PACK_BUFFER, 68, gl.STREAM_READ);
    gl.readPixels(0, 0, 17, 1, gl.RGBA, gl.UNSIGNED_BYTE, 0);
    const fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0)!;
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null); gl.flush();
    waiting.push({ buffer, fence, at, timestamp: frame.timestamp });
    if (!timer) timer = setTimeout(collect, 1);
  };
}

onmessage = async ({ data }) => {
  if (data.type === "start") {
    // Diagnostic clock mapping only. The acceptance metric remains the conservative
    // host ACK, including GPU confirmation and report transport.
    for (let sample = 0; sample < 9; sample++) {
      const before = performance.now();
      const { hostTime } = await (await fetch("/clock", { cache: "no-store" })).json();
      const after = performance.now(), uncertainty = (after - before) / 2;
      if (uncertainty < clockUncertaintyMs) { clockOffset = hostTime - (before + after) / 2; clockUncertaintyMs = uncertainty; }
    }
    postMessage({ type: "clock", clockOffset, clockUncertaintyMs });
    const probe = createProbe();
    engine = new MirrorVideoEngine(data.canvas, data.serial, 1, event => postMessage(event), (_context, _width, _height, frame) => probe(frame)); engine.start();
  } else if (data.type === "stop") engine?.stop();
  else if (data.type === "reconnect") engine?.reconnect();
};
