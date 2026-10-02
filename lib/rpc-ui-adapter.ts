import {
  Theme,
} from "@earendil-works/pi-coding-agent";
import {
  KeybindingsManager as TuiKeybindingsManager,
  TUI_KEYBINDINGS,
} from "@earendil-works/pi-tui";

// Extensions require complete terminal UI collaborators even though Piora
// renders their output in the web UI. Keep this SDK compatibility boundary
// isolated from the session lifecycle and registry code.
class PlainTextTheme extends Theme {
  constructor() {
    super(
      {
        // Pi's Theme constructor derives optional colors from these base
        // entries before our plain-text overrides run. Keep both fallbacks
        // populated so SDK upgrades cannot feed `undefined` into its ANSI
        // color parser during server startup.
        text: "",
        muted: "",
        thinkingXhigh: "",
      } as ConstructorParameters<typeof Theme>[0],
      {
        selectedBg: "",
        userMessageBg: "",
        customMessageBg: "",
        toolPendingBg: "",
        toolSuccessBg: "",
        toolErrorBg: "",
      },
      "truecolor",
    );
  }

  override fg(...[, text]: Parameters<Theme["fg"]>): string { return text; }
  override bg(...[, text]: Parameters<Theme["bg"]>): string { return text; }
  override style(text: string): string { return text; }
  override bold(text: string): string { return text; }
  override italic(text: string): string { return text; }
  override underline(text: string): string { return text; }
  override inverse(text: string): string { return text; }
  override strikethrough(text: string): string { return text; }
  override getFgAnsi(): string { return ""; }
  override getBgAnsi(): string { return ""; }
  override getThinkingBorderColor(): (text: string) => string {
    return (text) => text;
  }
  override getBashModeBorderColor(): (text: string) => string {
    return (text) => text;
  }
}

export const PLAIN_TEXT_THEME = new PlainTextTheme();
export const CUSTOM_UI_KEYBINDINGS = new TuiKeybindingsManager(TUI_KEYBINDINGS);
