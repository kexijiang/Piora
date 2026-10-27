export type MirrorScale = 25 | 50 | 75 | 100;
export interface HarmonyWindowState {
  serial: string; scale: MirrorScale; alwaysOnTop: boolean; open: boolean;
  minimized: boolean; ownerId: string;
  presentation?: "floating" | "sidebar";
}
export interface PioraMessage {
  title: string; message: string; tone?: "info" | "success" | "error" | "confirm";
  preview?: string;
  notificationKey?: string;
  presentation?: "notice";
  durationMs?: number;
  actions: Array<{ id: string; label: string; primary?: boolean }>;
}
export interface HarmonyWindowBridge {
  open(serial: string): Promise<HarmonyWindowState>;
  focus(): Promise<void>;
  close(): Promise<boolean>;
  setPresentation(value: "floating" | "sidebar"): Promise<HarmonyWindowState>;
  selectDevice(serial: string): Promise<HarmonyWindowState>;
  setScale(scale: MirrorScale): Promise<HarmonyWindowState>;
  setAlwaysOnTop(value: boolean): Promise<HarmonyWindowState>;
  getState(): Promise<HarmonyWindowState>;
  reportFrame(input: { serial: string; width: number; height: number }): Promise<void>;
  showMenu(): Promise<void>;
  openWorkbench(): Promise<void>;
  onStateChange(listener: (state: HarmonyWindowState) => void): () => void;
  onCommand(listener: (command: "screenshot" | "record" | "reconnect" | "details") => void): () => void;
}
export interface PioraMessageBridge {
  show(message: PioraMessage): Promise<string | null>;
  get(): Promise<PioraMessage | null>;
  finish(action: string | null): Promise<void>;
}
