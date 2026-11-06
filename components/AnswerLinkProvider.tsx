"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useAnswerLinkPreference } from "@/hooks/useAnswerLinkPreference";
import type { AnswerLinkTarget } from "@/lib/answer-links";

const AnswerLinkContext = createContext<{ target: AnswerLinkTarget; openLink: (url: string) => void } | null>(null);

export function AnswerLinkProvider({ children, openLink }: { children: ReactNode; openLink: (url: string) => void }) {
  const { target } = useAnswerLinkPreference();
  const value = useMemo(() => ({ target, openLink }), [target, openLink]);
  return <AnswerLinkContext.Provider value={value}>{children}</AnswerLinkContext.Provider>;
}

export const useAnswerLinks = () => useContext(AnswerLinkContext);
