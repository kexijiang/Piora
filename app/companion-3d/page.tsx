import { CompanionModelPreview } from "@/components/CompanionModelPreview";
import { I18nProvider } from "@/hooks/useI18n";

export default function Companion3DPage() {
  return <I18nProvider><CompanionModelPreview /></I18nProvider>;
}
