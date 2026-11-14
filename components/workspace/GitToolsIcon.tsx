interface Props {
  name: "branch" | "changes" | "push";
  className?: string;
}

/** Compact Git glyphs share a centered 16px grid and the same stroke weight. */
export function GitToolsIcon({ name, className }: Props) {
  return <svg className={className} width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    {name === "branch" ? <>
      <path d="M4 6v4m8-4v1a3 3 0 0 1-3 3H4" />
      <circle cx="4" cy="4" r="2" />
      <circle cx="4" cy="12" r="2" />
      <circle cx="12" cy="4" r="2" />
    </> : name === "changes" ? <>
      <rect x="3" y="2" width="10" height="12" rx="1.5" />
      <path d="M6 6h4M8 4v4m-2 3h4" />
    </> : <>
      <path d="M8 10V2.5m-3.5 3.5L8 2.5 11.5 6M3 10v2.5a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V10" />
    </>}
  </svg>;
}
