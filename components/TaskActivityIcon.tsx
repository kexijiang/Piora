"use client";

import { useId } from "react";

const animationCss = `
    .piora-task-orbit { transform-origin:64px 64px; animation:piora-task-orbit 1.8s linear infinite; }
    .piora-task-breath { transform-origin:512px 512px; animation:piora-task-breath 2.4s ease-in-out infinite; }
    @keyframes piora-task-orbit { from{transform:rotate(-90deg)} to{transform:rotate(270deg)} }
    @keyframes piora-task-breath { 0%,100%{transform:scale(1)} 25%{transform:scale(1.015)} 75%{transform:scale(.985)} }
    .piora-task-trace-0{animation:piora-task-trace-0 2.4s linear infinite;animation-delay:0s} @keyframes piora-task-trace-0{from{stroke-dashoffset:616.4}to{stroke-dashoffset:-616.4}}
.piora-task-trace-1{animation:piora-task-trace-1 2.4s linear infinite;animation-delay:0.552s} @keyframes piora-task-trace-1{from{stroke-dashoffset:553.15}to{stroke-dashoffset:-553.15}}
.piora-task-trace-2{animation:piora-task-trace-2 2.4s linear infinite;animation-delay:1.104s} @keyframes piora-task-trace-2{from{stroke-dashoffset:562.3499999999999}to{stroke-dashoffset:-562.3499999999999}}
    @media(prefers-reduced-motion:reduce){.piora-task-orbit,.piora-task-breath,.piora-task-trace{animation:none}.piora-task-trace{display:none}}
  `;

/** Inline SVG keeps reduced-motion changes live and gradients unique per chat. */
export function TaskActivityIcon() {
  const id = useId();
  return (
<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 128 128" aria-hidden="true" focusable="false" data-task-running-icon style={{ flexShrink: 0 }}>
    <style>{animationCss}</style>
    <defs>
      <linearGradient id={`${id}-orbit`} x1="64" y1="10" x2="118" y2="64" gradientUnits="userSpaceOnUse">
        <stop stopColor="#8b73f8" stopOpacity=".15"/>
        <stop offset=".5" stopColor="#8b73f8" stopOpacity=".65"/>
        <stop offset="1" stopColor="#8970f5"/>
      </linearGradient>
    </defs>
    <circle cx="64" cy="64" r="54" fill="none" stroke="var(--text-muted, #8273d6)" strokeOpacity=".22" strokeWidth="3"/>
    <svg data-task-icon-core x="26" y="26" width="76" height="76" viewBox="0 0 1024 1024" overflow="visible">
      <g className="piora-task-breath">
  <defs>
    <linearGradient id={`${id}-bg`} x1="128" y1="96" x2="896" y2="928" gradientUnits="userSpaceOnUse">
      <stop stopColor="#17162F"/>
      <stop offset="0.52" stopColor="#0D1630"/>
      <stop offset="1" stopColor="#07111F"/>
    </linearGradient>
    <radialGradient id={`${id}-aura`} cx="0" cy="0" r="1" gradientTransform="translate(760 210) rotate(132) scale(570 520)" gradientUnits="userSpaceOnUse">
      <stop stopColor="#7C5CFF" stopOpacity="0.38"/>
      <stop offset="0.46" stopColor="#4B3CC4" stopOpacity="0.13"/>
      <stop offset="1" stopColor="#10162B" stopOpacity="0"/>
    </radialGradient>
    <linearGradient id={`${id}-pi`} x1="230" y1="264" x2="810" y2="807" gradientUnits="userSpaceOnUse">
      <stop stopColor="#FFF3DC"/>
      <stop offset="0.32" stopColor="#EFCBFF"/>
      <stop offset="0.68" stopColor="#B69AFF"/>
      <stop offset="1" stopColor="#68E4FF"/>
    </linearGradient>
    <linearGradient id={`${id}-shine`} x1="250" y1="265" x2="770" y2="700" gradientUnits="userSpaceOnUse">
      <stop stopColor="#FFFFFF" stopOpacity="0.72"/>
      <stop offset="0.58" stopColor="#FFFFFF" stopOpacity="0.08"/>
      <stop offset="1" stopColor="#FFFFFF" stopOpacity="0"/>
    </linearGradient>
    <filter id={`${id}-softGlow`} x="-25%" y="-25%" width="150%" height="150%" colorInterpolationFilters="sRGB">
      <feGaussianBlur stdDeviation="24"/>
    </filter>
  </defs>

  <rect x="48" y="48" width="928" height="928" rx="228" fill={`url(#${id}-bg)`}/>
  <rect x="48" y="48" width="928" height="928" rx="228" fill={`url(#${id}-aura)`}/>
  <path d="M246 310C364 274 655 274 778 310M363 326C362 507 337 680 256 789M655 326C653 523 681 693 790 786"
        fill="none" stroke="#815FFF" strokeOpacity="0.28" strokeWidth="132" strokeLinecap="round" filter={`url(#${id}-softGlow)`}/>
  <path d="M246 310C364 274 655 274 778 310M363 326C362 507 337 680 256 789M655 326C653 523 681 693 790 786"
        fill="none" stroke={`url(#${id}-pi)`} strokeWidth="108" strokeLinecap="round" strokeLinejoin="round"/>
  <path d="M251 296C372 265 650 265 773 296M351 332C349 488 330 631 281 734M644 331C643 493 659 630 718 718"
        fill="none" stroke={`url(#${id}-shine)`} strokeWidth="15" strokeLinecap="round"/>
  <rect x="49.5" y="49.5" width="925" height="925" rx="226.5" fill="none" stroke="#FFFFFF" strokeOpacity="0.09" strokeWidth="3"/>
<path className="piora-task-trace piora-task-trace-0" d="M246 310C364 274 655 274 778 310" fill="none" stroke="#eaffff" strokeWidth="34" strokeLinecap="round" strokeOpacity=".78" strokeDasharray="107.2 1286.3999999999999" strokeDashoffset="616.4"/><path className="piora-task-trace piora-task-trace-1" d="M363 326C362 507 337 680 256 789" fill="none" stroke="#eaffff" strokeWidth="34" strokeLinecap="round" strokeOpacity=".78" strokeDasharray="96.2 1154.3999999999999" strokeDashoffset="553.15"/><path className="piora-task-trace piora-task-trace-2" d="M655 326C653 523 681 693 790 786" fill="none" stroke="#eaffff" strokeWidth="34" strokeLinecap="round" strokeOpacity=".78" strokeDasharray="97.80000000000001 1173.6" strokeDashoffset="562.3499999999999"/></g>
    </svg>
    <g className="piora-task-orbit">
      <path data-task-orbit-arc d="M64 10 A54 54 0 0 1 118 64" fill="none" stroke={`url(#${id}-orbit)`} strokeWidth="8" strokeLinecap="round"/>
      <circle cx="118" cy="64" r="6" fill="#8970f5"/>
      <circle cx="118" cy="64" r="2.5" fill="#f1edff"/>
    </g>
  </svg>
  );
}
