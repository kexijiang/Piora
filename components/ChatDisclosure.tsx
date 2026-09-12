"use client";

import { useId, type ButtonHTMLAttributes, type HTMLAttributes, type ReactNode } from "react";
import { AliIcon, type AliIconName } from "./AliIcon";

export function DisclosureChevron() {
  return <AliIcon name="chevron-right" size={12} className="chat-disclosure-chevron" aria-hidden="true" />;
}

/** Keep the existing reading position when a disclosure changes row height. */
export function togglePreservingScroll(control: HTMLElement, toggle: () => void) {
  const scroller = control.closest(".overflow-y-auto") as HTMLElement | null;
  const scrollTop = scroller?.scrollTop;
  toggle();
  if (!scroller || scrollTop === undefined) return;
  requestAnimationFrame(() => { scroller.scrollTop = scrollTop; });
}

interface TriggerProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  expanded: boolean;
  label: ReactNode;
  icon?: AliIconName;
  description?: ReactNode;
  metadata?: ReactNode;
}

export function ChatDisclosureTrigger({ expanded, label, icon, description, metadata, className = "", ...props }: TriggerProps) {
  return (
    <button {...props} type="button" className={`chat-disclosure-trigger ${className}`.trim()} aria-expanded={expanded}>
      <DisclosureChevron />
      <span className="chat-disclosure-icon" aria-hidden="true">{icon ? <AliIcon name={icon} size={14} /> : null}</span>
      <span className="chat-disclosure-label" title={typeof label === "string" ? label : undefined}>{label}</span>
      <span className="chat-disclosure-description">
        {typeof description === "string" ? <span title={description}>{description}</span> : description}
      </span>
      <span className="chat-disclosure-meta">{metadata}</span>
    </button>
  );
}

interface DisclosureProps extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  label: ReactNode;
  icon?: AliIconName;
  description?: ReactNode;
  metadata?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  variant?: "surface" | "inline";
  contentClassName?: string;
  triggerClassName?: string;
}

/** Presentation only: callers own state, loading, and the lifetime of their content. */
export function ChatDisclosure({ expanded, onExpandedChange, label, icon, description, metadata, actions, children,
  variant = "surface", className = "", contentClassName = "", triggerClassName, ...props }: DisclosureProps) {
  const contentId = useId();
  return (
    <div {...props} className={`chat-disclosure chat-disclosure--${variant}${expanded ? " is-expanded" : ""} ${className}`.trim()}>
      <div className="chat-disclosure-header">
        <ChatDisclosureTrigger label={label} icon={icon} description={description} metadata={metadata}
          className={triggerClassName} expanded={expanded} aria-controls={contentId}
          onClick={(event) => togglePreservingScroll(event.currentTarget, () => onExpandedChange(!expanded))} />
        {actions ? <div className="chat-disclosure-actions">{actions}</div> : null}
      </div>
      {expanded ? <div id={contentId} className={`chat-disclosure-content ${contentClassName}`.trim()}>{children}</div> : null}
    </div>
  );
}

/** Shrink the directory before the basename; the tooltip always retains the full path. */
export function DisclosurePath({ path }: { path: string }) {
  const separator = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return <span className="chat-disclosure-path" title={path}>
    {separator >= 0 ? <span className="chat-disclosure-directory">{path.slice(0, separator + 1)}</span> : null}
    <span className="chat-disclosure-basename">{path.slice(separator + 1)}</span>
  </span>;
}
