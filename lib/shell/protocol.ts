export interface ShellIntegrationMessage {
  type: "ready" | "start" | "prompt" | "catalog";
  cwd?: string;
  command?: string;
  id?: string;
  exitCode?: number;
  rawCapture?: boolean;
  commands?: string[];
}

/** Incremental OSC parser; ConPTY/network chunks can split anywhere, including ESC. */
export class ShellProtocolParser {
  private pending = "";
  constructor(private token: string, private onMessage: (message: ShellIntegrationMessage) => void, private onOutput?: (data: string) => void) {}
  push(chunk: string): string {
    this.pending += chunk;
    let output = "";
    while (this.pending) {
      const start = this.pending.indexOf("\x1b]");
      if (start < 0) {
        const keep = this.pending.endsWith("\x1b") ? 1 : 0;
        output += this.pending.slice(0, this.pending.length - keep);
        this.pending = keep ? "\x1b" : "";
        break;
      }
      output += this.pending.slice(0, start);
      this.pending = this.pending.slice(start);
      const bell = this.pending.indexOf("\x07", 2), st = this.pending.indexOf("\x1b\\", 2);
      const end = bell < 0 ? st : st < 0 ? bell : Math.min(bell, st);
      if (end < 0) {
        if (this.pending.length > 128 * 1024) { output += this.pending; this.pending = ""; }
        break;
      }
      const suffix = end === st ? 2 : 1;
      const whole = this.pending.slice(0, end + suffix);
      const content = this.pending.slice(2, end);
      this.pending = this.pending.slice(end + suffix);
      const prefix = `633;Piora;${this.token};`;
      if (!content.startsWith(prefix)) { output += whole; continue; }
      try {
        const parts = content.slice(prefix.length).split(";");
        const [type, encodedCwd, status, id, encodedCommand] = parts;
        const cwd = Buffer.from(encodedCwd || "", "base64").toString("utf8");
        if (!["ready", "start", "prompt", "catalog"].includes(type)) continue;
        if (this.onOutput && output) { this.onOutput(output); output = ""; }
        this.onMessage({ type: type as ShellIntegrationMessage["type"], cwd,
          ...(type === "prompt" ? { exitCode: /^-?\d+$/.test(status) ? Number(status) : undefined } : {}),
          ...(type === "start" ? { id: /^[\w:.-]{1,160}$/.test(id || "") ? id : undefined, command: Buffer.from(encodedCommand || "", "base64").toString("utf8") } : {}),
          ...(type === "ready" ? { rawCapture: status === "1" } : {}),
          ...(type === "catalog" ? { commands: [...new Set(Buffer.from(encodedCommand || "", "base64").toString("utf8").split(/\r?\n/).filter(name => name.length > 0 && name.length <= 256 && !/^__piora/i.test(name) && !/[\x00-\x20]/.test(name)))].slice(0, 2000) } : {}),
        });
      } catch { /* Malformed protocol never certifies command completion. */ }
    }
    if (this.onOutput && output) { this.onOutput(output); return ""; }
    return output;
  }
  flush(): string { const pending = this.pending; this.pending = ""; return pending; }
}
