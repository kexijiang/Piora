"use client";
import { useI18n } from "@/hooks/useI18n";
import { modelErrorMessage } from "@/lib/model-error-message";

export function ModelErrorText({ value }: { value: string }) {
  const { locale } = useI18n();
  const result = modelErrorMessage(value, locale);
  return <span style={{ overflowWrap: "anywhere" }}>{result.summary}{result.detail ? <span title={result.detail} style={{ display: "block", marginTop: 4, opacity: .7, fontSize: ".9em", whiteSpace: "pre-wrap" }}>{locale === "zh-CN" ? "详细信息：" : "Details: "}{result.detail}</span> : null}</span>;
}
