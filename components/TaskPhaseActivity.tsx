const animationCss = `
@keyframes piora-phase-breathe {
  0%, 65%, 100% { opacity: .25; transform: translateY(0); }
  30% { opacity: .85; transform: translateY(-1px); }
}
.piora-phase-dot { animation: piora-phase-breathe 1.8s ease-in-out infinite; }
@media (prefers-reduced-motion: reduce) {
  .piora-phase-dot { animation: none; opacity: .5; }
}
`;

/** Decorative, fixed-width motion without changing or re-announcing the phase. */
export function TaskPhaseActivity() {
  return <span data-task-phase-activity aria-hidden="true"
    style={{ display: "inline-flex", alignItems: "center", gap: 3, width: 15, height: 16, flexShrink: 0 }}>
    <style>{animationCss}</style>
    {[0, 1, 2].map(index => <span key={index} className="piora-phase-dot"
      style={{ width: 3, height: 3, borderRadius: "50%", background: "currentColor", animationDelay: `${index * 0.2}s` }} />)}
  </span>;
}
