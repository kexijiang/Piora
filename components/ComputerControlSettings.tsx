"use client";
import { useEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";

export function ComputerControlSettings() {
  const { t } = useI18n();
  const [state, setState] = useState<{ supported: boolean; connected: boolean; stopped: boolean; error?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const requestId = useRef(0);
  useEffect(() => {
    if (!window.piDesktop) return;
    let disposed = false;
    const refresh = () => { if (document.hidden) return; const id = requestId.current; void fetch("/api/computer").then(async (response) => {
      if (!response.ok) throw new Error(t("computer.connectionError"));
      const value = await response.json();
      if (!disposed && id === requestId.current) setState(value);
    }).catch((reason) => { if (!disposed && id === requestId.current) setError(String(reason)); }); };
    refresh();
    const timer = window.setInterval(refresh, 3_000);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [t]);
  async function action(value: "connect" | "stop") {
    const id = ++requestId.current;
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/computer", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: value }) });
      const next = await response.json();
      if (!response.ok) throw new Error(next.error ?? t("computer.connectionError"));
      if (id === requestId.current) setState(next);
    } catch (reason) { if (id === requestId.current) setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { if (id === requestId.current) setBusy(false); }
  }
  return <section className="ui-settings-card" aria-labelledby="computer-control-title">
    <div className="ui-settings-card-heading"><h3 id="computer-control-title">{t("computer.title")}</h3><span className="ui-status-badge">Windows-MCP</span></div>
    <p>{t("computer.description")}</p>
    <p>{t("computer.setup")}</p>
    <div className="ui-inline-actions">
      <button type="button" className="ui-button" disabled={busy || !state?.supported} onClick={() => void action("connect")}>{t(busy ? "computer.connecting" : state?.stopped ? "computer.resume" : "computer.connect")}</button>
      <button type="button" className="ui-button" disabled={!state?.supported} onClick={() => void action("stop")}>{t("computer.stop")}</button>
      <span role="status">{t(!state?.supported ? "computer.desktopOnly" : state.stopped ? "computer.stopped" : state.connected ? "computer.connected" : "computer.disconnected")}</span>
    </div>
    {error ? <p className="ui-error" role="alert">{error}</p> : null}
  </section>;
}
