"use client";
import { useEffect, useState } from "react";
import { ClipboardWorkspace } from "@/components/clipboard/ClipboardWorkspace";
import { useTheme } from "@/hooks/useTheme";
import { I18nProvider } from "@/hooks/useI18n";

export default function DesktopClipboardPage() {
  useTheme();
  const [surface, setSurface] = useState<"quick" | "shelf">("quick");
  useEffect(() => { setSurface(new URLSearchParams(location.search).get("surface") === "shelf" ? "shelf" : "quick"); }, []);
  return <I18nProvider><ClipboardWorkspace key={surface} surface={surface} /></I18nProvider>;
}
