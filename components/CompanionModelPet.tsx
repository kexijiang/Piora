"use client";

import { useEffect, useRef, useState } from "react";
import {
  ACESFilmicToneMapping, AnimationMixer, Box3, DirectionalLight, Group, HemisphereLight,
  LoopOnce, LoopRepeat, Mesh, OrthographicCamera, Scene, SRGBColorSpace,
  Texture, Vector2, Vector3, WebGLRenderer, type AnimationAction, type Object3D, type Quaternion,
} from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import type { CompanionModel3D } from "@/lib/companion-models";
import type { CompanionActivity, CompanionActivityEvent } from "@/lib/companion";
import { findCompanionAlphaHitRegion, padCompanionHitRegion, type NormalizedCompanionHitRegion } from "@/lib/companion-hit-region";
import styles from "./CompanionModelPet.module.css";
import { useI18n } from "@/hooks/useI18n";
import { createCompanionBlink } from "@/lib/companion-blink";
import { createCompanionExpression } from "@/lib/companion-expression";

export interface CompanionModelPetProps {
  model: CompanionModel3D;
  status: CompanionActivity["status"];
  event?: CompanionActivityEvent;
  overlayEvent?: CompanionActivityEvent;
  idleTricks?: boolean;
  motionDirection?: "left" | "right" | null;
  dragging?: boolean;
  previewAnimation?: "Idle" | "Walk" | "Wave" | "Celebrate" | "Sleep" | "Drag" | "Think";
  previewFraming?: "full" | "portrait";
  onHitRegionChange?: (region: NormalizedCompanionHitRegion) => void;
}

function disposeModel(root: Object3D) {
  const textures = new Set<Texture>();
  root.traverse((object) => {
    if (!(object instanceof Mesh)) return;
    object.geometry.dispose();
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      for (const value of Object.values(material)) if (value instanceof Texture) textures.add(value);
      material.dispose();
    }
  });
  for (const texture of textures) {
    texture.dispose();
    if (typeof ImageBitmap !== "undefined" && texture.image instanceof ImageBitmap) texture.image.close();
  }
}

