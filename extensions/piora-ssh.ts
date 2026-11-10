import { Type } from "typebox";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createReadStream, createWriteStream, promises as fs } from "node:fs";
import { basename, isAbsolute, relative, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { getSSHSession, listSSHSessionSummariesForAgent } from "../lib/ssh/session-manager.ts";

const MAX_TRANSFER = 100 * 1024 * 1024;
const MAX_TEXT = 2 * 1024 * 1024;
const result = (text: string, details: Record<string, unknown> = {}) => ({ content: [{ type: "text" as const, text }], details });
function inventory(sessionId: string): string {
  const sessions = listSSHSessionSummariesForAgent(sessionId);
  if (!sessions.length) return "No SSH connections are linked to this task.";
  return sessions.map((session) => [
    session.id, session.hostName || session.host, session.username + "@" + session.host + ":" + session.port,
    session.connected ? "connected" : "disconnected", session.busy ? "command running" : "idle",
    "terminal cwd " + session.cwd,
  ].join(" | ")).join("\n");
}
function remotePath(path: string | undefined): string {
  if (!path || !path.startsWith("/") || path.includes("\0")) throw new Error("An absolute remote path is required.");
  return path;
}
async function localPath(cwd: string, requested: string | undefined, forWrite: boolean): Promise<string> {
  if (!requested) throw new Error("A localPath is required.");
  const root = await fs.realpath(cwd);
  const path = resolve(root, requested);
  const lexical = relative(root, path);
  if (lexical === ".." || lexical.startsWith("../") || lexical.startsWith("..\\") || isAbsolute(lexical)) throw new Error("Local path must stay within this task's workspace.");
  const actual = forWrite
    ? await fs.realpath(path).catch(async error => {
        if (error?.code !== "ENOENT") throw error;
        return resolve(await fs.realpath(resolve(path, "..")), basename(path));
      })
    : await fs.realpath(path);
  const sub = relative(root, actual);
  if (sub === ".." || sub.startsWith("../") || sub.startsWith("..\\") || isAbsolute(sub)) throw new Error("Local path must stay within this task's workspace.");
  return actual;
}
export default function pioraSSH(api: ExtensionAPI) {
  api.registerTool(defineTool({
    name: "ssh", label: "Task SSH connections",
    description: "Use only SSH connections explicitly linked to this task. List live sessions, run a command in one remote terminal, and manage remote files. Local bash always remains local.",
    promptSnippet: "Use ssh for a connected remote host linked in the SSH panel; use local bash for the local workspace.",
    promptGuidelines: [
      "Call ssh with action=sessions to discover the current task's live SSH session IDs and host names before choosing a machine.",
      "Always specify the exact sessionId for remote operations. Never assume the local bash tool is remote.",
      "Do not connect to offline saved hosts automatically. Ask the user to connect and link them in the SSH panel.",
      "Terminal commands and file transfers target only the explicitly selected host; never fan out across hosts without user intent.",
    ],
    executionMode: "parallel",
    parameters: Type.Object({
      action: Type.Union(["sessions", "terminal", "exec", "list", "read", "write", "upload", "download"].map(value => Type.Literal(value)) as [ReturnType<typeof Type.Literal>, ...ReturnType<typeof Type.Literal>[]]),
      sessionId: Type.Optional(Type.String()),
      command: Type.Optional(Type.String({ maxLength: 100_000 })),
      path: Type.Optional(Type.String()),
      text: Type.Optional(Type.String({ maxLength: MAX_TEXT })),
      localPath: Type.Optional(Type.String()),
      overwrite: Type.Optional(Type.Boolean()),
    }),
    async execute(_id, params, signal, _update, ctx) {
      const taskId = ctx.sessionManager.getSessionId();
      if (params.action === "sessions") return result(inventory(taskId), { sessions: listSSHSessionSummariesForAgent(taskId) });
      const session = params.sessionId ? getSSHSession(params.sessionId) : undefined;
      if (!session || session.agentSessionId !== taskId || session.ownerSessionId !== taskId) throw new Error("This SSH connection is not linked to the current task. Call ssh sessions to refresh the list.");
      const identity = { sessionId: session.id, hostName: session.hostName, host: session.snapshot().host };
      if (!session.snapshot().connected) throw new Error("SSH connection is disconnected. Reconnect it in the SSH panel.");
      if (params.action === "terminal") return result(session.snapshot().output.slice(-MAX_TEXT), { ...identity, cwd: session.snapshot().cwd });
      if (params.action === "exec") {
        if (!params.command?.trim()) throw new Error("command is required.");
        const execution = await session.exec(params.command, { signal });
        return result(execution.output.slice(-MAX_TEXT), { ...identity, cwd: session.snapshot().cwd, exitCode: execution.exitCode });
      }
      const sftp = await session.sftp();
      const path = remotePath(params.path);
      if (params.action === "list") {
        const resolved = await new Promise<string>((yes, no) => sftp.realpath(path, (error, value) => error ? no(error) : yes(value)));
        const entries = await new Promise<Array<{ name: string; type: string; size: number; modifiedAt: number | null }>>((yes, no) =>
          sftp.readdir(resolved, (error, values) => error ? no(error) : yes(values.map(item => ({ name: item.filename, type: item.attrs.isDirectory() ? "directory" : item.attrs.isFile() ? "file" : "other", size: item.attrs.size, modifiedAt: item.attrs.mtime ? item.attrs.mtime * 1000 : null })))));
        entries.sort((a, b) => Number(b.type === "directory") - Number(a.type === "directory") || a.name.localeCompare(b.name));
        return result(JSON.stringify({ path: resolved, entries }), { ...identity, path: resolved, entries });
      }
      if (params.action === "read") {
        const chunks: Buffer[] = []; let count = 0;
        const stream = sftp.createReadStream(path);
        for await (const chunk of stream) {
          signal?.throwIfAborted(); count += chunk.length;
          if (count > MAX_TEXT) { stream.destroy(); throw new Error("Remote text file exceeds the 2 MB limit."); }
          chunks.push(Buffer.from(chunk));
        }
        const text = Buffer.concat(chunks).toString("utf8");
        return result(text, { ...identity, path, bytes: count });
      }
      if (params.action === "write") {
        if (params.text === undefined) throw new Error("text is required.");
        const data = Buffer.from(params.text);
        if (data.byteLength > MAX_TEXT) throw new Error("Remote text exceeds the 2 MB limit.");
        const stream = sftp.createWriteStream(path, { flags: params.overwrite ? "w" : "wx", mode: 0o644 });
        await pipeline(Readable.from([data]), stream, { signal });
        return result("Wrote " + data.byteLength + " bytes to " + path, { ...identity, path, bytes: data.byteLength });
      }
      if (params.action === "upload") {
        const local = await localPath(ctx.sessionManager.getCwd(), params.localPath, false);
        const stat = await fs.stat(local);
        if (!stat.isFile() || stat.size > MAX_TRANSFER) throw new Error("Upload requires a regular file no larger than 100 MB.");
        const source = createReadStream(local);
        const destination = sftp.createWriteStream(path, { flags: params.overwrite ? "w" : "wx", mode: 0o644 });
        await pipeline(source, destination, { signal });
        return result("Uploaded " + stat.size + " bytes to " + path, { ...identity, path, localPath: local, bytes: stat.size });
      }
      if (params.action === "download") {
        const local = await localPath(ctx.sessionManager.getCwd(), params.localPath, true);
        const stat = await new Promise<{ size: number }>((yes, no) => sftp.stat(path, (error, value) => error ? no(error) : yes(value)));
        if (stat.size > MAX_TRANSFER) throw new Error("Download exceeds the 100 MB limit.");
        const existed = await fs.stat(local).then(() => true, error => { if (error?.code === "ENOENT") return false; throw error; });
        const source = sftp.createReadStream(path), destination = createWriteStream(local, { flags: params.overwrite ? "w" : "wx", mode: 0o644 });
        let opened = false;
        destination.once("open", () => { opened = true; });
        try { await pipeline(source, destination, { signal }); } catch (error) { if (opened && !existed) await fs.unlink(local).catch(() => undefined); throw error; }
        return result("Downloaded " + stat.size + " bytes to " + local, { ...identity, path, localPath: local, bytes: stat.size });
      }
      throw new Error("Unsupported SSH action.");
    },
  }));
  api.on("before_agent_start", (event, ctx) => {
    if (!event.systemPromptOptions.selectedTools?.includes("ssh")) return;
    const list = inventory(ctx.sessionManager.getSessionId());
    return { systemPrompt: event.systemPrompt + "\n\n<current_task_ssh_connections>\n" + list + "\nUse the ssh tool with the exact session ID for remote work. Saved but disconnected hosts are unavailable. Local bash remains local.\n</current_task_ssh_connections>" };
  });
}
