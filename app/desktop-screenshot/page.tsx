import ScreenshotWorkspace from "@/components/screenshot/ScreenshotWorkspace";
import "@/components/screenshot/vendor/styles.css";
import { I18nProvider } from "@/hooks/useI18n";

export default function DesktopScreenshotPage() {
  return <I18nProvider><ScreenshotWorkspace /></I18nProvider>;
}
