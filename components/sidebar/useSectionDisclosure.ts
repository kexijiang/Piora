"use client";

import { useEffect, useState } from "react";

/** Load after hydration so the server and first client render agree. */
export function useSectionDisclosure(section: "projects" | "chats" | "rooms") {
  const key = `piora:sidebar-section-collapsed:${section}:v1`;
  const [collapsed, setCollapsed] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    try { setCollapsed(localStorage.getItem(key) === "true"); } catch { /* Optional preference. */ }
    setHydrated(true);
  }, [key]);
  useEffect(() => {
    if (!hydrated) return;
    try { localStorage.setItem(key, String(collapsed)); } catch { /* Still usable without storage. */ }
  }, [collapsed, hydrated, key]);
  return { collapsed, toggle: () => setCollapsed(current => !current) };
}
