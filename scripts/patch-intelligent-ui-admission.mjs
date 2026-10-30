import { createHash } from "node:crypto";
import { lstat, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const MARKER = "/* piora-tool-admission-v1 */";
const certificate = JSON.parse(await readFile(new URL("./pi-tool-admission-1.4.0.json", import.meta.url), "utf8"));
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
export const codingAgentAdmissionTreeCommitment = Object.freeze({ ...certificate.codingAgentPatchedDist });
function patchCertifiedSource(path, source, transform) {
  const entry = certificate.files.find(file => file.path === path);
  const digest = sha256(source);
  if (digest === entry.afterSha256) return source;
  if (digest !== entry.beforeSha256) throw new Error(`SDK admission file differs from its reviewed commitment: ${path}`);
  const after = transform(source);
  if (sha256(after) !== entry.afterSha256) throw new Error(`SDK admission patch output differs from its reviewed commitment: ${path}`);
  return after;
}
function replaceOnce(source, before, after) {
  if (source.split(before).length !== 2) throw new Error("Unsupported SDK admission patch anchor");
  return source.replace(before, after);
}
function assertBlock(source, start, end, expectedHash) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  if (from < 0 || to < 0 || createHash("sha256").update(source.slice(from, to)).digest("hex") !== expectedHash) {
    throw new Error("SDK admission pipeline changed; review the patch before installing");
  }
}

// The lease covers the common direct AND runToolCall (nested) preparation path.
// The ordinary permission hook still executes after SDK validation. Admission
// never replaces or grants permission.
const wrapper = `${MARKER}
async function prepareToolCall(currentContext, assistantMessage, toolCall, config, signal, tools = currentContext.tools ?? []) {
    const admission = await config.admitToolCall?.({ toolCall, assistantMessage, context: currentContext }, signal);
    if (admission?.immediate) return { kind: "immediate", ...admission.immediate };
    const preparation = await prepareToolCallUnchecked(currentContext, assistantMessage, toolCall, config, admission?.signal ?? signal, tools);
    if (!admission) return preparation;
    if (preparation.kind === "immediate") {
        const outcome = admission.settle({ result: preparation.result, isError: preparation.isError }, preparation.admissionPhase === "validation" ? "validation" : "execution");
        return { kind: "immediate", ...outcome };
    }
    return { ...preparation, admission };
}
`;

