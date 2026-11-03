import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { MiniAppGeometry, MiniAppScene, MiniAppViewport } from "./frame";
import { validateMiniAppCamera, type MiniAppCamera, type MiniAppCameraState } from "./scene-state";
import type { JsonRecord } from "./json";

/** App-owned renderer. Generated code never receives a renderer, raycaster or DOM node. */
export class MiniAppSceneRenderer {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(45, 1, 0.1, 30_000);
  private readonly objects = new Map<string, { mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>; geometryKey: string }>();
  private readonly groups = new Map<string, THREE.Group>();
  private readonly events = new AbortController();
  private readonly controls?: OrbitControls;
  private readonly toolbar = document.createElement("div");
  private selector?: HTMLSelectElement;
  private initial?: MiniAppCamera;
  private reset = -1;
  private revision = 0;
  private updating = false;
  private disposed = false;
  private connected = true;
  private cameraTimer?: ReturnType<typeof setTimeout>;
  private pendingCamera?: MiniAppCamera;
  private lastCamera?: MiniAppCamera;
  private pointer?: { id: number; x: number; y: number; frame: number; moved: boolean };
  private selectionKey = "";
  private pendingSelection = 0;
  private readonly pointers = new Set<number>();

  constructor(private readonly canvas: HTMLCanvasElement, private readonly view: MiniAppViewport,
    private readonly emit: (event: JsonRecord) => number | void, onLoss: () => void,
    private restored?: MiniAppCameraState, language = "en") {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: "low-power" });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2)); this.renderer.setSize(view.width, view.height, false);
    this.camera.aspect = view.width / view.height;
    this.scene.add(new THREE.AmbientLight(0xffffff, 1.8));
    const light = new THREE.DirectionalLight(0xffffff, 2.5); light.position.set(4, 7, 5); this.scene.add(light);
    const signal = this.events.signal;
    canvas.addEventListener("pointerdown", event => { if(event.isTrusted)this.pointers.add(event.pointerId); }, { signal });
    for(const name of ["pointerup","pointercancel","lostpointercapture"] as const) canvas.addEventListener(name, event => { this.pointers.delete(event.pointerId); }, { signal });
    canvas.addEventListener("webglcontextlost", event => {
      if (this.disposed) return;
      event.preventDefault(); this.release(); onLoss();
    }, { signal });
    this.toolbar.style.cssText = "display:flex;align-items:center;flex-wrap:wrap;gap:.4rem;margin:.5rem 0";
    this.toolbar.setAttribute("role", "group"); this.toolbar.setAttribute("aria-label", view.label);
    const zh = language.toLowerCase().startsWith("zh");
    if (view.picking || view.cameraControls) canvas.tabIndex = 0;
    if (view.picking) {
      this.selector = document.createElement("select");
      this.selector.setAttribute("aria-label", `${view.label} · ${zh ? "选择对象" : "Select object"}`);
      this.selector.addEventListener("change", event => { if (event.isTrusted) this.pick(this.selector!.value || null, this.revision); }, { signal });
      this.toolbar.append(this.selector);
      canvas.addEventListener("pointerdown", event => {
        if (event.isTrusted && event.button === 0) this.pointer = { id: event.pointerId, x: event.clientX, y: event.clientY, frame: this.revision, moved: false };
      }, { signal });
      canvas.addEventListener("pointermove", event => {
        if (this.pointer && event.pointerId === this.pointer.id && Math.hypot(event.clientX - this.pointer.x, event.clientY - this.pointer.y) > 5) this.pointer.moved = true;
      }, { signal });
      canvas.addEventListener("pointerup", event => {
        const start = this.pointer; this.pointer = undefined;
        if (!event.isTrusted || !start || start.id !== event.pointerId || start.moved || start.frame !== this.revision) return;
        const rect = canvas.getBoundingClientRect(); if (!rect.width || !rect.height) return;
        const ray = new THREE.Raycaster(); this.camera.updateMatrixWorld(); this.scene.updateMatrixWorld(true);
        ray.setFromCamera(new THREE.Vector2((event.clientX - rect.left) / rect.width * 2 - 1, 1 - (event.clientY - rect.top) / rect.height * 2), this.camera);
        const candidates = [...this.objects.entries()].filter(([, item]) => item.mesh.material.opacity > 0);
        const hit = ray.intersectObjects(candidates.map(([, item]) => item.mesh), false)[0];
        this.pick(candidates.find(([, item]) => item.mesh === hit?.object)?.[0] ?? null, start.frame);
      }, { signal });
      canvas.addEventListener("pointercancel", () => { this.pointer = undefined; }, { signal });
      // Store a fixed placeholder; object labels come from the validated frame.
      this.selector.dataset.placeholder = zh ? "未选择对象" : "No object selected";
    }
    if (view.cameraControls) {
      // Only native user gestures reach OrbitControls; generated content has no scripts.
      for (const name of ["pointerdown", "pointermove", "pointerup", "wheel"] as const) canvas.addEventListener(name, event => { if (!event.isTrusted) event.stopImmediatePropagation(); }, { capture: true, signal });
      this.controls = new OrbitControls(this.camera, canvas);
      this.controls.enableDamping = false; this.controls.enablePan = false;
      this.controls.minDistance = 0.05; this.controls.maxDistance = 10_000;
      this.controls.minPolarAngle = 0.001; this.controls.maxPolarAngle = Math.PI - 0.001;
      this.controls.addEventListener("change", () => { if (!this.updating) this.cameraChanged(); });
      const actions: Array<[string, string, string]> = [["left", "←", zh ? "向左旋转" : "Rotate left"], ["right", "→", zh ? "向右旋转" : "Rotate right"], ["up", "↑", zh ? "向上旋转" : "Rotate up"], ["down", "↓", zh ? "向下旋转" : "Rotate down"], ["in", "+", zh ? "放大" : "Zoom in"], ["out", "−", zh ? "缩小" : "Zoom out"], ["reset", "↺", zh ? "恢复初始镜头" : "Reset camera"]];
      for (const [id, text, label] of actions) {
        const button = document.createElement("button"); button.type = "button"; button.textContent = text; button.setAttribute("aria-label", `${view.label} · ${label}`);
        button.addEventListener("click", event => { if (event.isTrusted) this.adjust(id); }, { signal }); this.toolbar.append(button);
      }
      canvas.addEventListener("keydown", event => {
        const action = ({ ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down", "+": "in", "=": "in", "-": "out", Home: "reset" } as Record<string, string>)[event.key];
        if (event.isTrusted && action) { event.preventDefault(); event.stopPropagation(); this.adjust(action); }
      }, { signal });
    }
  }

  attach(): void { if (this.view.picking || this.view.cameraControls) this.canvas.after(this.toolbar); }
  private geometry(value: MiniAppGeometry): THREE.BufferGeometry {
    switch (value.kind) {
      case "box": return new THREE.BoxGeometry(...value.size);
      case "sphere": return new THREE.SphereGeometry(value.radius, value.segments, value.segments);
      case "cylinder": return new THREE.CylinderGeometry(value.radiusTop, value.radiusBottom, value.height, value.segments);
      case "plane": return new THREE.PlaneGeometry(value.width, value.height);
      case "mesh": {
        const geometry = new THREE.BufferGeometry(); geometry.setAttribute("position", new THREE.Float32BufferAttribute(value.positions, 3));
        if (value.indices) geometry.setIndex(value.indices); geometry.computeVertexNormals(); return geometry;
      }
    }
  }
  private setCamera(value: MiniAppCamera): void {
    this.updating = true;
    try {
      this.camera.position.set(...value.position); this.camera.fov = value.fov;
      if (this.controls) { this.controls.target.set(...value.target); this.controls.update(); }
      else this.camera.lookAt(...value.target);
      this.camera.updateProjectionMatrix();
      if (this.controls) this.lastCamera = this.cameraValue();
    } finally { this.updating = false; }
  }
  private cameraValue(): MiniAppCamera {
    return validateMiniAppCamera({ position: this.camera.position.toArray(), target: this.controls!.target.toArray(), fov: this.camera.fov });
  }
  private draw(): void { if (!this.disposed) this.renderer.render(this.scene, this.camera); }
  private cameraChanged(): void {
    if (!this.initial || this.disposed) return;
    this.camera.position.clampScalar(-10_000, 10_000);
    // At a coordinate boundary clamping must never collapse the eye onto its
    // target. Retain the last valid pose instead of throwing from a DOM event.
    const distance = this.camera.position.distanceTo(this.controls!.target);
    if (distance < 0.05 || distance > 10_000) { if (this.lastCamera) this.setCamera(this.lastCamera); return; }
    const value = this.cameraValue(); this.pendingCamera = value; this.draw();
    this.lastCamera = value;
    if (!this.cameraTimer) this.cameraTimer = setTimeout(() => this.flushCamera(), 1000 / 30);
  }
  private flushCamera(): void {
    if (this.cameraTimer) clearTimeout(this.cameraTimer); this.cameraTimer = undefined;
    const camera = this.pendingCamera; this.pendingCamera = undefined;
    if (camera && !this.disposed) this.emit({ type: "scene-camera", id: this.view.id, reset: this.reset, camera: camera as unknown as JsonRecord });
  }
  private adjust(action: string): void {
    if (!this.initial || !this.controls) return;
    if (action === "reset") this.setCamera(this.initial);
    else {
      const sphere = new THREE.Spherical().setFromVector3(this.camera.position.clone().sub(this.controls.target));
      if (action === "left") sphere.theta -= Math.PI / 12;
      if (action === "right") sphere.theta += Math.PI / 12;
      if (action === "up") sphere.phi -= Math.PI / 12;
      if (action === "down") sphere.phi += Math.PI / 12;
      if (action === "in") sphere.radius *= 0.8;
      if (action === "out") sphere.radius /= 0.8;
      sphere.radius = Math.max(0.05, Math.min(10_000, sphere.radius)); sphere.makeSafe();
      const position = new THREE.Vector3().setFromSpherical(sphere).add(this.controls.target).clampScalar(-10_000, 10_000);
      const distance = position.distanceTo(this.controls.target);
      if (distance < 0.05 || distance > 10_000) return;
      this.setCamera({ position: position.toArray(), target: this.controls.target.toArray(), fov: this.camera.fov });
    }
    this.cameraChanged();
  }
  private pick(object: string | null, frame: number): void {
    if (this.disposed) return;
    if (this.selector) this.selector.value = object ?? "";
    const serial = this.emit({ type: "scene-pick", id: this.view.id, object, frame });
    if (typeof serial === "number") this.pendingSelection = serial;
  }
  update(value: MiniAppScene, revision: number, acknowledged = 0): void {
    this.revision = revision;
    const visible = new Set(value.meshes.map(mesh => mesh.id));
    for (const [id, item] of this.objects) if (!visible.has(id)) { item.mesh.removeFromParent(); item.mesh.geometry.dispose(); item.mesh.material.dispose(); this.objects.delete(id); }
    const groupIds = new Set(value.groups?.map(group => group.id));
    for (const [id, group] of this.groups) if (!groupIds.has(id)) { group.removeFromParent(); this.groups.delete(id); }
    // Create every node before connecting parents, so declaration order is irrelevant.
    for (const data of value.groups ?? []) if (!this.groups.has(data.id)) this.groups.set(data.id, new THREE.Group());
    // Disconnect changed edges first: reversing a parent relationship must not
    // temporarily create a cycle in Three's live object graph.
    for (const data of value.groups ?? []) {
      const group = this.groups.get(data.id)!, parent = data.parent === undefined ? this.scene : this.groups.get(data.parent)!;
      if (group.parent !== parent) group.removeFromParent();
    }
    for (const data of value.groups ?? []) {
      const group = this.groups.get(data.id)!, parent = data.parent === undefined ? this.scene : this.groups.get(data.parent)!;
      if (group.parent !== parent) parent.add(group);
      group.position.set(...data.position); group.rotation.set(...data.rotation); group.scale.set(...data.scale);
    }
    for (const data of value.meshes) {
      let item = this.objects.get(data.id); const geometryKey = JSON.stringify(data.geometry);
      if (!item) {
        const mesh = new THREE.Mesh(this.geometry(data.geometry), new THREE.MeshStandardMaterial({ roughness: 0.65, metalness: 0.05, side: THREE.DoubleSide }));
        item = { mesh, geometryKey }; this.objects.set(data.id, item); this.scene.add(mesh);
      } else if (item.geometryKey !== geometryKey) { item.mesh.geometry.dispose(); item.mesh.geometry = this.geometry(data.geometry); item.geometryKey = geometryKey; }
      item.mesh.position.set(...data.position); item.mesh.rotation.set(...data.rotation); item.mesh.scale.set(...data.scale);
      const parent = data.parent === undefined ? this.scene : this.groups.get(data.parent)!;
      if (item.mesh.parent !== parent) parent.add(item.mesh);
      item.mesh.material.color.set(data.color); item.mesh.material.opacity = data.opacity ?? 1; item.mesh.material.transparent = (data.opacity ?? 1) < 1;
    }
    if (this.selector) {
      const options = JSON.stringify(value.meshes.map(mesh => [mesh.id, mesh.label]));
      if (options !== this.selectionKey) {
        const selected = this.selector.value; this.selector.replaceChildren(new Option(this.selector.dataset.placeholder, ""));
        for (const mesh of value.meshes) this.selector.add(new Option(mesh.label ?? mesh.id, mesh.id));
        this.selector.value = visible.has(selected) ? selected : ""; this.selectionKey = options;
      }
      // An older projection must not move a native select backwards while the
      // user is still navigating. The shared host event acknowledgement also
      // settles rejected stale selections and task resets.
      const selected = value.selected ?? "";
      // Reassigning an equal select value can reset the native popup's pending
      // keyboard highlight before it emits change. Leave that browser state
      // intact when there is no actual authoritative value change.
      if (acknowledged >= this.pendingSelection && this.selector.value !== selected) this.selector.value = selected;
    }
    if (!this.controls) this.setCamera(value.camera);
    else if (this.reset !== (value.cameraRevision ?? 0)) {
      const first = this.reset === -1; this.release(); this.reset = value.cameraRevision ?? 0;
      this.initial = value.camera;
      this.setCamera(first && this.restored?.reset === this.reset ? this.restored.camera : value.camera);
    }
    this.draw();
  }
  /** Release capture and OrbitControls' internal drag state on blur/save/stop. */
  release(): void {
    this.pointer = undefined; this.flushCamera();
    for(const id of this.pointers) { try { if(this.canvas.hasPointerCapture(id))this.canvas.releasePointerCapture(id); } catch { /* Browser may already have released capture. */ } }
    this.pointers.clear();
    if (this.controls && this.connected) { this.controls.disconnect(); this.connected = false; }
    if (this.controls && !this.disposed) { this.controls.connect(this.canvas); this.connected = true; }
  }
  resetView(): void { this.release(); this.reset = -1; this.restored = undefined; }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.events.abort();
    if (this.cameraTimer) clearTimeout(this.cameraTimer); this.cameraTimer = undefined; this.pendingCamera = undefined;
    this.controls?.dispose(); this.toolbar.remove();
    for (const { mesh } of this.objects.values()) { mesh.geometry.dispose(); mesh.material.dispose(); }
    this.objects.clear(); this.groups.clear(); this.scene.clear(); this.renderer.dispose(); this.renderer.forceContextLoss();
  }
}