export default function CompanionModelPet(props: CompanionModelPetProps) {
  const { locale } = useI18n();
  const hostRef = useRef<HTMLSpanElement>(null);
  const latest = useRef(props);
  const [state, setState] = useState<"loading" | "ready" | "fallback">("loading");
  useEffect(() => { latest.current = props; }, [props]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const controller = new AbortController();
    let disposed = false;
    let renderer: WebGLRenderer | undefined;
    let model: Object3D | undefined;
    let mixer: AnimationMixer | undefined;
    let resizeObserver: ResizeObserver | undefined;
    let visibilityObserver: IntersectionObserver | undefined;
    let frame = 0;
    let inView = true;
    let invalidate = () => {};
    const pointer = { x: 0, y: 0, movedAt: performance.now() };
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let yaw = 0;
    const pointerMove = (event: PointerEvent) => {
      const rect = host.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      pointer.x = Math.max(-1, Math.min(1, (event.clientX - rect.left - rect.width / 2) / rect.width));
      pointer.y = Math.max(-1, Math.min(1, (event.clientY - rect.top - rect.height / 3) / rect.height));
      pointer.movedAt = performance.now();
    };
    const wheel = (event: WheelEvent) => {
      const rect = host.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) return;
      event.preventDefault();
      yaw += event.deltaY * 0.006;
      invalidate();
    };
    let contextAvailable = true;
    const contextLost = () => { contextAvailable = false; setState("fallback"); cancelAnimationFrame(frame); frame = 0; };
    const resume = () => invalidate();

    const start = async () => {
      const response = await fetch(props.model.url, { signal: controller.signal });
      if (!response.ok) throw new Error("3D pet download failed");
      const gltf = await new GLTFLoader().parseAsync(await response.arrayBuffer(), "");
      if (disposed) { disposeModel(gltf.scene); return; }
      model = gltf.scene;
      mixer = new AnimationMixer(model);
      const actions = new Map(gltf.animations.map((clip) => [clip.name, mixer!.clipAction(clip)]));
      let active: AnimationAction | undefined;
      const play = (name: string, once = false) => {
        const next = actions.get(name) ?? actions.get("Idle");
        if (!next || (next === active && !once)) return;
        if (active && active !== next) active.fadeOut(0.22);
        next.reset().setEffectiveWeight(1).setEffectiveTimeScale(1);
        next.setLoop(once ? LoopOnce : LoopRepeat, once ? 1 : Infinity);
        next.clampWhenFinished = once;
        next.fadeIn(0.22).play();
        active = next;
        host.dataset.animation = name;
      };
      play("Idle");
      mixer.update(0);
      model.updateMatrixWorld(true);
      const bounds = new Box3().setFromObject(model, true);
      const size = bounds.getSize(new Vector3());
      if (!Number.isFinite(size.y) || size.y <= 0) throw new Error("Empty 3D pet");
      const center = bounds.getCenter(new Vector3());
      const scale = 2 / size.y;
      model.scale.multiplyScalar(scale);
      model.position.add(new Vector3(-center.x, -bounds.min.y, -center.z).multiplyScalar(scale));
      const pivot = new Group();
      pivot.add(model);
      const scene = new Scene();
      const portraitRig = props.model.headBone === "DEF-Head";
      scene.add(pivot, new HemisphereLight(0xffffff, portraitRig ? 0x898093 : 0x474059, portraitRig ? 1.6 : 0.85));
      const key = new DirectionalLight(0xfff2e8, portraitRig ? 1.8 : 2.5); key.position.set(-3, 4, 6); scene.add(key);
      const fill = new DirectionalLight(0xffeee6, portraitRig ? 1.3 : 0.85); fill.position.set(3, 1, 6); scene.add(fill);
      const rim = new DirectionalLight(portraitRig ? 0xc3d9f0 : 0x6fdcff, portraitRig ? 0.6 : 1.5); rim.position.set(-3, 3, -2); scene.add(rim);
      const camera = new OrthographicCamera(-1, 1, 2.2, -0.2, 0.1, 30);
      camera.position.set(0, 1, 6); camera.lookAt(0, 1, 0);
      // Camera top/bottom are relative to its centre, leaving room for a hop.
      camera.top = 1.25; camera.bottom = -1.15;
      renderer = new WebGLRenderer({ alpha: true, antialias: true, powerPreference: "low-power" });
      renderer.outputColorSpace = SRGBColorSpace;
      renderer.toneMapping = ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.1;
      renderer.setClearColor(0x000000, 0);
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.domElement.setAttribute("aria-hidden", "true");
      renderer.domElement.addEventListener("webglcontextlost", contextLost);
      host.appendChild(renderer.domElement);
      let framing: CompanionModelPetProps["previewFraming"];
      const resize = () => {
        const rect = host.getBoundingClientRect();
        const width = Math.max(1, rect.width), height = Math.max(1, rect.height);
        renderer!.setSize(width, height, false);
        framing = latest.current.previewFraming;
        const portrait = framing === "portrait";
        camera.position.y = portrait ? 1.76 : 1;
        camera.top = portrait ? 0.27 : 1.25;
        camera.bottom = portrait ? -0.27 : -1.15;
        const halfWidth = (portrait ? 0.27 : 1.2) * width / height;
        camera.left = -halfWidth; camera.right = halfWidth; camera.updateProjectionMatrix();
        invalidate();
      };
      resize();
      resizeObserver = new ResizeObserver(resize); resizeObserver.observe(host);
      let head: Object3D | undefined;
      const blinkTargets: { mesh: Mesh; index: number }[] = [];
      const smileTargets: { mesh: Mesh; index: number }[] = [];
      const eyes: Object3D[] = [];
      const proceduralPoses = new Map<Object3D, Quaternion>();
      const headName = props.model.headBone?.replace(/[^a-z0-9]/gi, "") ?? "mixamorigHead";
      model.traverse((object) => {
        if (object.name.replace(/[^a-z0-9]/gi, "") === headName) head = object;
        if (portraitRig && /^(left|right)eye$/i.test(object.name.replace(/[^a-z0-9]/gi, ""))) eyes.push(object);
        if (object instanceof Mesh && object.morphTargetDictionary?.Blink !== undefined && object.morphTargetInfluences) {
          blinkTargets.push({ mesh: object, index: object.morphTargetDictionary.Blink });
        }
        if (object instanceof Mesh && object.morphTargetDictionary?.Smile !== undefined && object.morphTargetInfluences) {
          smileTargets.push({ mesh: object, index: object.morphTargetDictionary.Smile });
        }
      });
      const blink = createCompanionBlink();
      host.dataset.gazeTargets = String(eyes.length);
      const expression = createCompanionExpression();
      let lastTime = 0, lastHit = 0, lastInteraction = performance.now(), lastTrick = performance.now();
      let transientUntil = 0, lastEventKey = "";
      let pixels = new Uint8Array(0);
      const bufferSize = new Vector2();
      const tick = (now: number) => {
        if (disposed || !contextAvailable || document.hidden || !inView) { frame = 0; return; }
        frame = requestAnimationFrame(tick);
        if (now - lastTime < 1000 / (motion.matches ? 2 : 30)) return;
        const delta = Math.min((now - (lastTime || now)) / 1000, 0.1);
        lastTime = now;
        const current = latest.current;
        if (framing !== current.previewFraming) resize();
        const event = current.overlayEvent ?? current.event;
        if (event && event.key !== lastEventKey) {
          lastEventKey = event.key;
          // Do not replay historical completion on window reload.
          if (Date.now() - event.occurredAt < 15_000) {
            const name = event.kind === "completed" || event.kind === "poke" ? "Celebrate" : event.kind === "failed" ? "Think" : "Wave";
            play(name, true); transientUntil = now + (actions.get(name)?.getClip().duration ?? 2) * 1000;
            lastInteraction = now;
          }
        }
        lastInteraction = Math.max(lastInteraction, pointer.movedAt);
        if (current.dragging || current.motionDirection || current.status !== "idle") lastInteraction = now;
        if (current.previewAnimation) { play(current.previewAnimation); transientUntil = 0; }
        else if (current.dragging) { play("Drag"); transientUntil = 0; }
        else if (current.motionDirection) { play("Walk"); transientUntil = 0; }
        else if (now >= transientUntil) {
          const name = current.status === "waiting" || current.status === "review" || current.status === "failed" ? "Think"
            : current.status === "running" ? "Think" : now - lastInteraction > 60_000 ? "Sleep" : "Idle";
          play(name);
          if (current.idleTricks && current.status === "idle" && name !== "Sleep" && now - lastTrick > 24_000) {
            play("Wave", true); transientUntil = now + 2700; lastTrick = now;
          }
        }
        // Restore the animation pose before adding this frame's gaze, including
        // bones without an animation track so offsets cannot accumulate.
        for (const [bone, pose] of proceduralPoses) bone.quaternion.copy(pose);
        proceduralPoses.clear();
        if (!motion.matches) mixer!.update(delta);
        else mixer!.update(0);
        host.dataset.reducedMotion = String(motion.matches);
        host.dataset.animationTime = (active?.time ?? 0).toFixed(2);
        const sleeping = active === actions.get("Sleep");
        const closure = blink(delta, sleeping, motion.matches);
        for (const target of blinkTargets) target.mesh.morphTargetInfluences![target.index] = closure;
        if (blinkTargets.length) host.dataset.eyeState = closure > 0.9 ? "closed" : "open";
        const gaze = expression({ delta, pointerX: pointer.x, pointerY: pointer.y,
          pointerActive: now - pointer.movedAt < 5000, sleeping,
          reducedMotion: motion.matches || !!current.dragging,
          friendly: active === actions.get("Idle") || active === actions.get("Wave") || active === actions.get("Celebrate") });
        for (const target of smileTargets) target.mesh.morphTargetInfluences![target.index] = gaze.smile;
        host.dataset.gaze = `${gaze.eyesX.toFixed(2)},${gaze.eyesY.toFixed(2)}`;
        const targetYaw = yaw + (current.motionDirection === "left" ? -0.75 : current.motionDirection === "right" ? 0.75 : 0);
        pivot.rotation.y += (targetYaw - pivot.rotation.y) * 0.12;
        if (head && !motion.matches && !current.dragging) {
          proceduralPoses.set(head, head.quaternion.clone());
          head.rotateX(gaze.headY * 0.06); head.rotateY(gaze.headX * 0.11);
        }
        for (const eye of eyes) {
          proceduralPoses.set(eye, eye.quaternion.clone());
          eye.rotateY(gaze.eyesX * 0.10 * (1 - closure));
          eye.rotateX(gaze.eyesY * 0.06 * (1 - closure));
        }
        renderer!.render(scene, camera);
        if (current.onHitRegionChange && now - lastHit >= 250) {
          lastHit = now;
          renderer!.getDrawingBufferSize(bufferSize);
          const width = bufferSize.x, height = bufferSize.y;
          if (pixels.length !== width * height * 4) pixels = new Uint8Array(width * height * 4);
          const gl = renderer!.getContext();
          gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
          const region = findCompanionAlphaHitRegion(pixels, width, height);
          if (region) current.onHitRegionChange(padCompanionHitRegion({ ...region, top: 1 - region.top - region.height }, 0.02));
        }
      };
      invalidate = () => { if (!frame && !document.hidden && inView && !disposed && contextAvailable) { lastTime = 0; frame = requestAnimationFrame(tick); } };
      visibilityObserver = new IntersectionObserver(([entry]) => {
        inView = entry.isIntersecting;
        if (!inView) { cancelAnimationFrame(frame); frame = 0; }
        else invalidate();
      });
      visibilityObserver.observe(host);
      document.addEventListener("visibilitychange", resume);
      window.addEventListener("pointermove", pointerMove, { passive: true });
      window.addEventListener("wheel", wheel, { passive: false });
      setState("ready"); invalidate();
    };
    void start().catch(() => { if (!disposed) setState("fallback"); });
    return () => {
      disposed = true; controller.abort(); cancelAnimationFrame(frame);
      resizeObserver?.disconnect(); visibilityObserver?.disconnect();
      document.removeEventListener("visibilitychange", resume);
      window.removeEventListener("pointermove", pointerMove); window.removeEventListener("wheel", wheel);
      mixer?.stopAllAction();
      if (model) { mixer?.uncacheRoot(model); disposeModel(model); }
      if (renderer) {
        renderer.domElement.removeEventListener("webglcontextlost", contextLost);
        renderer.dispose(); renderer.forceContextLoss(); renderer.domElement.remove();
      }
    };
  }, [props.model.url, props.model.headBone]);

  return <span className={styles.pet} data-testid="companion-model-3d" data-render-state={state}>
    <span ref={hostRef} className={styles.canvas} style={{ visibility: state === "ready" ? "visible" : "hidden" }} />
    {state !== "ready" ? <span className={styles.preview} style={{ backgroundImage: `url("${props.model.previewUrl}")` }} /> : null}
    {state === "fallback" ? <span className={styles.fallbackMessage} role="status">{locale.startsWith("zh") ? "3D 暂不可用 · 静态预览" : "3D unavailable · static preview"}</span> : null}
  </span>;
}
