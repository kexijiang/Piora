import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

/** Test-only relay: credentials remain in this process, never in the saved desktop profile. */
export async function startRealModelProxy({ runtime, model, signal, registerCleanup, onRequest, onResponse, fetchImpl = fetch }) {
  assert.equal(model.provider, 'deepseek');
  assert.equal(model.id, 'deepseek-flash');
  assert.equal(model.api, 'openai-completions');
  assert.match(model.name, /V4\.1/);
  const token = randomUUID(), pending = new Set();
  let count = 0;
  const server = createServer(async (request, response) => {
    const cancel = new AbortController(); pending.add(cancel);
    let completed = false;
    const abort = () => { if (!response.writableEnded && !completed) cancel.abort(); };
    let id, stage = 'request', failureCode, receivedCharacters = 0, receivedEvents = 0;
    request.once('aborted', abort); response.once('close', abort);
    try {
      if (request.method !== 'POST' || request.url !== '/v1/chat/completions'
        || request.headers.authorization !== `Bearer ${token}`) {
        response.writeHead(403); response.end('Forbidden'); return;
      }
      const chunks = []; let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 8 * 1024 * 1024) throw new Error('Request exceeds test bound');
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (body.model !== model.id || body.stream !== true || ++count > 36) {
        response.writeHead(400); response.end('Pinned streaming model required'); return;
      }
      id = count;
      await onRequest?.({ id, body });
      stage = 'authentication';
      const auth = (await runtime.getAuth(model))?.auth;
      assert.ok(auth?.apiKey || auth?.headers, 'Configured model authentication is unavailable');
      const compatibility = runtime.getCompatibilityRequestConfig(model);
      const headers = new Headers({ 'Content-Type': 'application/json', ...compatibility.headers, ...auth.headers });
      // This pinned provider uses OpenAI-compatible bearer authentication. The SDK's
      // compatibility authHeader flag controls an extra header override, not whether
      // the OpenAI client's normal apiKey authentication is sent.
      if (auth.apiKey && !headers.has('Authorization')) headers.set('Authorization', `Bearer ${auth.apiKey}`);
      const endpoint = new URL(`${(auth.baseUrl ?? model.baseUrl).replace(/\/+$/, '')}/chat/completions`);
      assert.equal(endpoint.protocol, 'https:', 'Real model relay requires configured HTTPS');
      stage = 'upstream';
      const upstream = await fetchImpl(endpoint, { method: 'POST', headers, body: JSON.stringify(body),
        signal: AbortSignal.any([signal, cancel.signal, AbortSignal.timeout(180_000)]) });
      if (!upstream.ok || !upstream.body) {
        // Provider error bodies may contain account data; do not copy them into retained reports.
        await upstream.body?.cancel();
        await onResponse?.({ id, status: upstream.status, error: 'Provider rejected request' });
        response.writeHead(upstream.status); response.end('Configured provider request failed'); return;
      }
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      stage = 'stream';
      const decoder = new TextDecoder(); let responseSize = 0, contentSize = 0, remainder = '', terminal = false;
      const events = [];
      const ingest = text => {
        responseSize += text.length;
        receivedCharacters = responseSize;
        // Streaming metadata is repeated per token. Bound transport separately
        // from generated deltas so a normal 8192-token tool call can complete.
        if (responseSize > 8 * 1024 * 1024) { failureCode = 'RESPONSE_LIMIT'; throw new Error('Response exceeds test bound'); }
        remainder += text;
        const lines = remainder.split('\n'); remainder = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (!data) continue;
          if (data === '[DONE]') { terminal = true; continue; }
          const event = JSON.parse(data); events.push(event); receivedEvents = events.length;
          contentSize += JSON.stringify(event.choices?.map(choice => choice.delta) ?? []).length;
          if (contentSize > 2 * 1024 * 1024) { failureCode = 'CONTENT_LIMIT'; throw new Error('Content exceeds test bound'); }
          if (event.choices?.some(choice => typeof choice.finish_reason === 'string' && choice.finish_reason)) terminal = true;
        }
      };
      const report = async () => {
        // The SDK may close the HTTP body immediately after finish_reason. Record
        // that terminal event before forwarding it; HTTP EOF is not model EOF.
        completed = true;
        await onResponse?.({ id, status: upstream.status, modelIds: [...new Set(events.map(event => event.model).filter(Boolean))],
          finishReasons: [...new Set(events.flatMap(event => event.choices ?? []).map(choice => choice.finish_reason).filter(Boolean))],
          text: events.map(event => event.choices?.[0]?.delta?.content ?? '').join(''),
          tools: events.flatMap(event => event.choices?.[0]?.delta?.tool_calls ?? []),
          usage: events.findLast(event => event.usage)?.usage ?? null });
      };
      for await (const chunk of upstream.body) {
        stage = 'parse'; ingest(decoder.decode(chunk, { stream: true })); stage = 'stream';
        if (terminal) await report();
        response.write(chunk);
        if (terminal) break;
      }
      if (!completed) {
        stage = 'parse'; ingest(decoder.decode() + '\n');
        if (!terminal) { failureCode = 'MISSING_TERMINAL'; throw new Error('Model stream ended without a terminal event'); }
        await report();
      }
      response.end();
    } catch (error) {
      await onResponse?.({ id, status: 'failed', stage, cancelled: signal.aborted || cancel.signal.aborted,
        failureCode, receivedCharacters, receivedEvents,
        errorType: ['AbortError', 'TimeoutError', 'SyntaxError', 'TypeError'].includes(error?.name) ? error.name : 'Error',
        error: 'Real model relay failed or was cancelled' });
      if (!response.headersSent) response.writeHead(502);
      response.end('Real model relay failed or was cancelled');
    } finally { pending.delete(cancel); request.off('aborted', abort); response.off('close', abort); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  registerCleanup(() => new Promise((resolve, reject) => {
    for (const controller of pending) controller.abort();
    server.closeAllConnections(); server.close(error => error ? reject(error) : resolve());
  }));
  return { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: token };
}
