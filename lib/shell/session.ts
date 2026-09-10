import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { IPty } from "node-pty";
import { loadTerminalPty } from "../terminal-pty";
import { ShellStore, shellDataDirectory } from "./store";
import { ShellError, shellId, shellText } from "./errors";
import { ShellProtocolParser, type ShellIntegrationMessage } from "./protocol";
import { encodeShellSubmission, prepareShellLaunch } from "./profiles";
import type { CommandBlock, HistoryRecord, ShellEvent, ShellRun, ShellSession, ShellSnapshot } from "./types";

type EventBody = ShellEvent extends infer E ? E extends ShellEvent ? Omit<E, "terminalId" | "generation" | "sequence"> : never : never;
const MAX_OUTPUT = 500_000;
const MAX_BLOCK_OUTPUT = 128_000;

export class ManagedShellSession {
  private child: IPty | null = null;
  private parser: ShellProtocolParser | null = null;
  private listeners = new Set<(event: ShellEvent) => void>();
  private sequence = 0;
  private output = "";
  private commands: CommandBlock[] = [];
  private runs: ShellRun[] = [];
  private starting: Promise<void> | null = null;
  private integrationReady: Promise<void> = Promise.resolve();
  private readyResolve: (() => void) | null = null;
  private serialized: Promise<unknown> = Promise.resolve();
  private persistence: Promise<unknown> = Promise.resolve();
  private storageError: string | null = null;
  private flushTimer: NodeJS.Timeout | null = null;
  private cols = 100;
  private rows = 30;
  private rawCapture = false;
  private liveCommands: string[] = [];
  private protocolReplied = false;
  private lastActivity = Date.now();
  private idleTimer: NodeJS.Timeout;
  private closedProcess: Promise<void> = Promise.resolve();

