import { requestConfirmation } from "./ConfirmDialog";
import type { TranslationParams } from "@/lib/i18n/types";

export async function confirmSessionDeletion(id: string, title: string, t: (key: string, params?: TranslationParams) => string): Promise<string[] | null> {
  const response = await fetch(`/api/sessions/${encodeURIComponent(id)}/deletion`, { cache: "no-store" });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  const confirmed = await requestConfirmation({
    title: t("trash.moveTitle"),
    message: t("trash.confirm", { title, count: body.count, running: body.running }),
    confirmLabel: t("sidebar.delete"),
    tone: "danger",
  });
  return confirmed ? body.sessionIds as string[] : null;
}