function transformAdmissionLoopSource(source) {
  source = source.replace(/\r\n/g, "\n");
  if (source.includes(MARKER)) {
    for (const anchor of [wrapper, "signal = prepared.admission.signal;", 'prepared.admission.settle({ result, isError }, "execution")']) {
      if (!source.includes(anchor)) throw new Error("Incomplete SDK admission patch");
    }
    assertBlock(source, "async function prepareToolCallUnchecked(", "\nfunction emitToolExecutionUpdate(", "86eb70a0802e5e878303d6cae96f3e081d946f792d9d85222430bad6fc9d9e1f");
    assertBlock(source, "async function executePreparedToolCall(", "\nasync function finalizeExecutedToolCall(", "7db4be51fe8a3fdc4d29b34180d92b8b7474f0338a7819523de2541ffe68a2be");
    assertBlock(source, "async function finalizeExecutedToolCall(", "\nfunction createErrorToolResult(", "b21508a81e7b5bc8dcd7771d24546a174799b72327440cb9d25ddd8e82230c57");
    assertBlock(source, "async function failToolCallsFromTruncatedMessage(", "\n/**", "f332208c30d49a9b9ae4fe0837de291941fad91277ca15aa6ac533ee1a949acb");
    if (!source.includes("await failToolCallsFromTruncatedMessage(toolCalls, emit, config, signal)")) throw new Error("Incomplete truncated-call admission patch");
    return source;
  }
  assertBlock(source, "async function prepareToolCall(", "\nfunction emitToolExecutionUpdate(", "4f548617c19569a86bf2f102e7bb073db8507ae17997a562819d44670293bc34");
  assertBlock(source, "async function executePreparedToolCall(", "\nasync function finalizeExecutedToolCall(", "ffc62775af1a15435e90fbcc05a038beac36cd697c4b6bffe5488f64585ae48b");
  assertBlock(source, "async function finalizeExecutedToolCall(", "\nfunction createErrorToolResult(", "b2c73f2a48c0be58d7fb0d66142504772e5b282c9218751e59f7728617286736");
  assertBlock(source, "async function failToolCallsFromTruncatedMessage(", "\n/**", "e476d2fae3acd0e3277b7f7ccc60675c0234ab19cfc404080f488d8376c336b3");
  const truncatedStart = source.indexOf("async function failToolCallsFromTruncatedMessage(");
  const truncatedEnd = source.indexOf("\n/**", truncatedStart);
  let truncated = source.slice(truncatedStart, truncatedEnd);
  truncated = replaceOnce(truncated, "(toolCalls, emit)", "(toolCalls, emit, config, signal)");
  truncated = replaceOnce(truncated, "    const messages = [];", "    const messages = [];\n    const finalizedCalls = [];");
  truncated = replaceOnce(truncated, "        await emitToolExecutionEnd(finalized, emit);", `        const admission = await config.admitToolCall?.({ toolCall }, signal);
        const admitted = admission?.immediate ?? admission?.settle(finalized, "validation");
        if (admitted) {
            finalized.result = admitted.result;
            finalized.isError = admitted.isError;
        }
        finalizedCalls.push(finalized);
        await emitToolExecutionEnd(finalized, emit);`);
  truncated = replaceOnce(truncated, "return { messages, terminate: false };", "return { messages, terminate: shouldTerminateToolBatch(finalizedCalls) };");
  source = source.slice(0, truncatedStart) + truncated + source.slice(truncatedEnd);
  source = replaceOnce(source, "await failToolCallsFromTruncatedMessage(toolCalls, emit)", "await failToolCallsFromTruncatedMessage(toolCalls, emit, config, signal)");
  source = replaceOnce(source, "    try {\n        const preparedToolCall = prepareToolCallArguments(tool, toolCall);", '    let admissionPhase = "validation";\n    try {\n        const preparedToolCall = prepareToolCallArguments(tool, toolCall);');
  source = replaceOnce(source, "        const validatedArgs = validateToolArguments(tool, preparedToolCall);", '        const validatedArgs = validateToolArguments(tool, preparedToolCall);\n        admissionPhase = "execution";');
  source = replaceOnce(source, '            kind: "immediate",\n            result: createErrorToolResult(error instanceof Error ? error.message : String(error)),', '            kind: "immediate",\n            admissionPhase,\n            result: createErrorToolResult(error instanceof Error ? error.message : String(error)),');
  source = replaceOnce(source, "async function prepareToolCall(", `${wrapper}async function prepareToolCallUnchecked(`);
  source = replaceOnce(source, "async function executePreparedToolCall(prepared, signal, onUpdate) {", `async function executePreparedToolCall(prepared, signal, onUpdate) {
    if (prepared.admission) {
        const blocked = prepared.admission.check();
        if (blocked) return { ...blocked, durationMs: 0 };
        signal = prepared.admission.signal;
    }`);
  source = replaceOnce(source, "    return {\n        toolCall: prepared.toolCall,\n        result,\n        isError,\n        durationMs: executed.durationMs,\n    };", `    if (prepared.admission) {
        const admitted = prepared.admission.settle({ result, isError }, "execution");
        result = admitted.result;
        isError = admitted.isError;
    }
    return {
        toolCall: prepared.toolCall,
        result,
        isError,
        durationMs: executed.durationMs,
    };`);
  // An abort can occur after parallel preparation and before execution.
  source = replaceOnce(source, "                await emitToolExecutionEnd(finalized, emit);\n                return finalized;", `                if (preparation.admission) {
                    const admitted = preparation.admission.settle(finalized, "execution");
                    finalized.result = admitted.result;
                    finalized.isError = admitted.isError;
                }
                await emitToolExecutionEnd(finalized, emit);
                return finalized;`);
  return source;
}

function transformAdmissionAgentSource(source) {
  source = source.replace(/\r\n/g, "\n");
  if (source.includes(MARKER)) {
    if (!source.includes("admitToolCall: this.admitToolCall,") || !source.includes("pioraToolAdmissionVersion = 1;")) throw new Error("Incomplete Agent admission patch");
    return source;
  }
  source = replaceOnce(source, "    beforeToolCall;", `    ${MARKER}
    pioraToolAdmissionVersion = 2;
    admitToolCall;
    beforeToolCall;`);
  return replaceOnce(source, "            beforeToolCall: this.beforeToolCall,", "            admitToolCall: this.admitToolCall,\n            beforeToolCall: this.beforeToolCall,");
}

function transformAdmissionSessionSource(source) {
  source = source.replace(/\r\n/g, "\n");
  if (source.includes(MARKER)) {
    if (!source.includes("admitToolCall: this.agent.admitToolCall,")) throw new Error("Incomplete nested admission patch");
    assertBlock(source, "    async _executeNestedToolCall(", "\n    /** Whether `projection`", "1ee5a4b2fcb113e7246947b59f1db5ff43c9e2627fd2e398887b2f510f428291");
    return source;
  }
  assertBlock(source, "    async _executeNestedToolCall(", "\n    /** Whether `projection`", "6bd26289a35e1a046d59ec08032844b474bdf6839a8a8f66c1eb9ad4b2fa1965");
  source = replaceOnce(source, "runToolCall: (toolCall, parentId, signal, onUpdate) => {", "runToolCall: (toolCall, parentId, signal, onUpdate, admission) => {");
  source = replaceOnce(source, "                    beforeToolCall: (context) => this._beforeToolCall(context, parentId),", `                    ${MARKER}
                    admitToolCall: admission,
                    beforeToolCall: (context) => this._beforeToolCall(context, parentId),`);
  return replaceOnce(source, "executeTool: (callerId, name, args, options) => this._executeNestedToolCall(callerId, name, args, options),", "executeTool: Object.assign((callerId, name, args, options) => this._executeNestedToolCall(callerId, name, args, options), { getAdmission: () => this.agent.admitToolCall }),");
}

