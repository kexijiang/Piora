"use strict";
/* eslint-disable @typescript-eslint/no-require-imports -- Loaded by the standalone CommonJS worker. */
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const hash = value => createHash("sha256").update(value).digest("hex");

function shellLineComplete(command) {
  let quote = "", escape = false, parentheses = 0;
  for (const char of command) {
    if (escape) { escape = false; continue; }
    if (char === "\\" && quote !== "'") { escape = true; continue; }
    if (quote) { if (char === quote) quote = ""; continue; }
    if (char === "'" || char === '"' || char === "`") quote = char;
    else if (char === "(" || char === "{") parentheses++;
    else if (char === ")" || char === "}") parentheses--;
  }
  if (quote || escape || parentheses > 0 || /(?:\||&&|\|\|)\s*$/.test(command)) return false;
  if (/^\s*if\b/.test(command) && !/\bfi\s*;?\s*$/.test(command)) return false;
  if (/^\s*(?:for|while|until|select)\b/.test(command) && !/\bdone\s*;?\s*$/.test(command)) return false;
  const heredoc = command.match(/<<-?\s*['"]?([\w-]+)['"]?/);
  if (heredoc && !command.split("\n").slice(1).some(line => line.trim() === heredoc[1])) return false;
  return true;
}

/** consumed covers complete records only; trailing partial bytes are reread. */
function parseHistory(text, kind) {
  const records = [];
  let consumed = 0, position = 0, pendingStart = 0, command = "", timestamp = null;
  for (const part of text.matchAll(/([^\n]*)\n/g)) {
    const raw = part[1].replace(/\r$/, ""); position = part.index + part[0].length;
    if (!command) pendingStart = consumed;
    if (kind === "bash" && /^#\d{9,}$/.test(raw) && !command) { timestamp = Number(raw.slice(1)) * 1000; continue; }
    let line = raw;
    if (kind === "zsh" && !command) {
      const extended = line.match(/^: (\d+):\d+;([\s\S]*)$/);
      if (extended) { timestamp = Number(extended[1]) * 1000; line = extended[2]; }
    }
    const continued = kind === "powershell" ? line.endsWith("`") : kind === "zsh" ? line.endsWith("\\") : false;
    if (continued) line = line.slice(0, -1);
    command += (command ? "\n" : "") + line;
    if (continued || kind === "bash" && !shellLineComplete(command)) continue;
    if (command.trim()) records.push({ command, executedAt: timestamp });
    command = ""; timestamp = null; consumed = position;
  }
  return { records, consumed: command ? pendingStart : consumed };
}

function readIncremental(database, source) {
  const key = "source:" + source.id;
  let previous = database.dispatch("getValue", { key });
  const stat = fs.statSync(source.path);
  if (!stat.isFile()) throw new Error("History source must be a regular file");
  const fd = fs.openSync(source.path, "r");
  try {
    const probe = Buffer.alloc(Math.min(previous?.probeLength || 1024, stat.size));
    fs.readSync(fd, probe, 0, probe.length, 0);
    const boundary = Buffer.alloc(Math.min(previous?.offset || 0, 1024));
    fs.readSync(fd, boundary, 0, boundary.length, Math.max(0, (previous?.offset || 0) - boundary.length));
    const reset = !previous || stat.size < previous.offset || previous.probe !== hash(probe) || previous.birthtime !== stat.birthtimeMs || previous.boundary && previous.boundary !== hash(boundary);
    if (reset) previous = { offset: 0, encoding: probe[0] === 0xff && probe[1] === 0xfe ? "utf16le" : "utf8", piCalls: {} };
    const startOffset = previous.offset;
    // Small transactions let foreground completions interleave with imports.
    // Grow only for a single multiline/JSONL record crossing the batch boundary.
    let amount = Math.min(2 * 1024, stat.size - previous.offset), text, parsed, bom;
    while (true) {
      const buffer = Buffer.alloc(amount);
      const length = fs.readSync(fd, buffer, 0, amount, previous.offset);
      text = buffer.subarray(0, length).toString(previous.encoding);
      bom = previous.offset === 0 && text.charCodeAt(0) === 0xfeff;
      if (bom) text = text.slice(1);
      parsed = source.kind === "pi" ? parsePi(text, source, previous) : parseHistory(text, source.kind);
      if (parsed.consumed || length < amount || amount >= stat.size - previous.offset) break;
      if (amount >= 16 * 1024 * 1024) throw new Error("History record exceeds the 16 MiB import limit");
      amount = Math.min(amount * 2, 16 * 1024 * 1024, stat.size - previous.offset);
    }
    previous.offset += Buffer.byteLength(text.slice(0, parsed.consumed), previous.encoding) + (bom ? previous.encoding === "utf16le" ? 2 : 3 : 0);
    const currentProbe = Buffer.alloc(Math.min(stat.size, 1024)); fs.readSync(fd, currentProbe, 0, currentProbe.length, 0);
    previous.probeLength = currentProbe.length; previous.probe = hash(currentProbe); previous.birthtime = stat.birthtimeMs;
    const currentBoundary = Buffer.alloc(Math.min(previous.offset, 1024)); fs.readSync(fd, currentBoundary, 0, currentBoundary.length, previous.offset - currentBoundary.length);
    previous.boundary = hash(currentBoundary);
    previous.imported = (reset ? 0 : previous.imported || 0) + parsed.records.length;
    previous.updatedAt = Date.now(); previous.error = null;
    // Records and cursor commit together; a crash cannot skip an imported batch.
    database.transaction(() => {
      if (reset) database.db.prepare("DELETE FROM source_occurrences WHERE source=?").run(source.id);
      // Migrate old JSON checkpoints once. Future checkpoints remain bounded,
      // even after importing millions of distinct commands.
      if (previous.counts) {
        const migrate = database.db.prepare("INSERT INTO source_occurrences VALUES(?,?,?) ON CONFLICT(source,digest) DO UPDATE SET count=excluded.count");
        for (const [digest, count] of Object.entries(previous.counts)) migrate.run(source.id, digest, count);
        delete previous.counts;
      }
      const increment = database.db.prepare("INSERT INTO source_occurrences VALUES(?,?,1) ON CONFLICT(source,digest) DO UPDATE SET count=count+1 RETURNING count");
      const records = parsed.records.map(record => {
        if (source.kind === "pi") return record;
        const digest = hash(record.command);
        const occurrence = increment.get(source.id, digest).count;
        return { id: `import:${hash(source.id + ":" + digest + ":" + occurrence)}`, sourceId: source.id, source: source.kind, shell: source.kind, cwd: null, exitCode: null, status: null, importedAt: Date.now(), favorite: false, terminalId: null, sessionId: null, ...record };
      });
      database.historyUpsert({ records }, true);
      database.dispatch("setValue", { key, value: previous });
    });
    return { ...source, offset: previous.offset, imported: previous.imported, updatedAt: previous.updatedAt, error: null, pending: previous.offset < stat.size, progressed: previous.offset > startOffset };
  } finally { fs.closeSync(fd); }
}
function parsePi(text, source, state) {
  const records = [];
  let consumed = 0;
  state.piCalls ||= {};
  for (const line of text.matchAll(/([^\n]*)\n/g)) {
    consumed = line.index + line[0].length;
    let entry; try { entry = JSON.parse(line[1]); } catch { continue; }
    if (entry.type === "session") { state.sessionId = entry.id; state.cwd = entry.cwd || null; continue; }
    const message = entry.message;
    if (!message || !state.sessionId) continue;
    const timestamp = typeof message.timestamp === "number" ? message.timestamp : Date.parse(entry.timestamp || "");
    const base = { sourceId: source.id, source: "pi-agent", shell: "bash", cwd: state.cwd, executedAt: Number.isFinite(timestamp) ? timestamp : null, importedAt: Date.now(), favorite: false, terminalId: null, sessionId: state.sessionId, exitCode: null, status: "unknown" };
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const call of message.content) {
        if (call.type !== "toolCall" || (call.name || call.toolName) !== "bash") continue;
        const command = (call.arguments || call.input)?.command;
        const id = call.id || call.toolCallId;
        if (typeof command !== "string" || !id) continue;
        const record = { ...base, id: `pi:${state.sessionId}:${id}`, command };
        state.piCalls[id] = record; records.push(record);
      }
    } else if (message.role === "toolResult" && state.piCalls[message.toolCallId]) {
      const record = { ...state.piCalls[message.toolCallId], status: message.isError ? "failed" : "completed" };
      records.push(record); delete state.piCalls[message.toolCallId];
    } else if (message.role === "bashExecution" && typeof message.command === "string") {
      records.push({ ...base, id: `pi:${state.sessionId}:${entry.id}`, command: message.command, exitCode: message.exitCode ?? null, status: message.cancelled ? "interrupted" : message.exitCode ? "failed" : message.exitCode === 0 ? "completed" : "unknown" });
    }
  }
  return { records, consumed };
}
async function piSources(directory) {
  const result = [];
  const walk = async (root, depth) => {
    if (depth > 3) return;
    let entries; try { entries = await fs.promises.readdir(root, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
      const file = path.join(root, entry.name);
      if (entry.isDirectory()) await walk(file, depth + 1);
      else if (entry.isFile() && file.endsWith(".jsonl")) result.push({ id: "pi-file:" + hash(file), path: file, kind: "pi", enabled: true });
    }
  };
  await walk(directory, 0); return result;
}
async function importSources(database, { sources = [], piDirectory }) {
  const result = [];
  for (const source of [...sources.filter(s => s.enabled), ...(piDirectory ? await piSources(piDirectory) : [])]) {
    try {
      let status;
      do {
        status = readIncremental(database, source);
        // Timers yield a full worker turn, so queued parent messages take
        // priority over admitting the next write batch.
        await new Promise(resolve => setTimeout(resolve, 1));
      } while (status.pending && status.progressed);
      result.push(status);
    }
    catch (error) { result.push({ ...source, error: error.message, updatedAt: Date.now() }); }
  }
  database.dispatch("setValue", { key: "source-status", value: result });
  return result;
}
module.exports = { parseHistory, parsePi, importSources };
