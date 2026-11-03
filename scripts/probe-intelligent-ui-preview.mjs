/** Explicit one-request streaming probe. Synthetic task only; no tool execution. */
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { createJiti } from 'jiti';
import { getAgentDir, ModelRuntime } from '@earendil-works/pi-coding-agent';
import { evaluationVariant } from './intelligent-ui-live-evaluation.mjs';

const options = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, args) => {
  if (index % 2 === 0) pairs.push([value, args[index + 1]]); return pairs;
}, []));
const modelKey = options['--model'], output = options['--output'];
if (!modelKey?.includes('/') || !output || Object.keys(options).some(key => !['--model', '--output'].includes(key))) {
  throw new Error('Usage: node scripts/probe-intelligent-ui-preview.mjs --model provider/model --output result.json');
}
try { await access(output); throw new Error('Output already exists; keep previous evidence unchanged'); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const root = resolve(import.meta.dirname, '..');
const jiti = createJiti(import.meta.url, { alias: { '@': root } });
const { UiPreviewRuntime } = await jiti.import('../lib/intelligent-ui/preview-runtime.ts');
const { compileUiRichPlan } = await jiti.import('../lib/intelligent-ui/rich-plan.ts');
const configuration = await evaluationVariant('plan-2'), agentDir = getAgentDir();
const runtime = await ModelRuntime.create({ authPath: join(agentDir, 'auth.json'), modelsPath: join(agentDir, 'models.json'), allowModelNetwork: false });
const split = modelKey.indexOf('/'), model = runtime.getModel(modelKey.slice(0, split), modelKey.slice(split + 1));
if (!model) throw new Error('Requested model is not configured');
const prompt = '周末四个人出去玩，门票每人30元，车费总共120元，吃饭每人40元。我想自己改人数和餐费，看看总共花多少、每个人出多少，也把费用明细列出来。';
const sourcePaths = ['scripts/probe-intelligent-ui-preview.mjs', 'scripts/intelligent-ui-live-evaluation.mjs',
  'lib/intelligent-ui/decision-policy.ts', 'lib/intelligent-ui/preview-parser.ts', 'lib/intelligent-ui/preview-plan.ts',
  'lib/intelligent-ui/preview-runtime.ts', 'lib/intelligent-ui/plan.ts', 'lib/intelligent-ui/rich-plan.ts',
  'lib/intelligent-ui/rich-plan-schema.ts', 'lib/intelligent-ui/rich-protocol.ts', 'package-lock.json'];
const hashes = Object.fromEntries(await Promise.all(sourcePaths.map(async path => [path, createHash('sha256').update(await readFile(join(root, path))).digest('hex')])));
const settings = { maxTokens: 6000, reasoning: 'low', maxRetries: 0, timeoutMs: 90000, transport: 'sse' };
const record = { version: 1, createdAt: new Date().toISOString(), model: modelKey, prompt, settings,
  scope: 'isolated-streaming-generation', committed: false, browserInteraction: 'not-tested',
  policy: configuration, hashes, events: [], toolCalls: [], outcome: 'pending' };
const controller = new AbortController(), started = performance.now();
const timer = setTimeout(() => controller.abort(), settings.timeoutMs);
const preview = new UiPreviewRuntime({ sessionId: 'synthetic-preview', runId: 'single-probe', isActive: () => !controller.signal.aborted,
  emit: value => record.events.push({ atMs: performance.now() - started, ...value }) });
preview.beginRequest();
let stream;
try {
  stream = runtime.streamSimple(model, { ...configuration, messages: [{ role: 'user', content: prompt, timestamp: Date.now() }] }, { ...settings, signal: controller.signal });
  for await (const event of stream) {
    if (event.type === 'start') preview.observe({ type: 'message_start', message: event.partial });
    else if (event.type === 'done' || event.type === 'error') {
      const message = event.type === 'done' ? event.message : event.error;
      preview.observe({ type: 'message_end', message });
      record.outcome = event.type === 'error' ? (controller.signal.aborted ? 'timeout' : 'provider-error') : message.stopReason;
      record.completedMs = performance.now() - started;
      record.usage = message.usage;
      for (const call of message.content.filter(block => block.type === 'toolCall')) {
        const result = { id: call.id, name: call.name, valid: false };
        if (call.name === 'piora_render_ui_plan') try {
          result.surface = compileUiRichPlan(call.arguments, { revision: 1 }).surface; result.valid = true;
        } catch (error) { result.diagnostic = error.diagnostic?.code ?? 'invalid-plan'; }
        record.toolCalls.push(result);
      }
    } else if (event.type.startsWith('toolcall_')) {
      if (event.type === 'toolcall_end') record.firstToolEndMs ??= performance.now() - started;
      preview.observe({ type: 'message_update', message: event.partial, assistantMessageEvent: event });
    }
  }
} catch { record.outcome = controller.signal.aborted ? 'timeout' : 'provider-error'; }
finally { clearTimeout(timer); preview.cancel(); }
record.firstPartialMs = record.events.find(event => event.phase === 'partial')?.atMs ?? null;
record.incrementalBeforeToolEnd = record.firstPartialMs !== null && typeof record.firstToolEndMs === 'number' && record.firstPartialMs < record.firstToolEndMs;
await mkdir(dirname(resolve(output)), { recursive: true });
await writeFile(output, JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ output: resolve(output), outcome: record.outcome, incrementalBeforeToolEnd: record.incrementalBeforeToolEnd,
  firstPartialMs: record.firstPartialMs, firstToolEndMs: record.firstToolEndMs, validTools: record.toolCalls.filter(call => call.valid).length }));