  constructor(readonly state: ShellSession, readonly store: ShellStore, private dataDirectory = shellDataDirectory()) {
    this.idleTimer = setInterval(() => {
      if (!this.listeners.size && !this.state.activeCommandId && !this.state.activeRunId && Date.now() - this.lastActivity > 20 * 60_000) void this.stop();
    }, 60_000);
    this.idleTimer.unref();
  }
  async hydrate(): Promise<void> {
    const [commands, runs] = await Promise.all([this.store.list<CommandBlock>("command", this.state.id, 100), this.store.list<ShellRun>("run", this.state.id, 50)]);
    this.commands = commands.reverse(); this.runs = runs.reverse();
  }
  snapshot(): ShellSnapshot { return { session: { ...this.state }, commands: this.commands.map(item => ({ ...item })), runs: this.runs.map(item => ({ ...item })), output: this.output, sequence: this.sequence }; }
  commandNames(): readonly string[] { return this.liveCommands; }
  subscribe(listener: (event: ShellEvent) => void): () => void {
    this.listeners.add(listener); this.lastActivity = Date.now();
    return () => { this.listeners.delete(listener); this.lastActivity = Date.now(); };
  }
  private emit(body: EventBody): void {
    const event = { ...body, terminalId: this.state.id, generation: this.state.generation, sequence: ++this.sequence } as ShellEvent;
    for (const listener of this.listeners) { try { listener(event); } catch { /* A detached renderer cannot break the runtime. */ } }
  }
  private persist(task: () => Promise<unknown>): void {
    this.persistence = this.persistence.then(task).catch(error => {
      this.storageError = error instanceof Error ? error.message : String(error);
      this.emit({ type: "error", error: `Shell storage: ${this.storageError}` });
    });
  }
  private changed(): void {
    this.state.updatedAt = Date.now();
    const session = { ...this.state };
    this.persist(() => this.store.put("session", session.id, session));
    this.emit({ type: "session", session });
  }
  private exclusive<T>(action: () => Promise<T>): Promise<T> {
    const result = this.serialized.then(action);
    this.serialized = result.catch(() => {}); return result;
  }
  private assertStorage(): void { if (this.storageError) throw new ShellError(`Shell storage unavailable: ${this.storageError}`, 503, "storage_unavailable"); }
  async start(): Promise<void> {
    await this.connect();
    await this.integrationReady;
  }
  /** Connect the PTY without waiting for profiles or the first integrated prompt. */
  async connect(): Promise<void> {
    if (this.starting) return this.starting;
    if (this.child) return;
    this.starting = this.launch().finally(() => { this.starting = null; });
    return this.starting;
  }
  private async launch(): Promise<void> {
    this.assertStorage();
    const token = randomBytes(24).toString("hex");
    const launch = await prepareShellLaunch(this.state.profile, this.state.id, token, this.dataDirectory);
    this.state.generation += 1;
    const generation = this.state.generation;
    this.state.integration = this.state.profile.integrated ? "starting" : "unavailable";
    this.state.integrationError = this.state.profile.integrated ? null : "This shell supports the native terminal view only.";
    this.protocolReplied = false;
    this.rawCapture = false;
    this.liveCommands = [];
    this.parser = new ShellProtocolParser(token, message => { if (this.state.generation === generation) this.onIntegration(message); }, data => this.append(data));
    const ready = new Promise<void>(resolve => { this.readyResolve = resolve; });
    this.child = loadTerminalPty().spawn(this.state.profile.executable, launch.args, { env: launch.env, cwd: this.state.cwd, name: "xterm-256color", cols: this.cols, rows: this.rows, useConptyDll: process.platform === "win32" });
    this.state.connected = true;
    this.child.onData(data => {
      if (this.state.generation !== generation) return;
      if (!this.protocolReplied && data.includes("\x1b[c")) {
        this.protocolReplied = true; this.child?.write("\x1b[?1;2c"); data = data.replace("\x1b[c", "");
      }
      this.append(this.parser?.push(data) ?? data);
    });
    this.closedProcess = new Promise(resolve => this.child!.onExit(() => {
      resolve();
      if (this.state.generation !== generation) return;
      this.append(this.parser?.flush() || "");
      // ConPTY's natural exit closes output but can retain its input handle and
      // relay worker. Release that owned PTY handle after all output has drained.
      // Unix kill() signals a PID, so it must not run after that process exited.
      if (process.platform === "win32") { try { this.child?.kill(); } catch { /* Native handle already released. */ } }
      this.child = null; this.state.connected = false; this.state.integration = "unavailable";
      this.finishActive("unknown", null); this.readyResolve?.(); this.readyResolve = null; this.changed();
    }));
    this.changed();
    if (!this.state.profile.integrated) { this.readyResolve?.(); this.readyResolve = null; }
    const timeout = setTimeout(() => {
      if (this.state.integration === "starting") {
        this.state.integration = "unavailable";
        this.state.integrationError = "Shell integration did not start. Use the native terminal or choose another shell.";
        this.changed();
      }
      this.readyResolve?.(); this.readyResolve = null;
    }, 30_000);
    this.integrationReady = ready.finally(() => clearTimeout(timeout));
  }
  private onIntegration(message: ShellIntegrationMessage): void {
    if (message.cwd) this.state.cwd = message.cwd;
    if (message.type === "catalog") { this.liveCommands = message.commands || []; return; }
    if (message.type === "ready") {
      this.state.integration = "ready"; this.state.integrationError = null; this.rawCapture = message.rawCapture === true;
      this.changed(); return;
    }
    if (message.type === "start") {
      const active = this.commands.find(item => item.id === this.state.activeCommandId);
      if (active?.status === "accepted" && message.id === active.id) {
        active.status = "running"; active.startedAt = Date.now(); active.cwd = this.state.cwd;
        this.updateCommand(active);
      } else if (!active && !message.id && message.command?.trim() && this.rawCapture) {
        const block = this.newBlock(message.command, null, null, "human");
        block.status = "running"; block.startedAt = Date.now();
        this.commands.push(block); this.state.activeCommandId = block.id;
        this.updateCommand(block);
      }
      this.changed();
    } else if (message.type === "prompt") {
      const active = this.commands.find(item => item.id === this.state.activeCommandId);
      if (active?.status === "running") this.finishActive(message.exitCode === 0 ? "completed" : message.exitCode === undefined ? "unknown" : "failed", message.exitCode ?? null);
      this.readyResolve?.(); this.readyResolve = null;
      this.changed();
    }
  }
  private append(data: string): void {
    if (!data) return;
    this.output = (this.output + data).slice(-MAX_OUTPUT);
    const active = this.commands.find(item => item.id === this.state.activeCommandId);
    if (active && active.status === "running") {
      const output = active.output + data;
      active.outputTruncated ||= output.length > MAX_BLOCK_OUTPUT;
      active.output = output.slice(-MAX_BLOCK_OUTPUT);
      if (!this.flushTimer) this.flushTimer = setTimeout(() => { this.flushTimer = null; this.updateCommand(active); }, 250);
    }
    this.emit({ type: "output", commandId: active?.status === "running" ? active.id : null, data });
  }
  private history(block: CommandBlock): HistoryRecord {
    return { id: block.id, sourceId: `terminal:${block.terminalId}`, source: block.source, command: block.command, cwd: block.cwd, shell: block.shell, executedAt: block.startedAt, importedAt: Date.now(), exitCode: block.exitCode, status: block.status, favorite: false, terminalId: block.terminalId, sessionId: null };
  }
  private updateCommand(block: CommandBlock): void {
    const copy = { ...block };
    this.persist(async () => { await this.store.put("command", copy.id, copy, this.state.id); await this.store.recordHistory([this.history(copy)]); });
    this.emit({ type: "command", command: copy });
  }
  private finishActive(status: CommandBlock["status"], exitCode: number | null): void {
    const block = this.commands.find(item => item.id === this.state.activeCommandId);
    if (this.flushTimer) clearTimeout(this.flushTimer); this.flushTimer = null;
    if (block) {
      block.status = status; block.exitCode = exitCode; block.endedAt = Date.now(); block.endCwd = this.state.cwd;
      this.updateCommand(block);
    }
    this.state.activeCommandId = null;
    if (this.commands.length > 100) this.commands = this.commands.slice(-100);
  }
  private newBlock(command: string, requestId: string | null, runId: string | null, source: CommandBlock["source"]): CommandBlock {
    return { id: randomUUID(), terminalId: this.state.id, runId, clientRequestId: requestId, command, cwd: this.state.cwd, endCwd: null, shell: this.state.profile.kind, source, status: "accepted", startedAt: null, endedAt: null, exitCode: null, output: "", outputTruncated: false };
  }
  execute(command: string, requestId: string, runId: string | null = null, signal?: AbortSignal): Promise<CommandBlock> {
    return this.exclusive(async () => {
      signal?.throwIfAborted();
      shellText(command, "command"); shellId(requestId);
      const fingerprint = createHash("sha256").update(JSON.stringify({ command, runId })).digest("hex");
      // Receipt recovery is read-only, even after a restart or ownership change.
      await this.store.ready;
      const old = await this.store.call<{ fingerprint: string; entity: string; kind: string } | null>("getRequest", { terminalId: this.state.id, requestId });
      if (old) {
        if (old.fingerprint !== fingerprint || old.kind !== "command") throw new ShellError("Request id was already used for different content", 409);
        return (await this.store.get<CommandBlock>("command", old.entity))!;
      }
      this.assertStorage(); await this.start();
      signal?.throwIfAborted();
      if (this.state.integration !== "ready") throw new ShellError("Use the native terminal for this shell", 409, "integration_unavailable");
      if (this.state.owner === "agent" && this.state.activeRunId !== runId) throw new ShellError("Take over the terminal before entering a command", 409, "agent_owns_terminal");
      const block = this.newBlock(command, requestId, runId, runId ? "shell-agent" : "human");
      if (this.state.activeCommandId) throw new ShellError("A command is already running. Use terminal input or open another terminal.", 409, "terminal_busy");
      signal?.throwIfAborted();
      const receipt = await this.store.accept(this.state.id, requestId, fingerprint, "command", block);
      if (!receipt.accepted) return (await this.store.get<CommandBlock>("command", receipt.id))!;
      this.commands.push(block); this.state.activeCommandId = block.id;
      this.changed(); this.emit({ type: "command", command: { ...block } });
      if (signal?.aborted) {
        this.finishActive("interrupted", null); this.changed();
        signal.throwIfAborted();
      }
      try { this.child!.write(encodeShellSubmission(this.state.profile, command, block.id)); }
      catch (error) { this.finishActive("unknown", null); this.changed(); throw error; }
      this.lastActivity = Date.now();
      return { ...block };
    });
  }
  input(data: string, replay = false): void {
    if (typeof data !== "string" || data.length > 65536 || data.includes("\0")) throw new ShellError("Invalid terminal input");
    if (!this.child || !this.state.connected) throw new ShellError("Terminal is disconnected", 409);
    const protocolReply = /^\x1b\[\?[\d;]+c$/.test(data);
    if (replay && !(process.platform === "win32" && protocolReply && !this.protocolReplied)) return;
    if (protocolReply) this.protocolReplied = true;
    if (this.state.owner === "agent" && !protocolReply) throw new ShellError("Take over the terminal before typing", 409, "agent_owns_terminal");
    this.child.write(data); this.lastActivity = Date.now();
  }
  resize(cols: number, rows: number): void {
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 2 || cols > 500 || rows < 1 || rows > 300) throw new ShellError("Invalid terminal size");
    this.cols = cols; this.rows = rows; this.child?.resize(cols, rows);
  }
  interrupt(): void { this.child?.write("\x03"); }
  claim(runId: string): void {
    if (this.state.activeRunId || this.state.activeCommandId) throw new ShellError("Terminal is busy", 409);
    this.state.owner = "agent"; this.state.activeRunId = runId; this.changed();
  }
  release(runId: string): void { if (this.state.activeRunId === runId) { this.state.activeRunId = null; this.state.owner = "human"; this.changed(); } }
  async updateRun(run: ShellRun): Promise<void> {
    const index = this.runs.findIndex(item => item.id === run.id);
    if (index < 0) this.runs.push(run); else this.runs[index] = run;
    await this.store.put("run", run.id, run, this.state.id);
    this.emit({ type: "run", run: { ...run } });
  }
  async command(id: string): Promise<CommandBlock | null> { return this.commands.find(item => item.id === id) || this.store.get("command", id); }
  async saveDraft(draft: string): Promise<void> { if (draft.length > 65536) throw new ShellError("Draft is too large"); this.state.draft = draft; await this.store.put("session", this.state.id, this.state); }
  async savePreferences(values: Partial<Pick<ShellSession, "title" | "model">>): Promise<void> { Object.assign(this.state, values); this.changed(); await this.persistence; }
  clear(): void { this.output = ""; this.emit({ type: "clear" }); }
  async stop(): Promise<void> {
    const child = this.child;
    this.state.generation += 1; this.child = null; this.state.connected = false; this.state.integration = "unavailable";
    this.finishActive("unknown", null);
    if (child) { try { child.kill(); } catch { /* Already exited. */ } }
    this.readyResolve?.(); this.readyResolve = null; this.changed();
    await this.persistence;
  }
  async dispose(): Promise<void> {
    clearInterval(this.idleTimer); await this.stop(); this.listeners.clear();
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([this.closedProcess, new Promise<void>(resolve => { timer = setTimeout(resolve, 5000); })]);
    if (timer) clearTimeout(timer);
  }
}
