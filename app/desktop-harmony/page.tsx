import { MirrorWindow } from "@/components/workspace/harmony/MirrorWindow";
import { I18nProvider } from "@/hooks/useI18n";
export default function Page() { return <I18nProvider><MirrorWindow /></I18nProvider>; }
