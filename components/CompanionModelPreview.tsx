"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useCompanionPets } from "@/hooks/useCompanionPets";
import { useI18n } from "@/hooks/useI18n";
import { useCompanionPreferences } from "@/hooks/useCompanionPreferences";
import styles from "./CompanionModelPreview.module.css";

const ModelPet = dynamic(() => import("./CompanionModelPet"), { ssr: false });
const ACTIONS = [
  ["Idle", "待机", "Idle"], ["Walk", "散步", "Walk"], ["Wave", "挥手", "Wave"],
  ["Celebrate", "庆祝", "Celebrate"], ["Sleep", "困倦", "Sleepy"], ["Drag", "被提起", "Picked up"], ["Think", "思考", "Thinking"],
] as const;

export function CompanionModelPreview() {
  const { locale } = useI18n();
  const zh = locale.startsWith("zh");
  const { catalog, loading, error } = useCompanionPets(true);
  const { preferences, setPreferences, hydrated } = useCompanionPreferences();
  const [selected, setSelected] = useState("yor-clean-3d");
  const [animation, setAnimation] = useState<typeof ACTIONS[number][0]>("Idle");
  const [framing, setFraming] = useState<"full" | "portrait">("full");
  const pets = catalog?.installed.filter((pet) => pet.model3d) ?? [];
  const pet = pets.find((item) => item.id === selected) ?? pets[0];
  const yor = pet?.id?.startsWith("yor-");
  const tripoYor = pet?.id === "yor-v25-3d";

  return <main className={styles.page}>
    <header className={styles.header}><Link href="/">PIORA</Link><span>{zh ? "桌宠实验室 / 01" : "COMPANION LAB / 01"}</span></header>
    <section className={styles.layout}>
      <div className={styles.copy}>
        <span className={styles.eyebrow}>{zh ? "一个新伙伴" : "MEET YOUR COMPANION"}</span>
        <h1>{yor ? "YOR" : "JINX"}<span>{yor ? (zh ? "约尔，来到你的桌面。" : "Yor, right by your side.") : (zh ? "金克斯，来到你的桌面。" : "A little chaos. On your desktop.")}</span></h1>
        <p>{yor ? (zh ? "黑发、红眸与金色花饰。转动视角看看她，试试招呼和歪头，让她陪你工作。" : "Black hair, crimson eyes and golden roses. Turn her around, say hello, and work together.") : (zh ? "蓝色长辫、标志性的坏笑。让她打个招呼，陪你思考，再为完成的任务庆祝。" : "Blue braids and a familiar grin. Say hello, think together, and celebrate a job well done.")}</p>
        <div className={styles.actions} aria-label={zh ? "动作选择" : "Choose an animation"}>
          {ACTIONS.map(([id, chinese, english]) => <button key={id} type="button" aria-pressed={animation === id} onClick={() => setAnimation(id)}>{yor && id === "Walk" ? (zh ? "轻摇" : "Sway") : tripoYor && id === "Wave" ? (zh ? "点头" : "Nod") : zh ? chinese : english}</button>)}
        </div>
        <div className={styles.hints}>
          <p><b>01</b> {zh ? "移动鼠标，她会看向你。" : "Move your cursor. She follows your gaze."}</p>
          <p><b>02</b> {zh ? "鼠标放到角色上，滚轮可转身。" : "Scroll over the character to turn her around."}</p>
          <p><b>03</b> {zh ? `点击下方按钮，将「${pet?.displayName ?? "角色"}」设为桌宠。` : "Use the button below to choose this companion."}</p>
        </div>
        <div className={styles.actions} aria-label={zh ? "查看方式" : "View"}>
          <button type="button" aria-pressed={framing === "full"} onClick={() => setFraming("full")}>{zh ? "全身" : "Full body"}</button>
          <button type="button" aria-pressed={framing === "portrait"} onClick={() => setFraming("portrait")}>{zh ? "近看" : "Close up"}</button>
        </div>
        <button className={styles.usePet} type="button" disabled={!hydrated || !pet || preferences.selectedPetId === pet.id}
          onClick={() => { if (pet) setPreferences((current) => ({ ...current, selectedPetId: pet.id })); }}>
          {preferences.selectedPetId === pet?.id ? (zh ? "已设为桌宠" : "Current companion") : (zh ? "设为桌宠" : "Use as companion")}
        </button>
        {pets.length > 1 ? <select aria-label={zh ? "角色" : "Character"} value={pet?.id} onChange={(event) => setSelected(event.target.value)}>{pets.map((item) => <option key={item.id} value={item.id}>{item.displayName}</option>)}</select> : null}
      </div>
      <div className={styles.stage}>
        <span className={styles.ring} aria-hidden="true" />
        <div className={styles.character}>
          {pet?.model3d ? <ModelPet key={pet.sourceKey} model={pet.model3d} status="idle" previewAnimation={animation} previewFraming={framing} />
            : <p role="status">{error ?? (loading ? (zh ? "正在迎接新伙伴…" : "Loading your companion…") : (zh ? "尚未安装 3D 角色。" : "No 3D companion installed."))}</p>}
        </div>
        <span className={styles.caption}>{pet?.displayName ?? "3D"}<span>{tripoYor && animation === "Wave" ? (zh ? "点头" : "Nod") : yor && animation === "Walk" ? (zh ? "轻摇" : "Sway") : ACTIONS.find(([id]) => id === animation)?.[zh ? 1 : 2]}</span></span>
      </div>
    </section>
    <footer className={styles.footer}>{yor ? (tripoYor ? "Yor Forger fan art · Tripo v2.5 / Blender · Personal, non-commercial use" : "Yor Forger fan art · VR Avatars / BlenderKit · Personal, non-commercial use") : "Jinx fan art · Model by Abhay Pratap / Blendkit · Piora animation adaptation"}</footer>
  </main>;
}