function transformAdmissionRunnerSource(source) {
  source = replaceOnce(source, "    createToolContext(toolCallId, signal) {\n        const runner = this;", `    createToolContext(toolCallId, signal) {
        const runner = this;
        ${MARKER}
        const admission = runner.executeToolFn?.getAdmission?.();`);
  return replaceOnce(source, "return runner.executeToolFn(toolCallId, name, args, { ...options, signal: options.signal ?? signal });", "return runner.executeToolFn(toolCallId, name, args, { ...options, signal: options.signal ?? signal, pioraAdmission: admission });");
}

function transformAdmissionNestedSource(source) {
  return replaceOnce(source, "            });\n        }\n        finally {\n            this.scopes.delete(toolCall.id);", `            }, options.pioraAdmission); // Piora: immutable originating run hook from the tool context.
        }
        finally {
            this.scopes.delete(toolCall.id);`);
}

export const patchAdmissionLoopSource = source => patchCertifiedSource("@earendil-works/pi-agent-core/dist/agent-loop.js", source, transformAdmissionLoopSource);
export const patchAdmissionAgentSource = source => patchCertifiedSource("@earendil-works/pi-agent-core/dist/agent.js", source, transformAdmissionAgentSource);
export const patchAdmissionSessionSource = source => patchCertifiedSource("@earendil-works/pi-coding-agent/dist/core/agent-session.js", source, transformAdmissionSessionSource);
export const patchAdmissionRunnerSource = source => patchCertifiedSource("@earendil-works/pi-coding-agent/dist/core/extensions/runner.js", source, transformAdmissionRunnerSource);
export const patchAdmissionNestedSource = source => patchCertifiedSource("@earendil-works/pi-coding-agent/dist/core/nested-tool-calls.js", source, transformAdmissionNestedSource);

async function readRealFile(root, relative) {
  let path = root;
  const parts = ["", ...relative.split("/")];
  for (let i = 0; i < parts.length; i++) {
    path = join(path, parts[i]);
    const entry = await lstat(path);
    if (entry.isSymbolicLink() || (i < parts.length - 1 ? !entry.isDirectory() : !entry.isFile())) throw new Error(`SDK admission refuses an unsafe entry: ${path}`);
  }
  return readFile(path);
}
async function inspectAdmissionFiles(root) {
  for (const [name, expected] of Object.entries(certificate.packages)) {
    const bytes = await readRealFile(root, `node_modules/${name}/package.json`);
    const manifest = JSON.parse(bytes);
    if (manifest.name !== name || manifest.version !== expected.version || sha256(bytes) !== expected.packageJsonSha256) throw new Error(`Unexpected SDK admission package manifest: ${name}`);
  }
  return Promise.all(certificate.files.map(async entry => {
    const bytes = await readRealFile(root, `node_modules/${entry.path}`);
    const digest = sha256(bytes);
    if (digest !== entry.beforeSha256 && digest !== entry.afterSha256) throw new Error(`SDK admission file differs from its reviewed commitment: ${entry.path}`);
    return { ...entry, path: join(root, "node_modules", entry.path), bytes, state: digest === entry.afterSha256 ? "patched" : "original" };
  }));
}

/** Verification accepts only complete, precisely reviewed pre/post states. */
export async function verifyIntelligentUiAdmission(root, { allowOriginal = false } = {}) {
  const files = await inspectAdmissionFiles(root);
  const states = new Set(files.map(file => file.state));
  if (states.size !== 1) throw new Error("SDK admission installation is incomplete; rerun dependency installation");
  const state = files[0].state;
  if (!allowOriginal && state !== "patched") throw new Error("SDK admission patch is not installed");
  return { version: certificate.version, state };
}

/** Validate every source/output before writing; known partial installs can recover. */
export async function patchIntelligentUiAdmission(root) {
  const files = await inspectAdmissionFiles(root);
  const patches = [patchAdmissionLoopSource, patchAdmissionAgentSource, patchAdmissionSessionSource, patchAdmissionRunnerSource, patchAdmissionNestedSource];
  const updates = files.map((file, index) => ({ path: file.path, before: file.bytes.toString("utf8"), after: patches[index](file.bytes.toString("utf8")) }));
  for (const { path, before, after } of updates) if (before !== after) await writeFile(path, after, "utf8");
  await verifyIntelligentUiAdmission(root);
  return { version: certificate.version, updated: updates.filter(({ before, after }) => before !== after).length };
}
