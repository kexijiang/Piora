import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { chromium } from 'playwright-core';
const require = createRequire(import.meta.url), repo = path.resolve(import.meta.dirname, '..');
const { webpack } = require('next/dist/compiled/webpack/webpack.js');
const surface = { version: 2, id: 'budget', revision: 1, title: '预算', nodes: [{ id: 'people', type: 'number', label: '人数', value: 4, min: 1 }],
  layout: [{ id: 'group', type: 'group', title: '条件', columns: 1, nodeIds: ['people'] }] };
async function build(directory) {
  await writeFile(path.join(directory, 'loader.cjs'), `const ts=require(${JSON.stringify(require.resolve('typescript'))});module.exports=s=>ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText`);
  await writeFile(path.join(directory, 'css.cjs'), `module.exports=s=>"export default "+JSON.stringify(Object.fromEntries([...s.matchAll(/\\.([a-zA-Z][\\w-]*)/g)].map(m=>[m[1],m[1]])))`);
  await writeFile(path.join(directory, 'entry.tsx'), `
import React,{useEffect}from'react';import{createRoot}from'react-dom/client';
import{SurfaceActions}from ${JSON.stringify(path.join(repo, 'components/intelligent-ui/SurfaceActions.tsx'))};
import{surfaceState}from ${JSON.stringify(path.join(repo, 'components/intelligent-ui/client-state.ts'))};
const store=surfaceState('session','call',${JSON.stringify(surface)},2);window.store=store;
const locale=new URLSearchParams(location.search).get('locale')==='en'?'en':'zh-CN';
function App(){useEffect(()=>{void store.load()},[]);return <main><SurfaceActions store={store} locale={locale}/></main>}
createRoot(document.getElementById('root')).render(<App/>);`);
  const compiler = webpack({ mode: 'development', target: 'web', devtool: false, entry: path.join(directory, 'entry.tsx'), output: { path: directory, filename: 'bundle.js' },
    resolve: { extensions: ['.tsx', '.ts', '.js'], modules: [path.join(repo, 'node_modules')] },
    module: { rules: [{ test: /\.tsx?$/, exclude: /node_modules/, use: path.join(directory, 'loader.cjs') }, { test: /\.css$/, use: path.join(directory, 'css.cjs') }] } });
  await new Promise((resolve, reject) => compiler.run((error, stats) => compiler.close(() => error || stats.hasErrors() ? reject(error || new Error(stats.toString({ all: false, errors: true }))) : resolve())));
}
test('action controls preserve approval, ambiguous-request and explicit parameter-adoption boundaries', { timeout: 120000 }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'piora-ui-actions-')); let browser;
  try {
    await build(directory);
    const css = await readFile(path.join(repo, 'components/intelligent-ui/IntelligentUiSurface.module.css'), 'utf8');
    browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : 'chromium', headless: true });
    for (const scenario of ['approval', 'lost-response', 'query', 'invalid-status', 'keyboard-narrow-en', 'file-exists-zh', 'file-exists-en', 'file-missing', 'invalid-parameters', 'legacy-error', 'server-error']) await t.test(scenario, async () => {
      const keyboard = scenario === 'keyboard-narrow-en', approval = scenario === 'approval' || keyboard;
      const english = keyboard || scenario === 'file-exists-en', rejectedStart = scenario.startsWith('file-exists') || scenario === 'file-missing';
      const failedOperation = scenario === 'invalid-parameters' || scenario === 'legacy-error';
      const page = await browser.newPage({ viewport: { width: keyboard ? 320 : 1000, height: 900 } }), errors = [], posts = [], operations = [];
      page.on('pageerror', error => errors.push(error.message));
      let revision = 1, state = { people: 4 }, holdWrites = false, releaseWrite, malformed = scenario === 'invalid-status';
      const action = scenario === 'query' || scenario === 'file-missing' || failedOperation ? { id: 'read', kind: 'read_json_parameters', label: '读取参数', path: 'parameters.json' }
        : { id: 'save', kind: 'save_snapshot', label: '保存报告', path: 'report.json', format: 'json' };
      if (keyboard) { action.label = 'Save the current comparison and all parameter values to a project report'; action.path = `reports/${'report'.repeat(20)}.json`; }
      const actionView = () => ({ source: { digest: 'current', revision, actions: { version: 1, actions: [action] } }, operations });
      await page.route('https://ui-actions.test/**', async route => {
        const request = route.request(), url = new URL(request.url());
        if (url.pathname.endsWith('/actions')) {
          if (request.method() === 'GET') return route.fulfill({ json: malformed ? { surface, state } : actionView() });
          const body = request.postDataJSON(); posts.push(body);
          if (body.command === 'start') {
            if (rejectedStart) return route.fulfill({ status: 400, json: { problem: scenario === 'file-missing' ? 'file_missing' : 'file_exists', error: 'Raw target diagnostic' } });
            if (scenario === 'server-error' && posts.length === 1) return route.fulfill({ status: 500, json: { problem: 'request_unknown', error: 'Server lost the response' } });
            const operation = { id: body.requestId, runId: 'run', createdAt: Date.now(), source: { toolCallId: 'call', operationId: 'generation', leafId: 'leaf', publicationEntryId: 'leaf', revision, digest: 'current' },
              action, file: { path: `/project/${action.path}` }, status: approval ? 'waiting_approval' : failedOperation ? 'failed' : 'completed',
              ...(failedOperation ? { error: 'JSON must contain exactly the current input IDs and valid values', ...(scenario === 'invalid-parameters' ? { problem: 'parameters_invalid' } : {}) }
                : approval ? { approval: { id: 'approval', message: `Create /project/${action.path}` } }
                : { result: scenario === 'query' ? { kind: 'parameters', state: { people: 9 } } : { kind: 'snapshot', path: '/project/report.json', sha256: 'hash', bytes: 100 } }) };
            operations.push(operation);
            if (scenario === 'lost-response') return route.abort('failed');
            return route.fulfill({ status: 202, json: operation });
          }
          const operation = operations.find(item => item.id === body.operationId);
          if (body.command === 'approve') { assert.equal(body.approvalId, 'approval'); operation.status = 'completed'; delete operation.approval; }
          if (body.command === 'apply') {
            if (operation.source.revision !== revision) return route.fulfill({ status: 409, json: { error: 'Parameters changed since query' } });
            state = { people: 9 }; revision++; operation.appliedRevision = revision;
          }
          return route.fulfill({ json: { accepted: true } });
        }
        if (url.pathname.endsWith('/intelligent-ui')) {
          if (request.method() === 'PUT') {
            if (holdWrites) await new Promise(resolve => { releaseWrite = resolve; });
            state = request.postDataJSON().state; revision++;
          }
          return route.fulfill({ json: { surface, state, revision, leafId: 'leaf', publication: { status: 'committed', operationId: 'generation' } } });
        }
        if (url.pathname.endsWith('/bundle.js')) return route.fulfill({ contentType: 'text/javascript', body: await readFile(path.join(directory, 'bundle.js')) });
        return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="${keyboard ? 'en' : 'zh-CN'}"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>:root{--border:#ccc;--bg:#fff;--bg-hover:#eee;--text:#222;--accent:#4176ce}*{box-sizing:border-box}body{margin:0;font:16px system-ui}main{padding:16px}${css}</style><div id="root"></div><script src="/bundle.js"></script></html>` });
      });
      await page.goto(`https://ui-actions.test/${english ? '?locale=en' : ''}`);
      if (scenario === 'invalid-status') {
        await page.getByRole('alert').waitFor(); assert.deepEqual(errors, []);
        malformed = false; await page.getByRole('button', { name: '查询结果', exact: true }).click();
      }
      const button = page.getByRole('button', { name: action.label, exact: true });
      await button.waitFor(); await page.waitForFunction(() => window.store.getSnapshot().status === 'saved');
      await page.getByText(action.kind === 'save_snapshot'
        ? english ? 'Saves the acknowledged values when clicked. Creates a new file; an existing file is never overwritten.' : '保存点击时已保存的参数和结果。只新建文件，不会覆盖同名文件。'
        : '读取后先核对参数，点击采用才会更改当前值。', { exact: true }).waitFor();
      if (keyboard) {
        await page.getByRole('region', { name: 'Actions', exact: true }).waitFor();
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'long target paths stay inside a narrow panel');
        await page.keyboard.press('Tab'); assert.equal(await button.evaluate(n => n === document.activeElement), true);
        assert.notEqual(await button.evaluate(n => getComputedStyle(n).outlineStyle), 'none');
        await page.keyboard.press('Enter');
      } else await button.click();
      if (rejectedStart) {
        const expected = scenario === 'file-missing' ? '没有找到参数文件。' : english ? 'A file already exists at this path.' : '这个路径下已有文件。';
        await page.getByRole('alert').filter({ hasText: expected }).waitFor();
        await page.waitForFunction(() => !document.querySelector('button').disabled);
        assert.equal(await page.getByRole('button', { name: english ? 'Retry this same request' : '重试同一次请求', exact: true }).count(), 0, 'definite rejection does not leave an ambiguous retry');
        assert.equal(await page.getByText('Raw target diagnostic', { exact: true }).isVisible(), false);
        const details = page.locator('summary').filter({ hasText: english ? 'Technical details' : '技术详情' });
        await details.focus(); await page.keyboard.press('Enter');
        assert.equal(await page.getByText('Raw target diagnostic', { exact: true }).isVisible(), true);
        assert.equal(posts.length, 1); assert.equal(operations.length, 0);
      } else if (failedOperation) {
        const expected = scenario === 'invalid-parameters' ? '这份参数文件无法使用。' : '操作未完成，请先查询结果';
        await page.getByText(expected, { exact: false }).waitFor();
        await page.reload(); await page.getByText(expected, { exact: false }).waitFor();
        assert.equal(await page.getByRole('button', { name: '采用这些参数', exact: true }).count(), 0);
        assert.equal(await page.evaluate(() => window.store.getSnapshot().state.people), 4);
        assert.equal(posts.length, 1, 'loading a saved failure does not replay the action');
      } else if (scenario === 'server-error') {
        await page.getByRole('alert').waitFor();
        await page.getByRole('button', { name: '查询结果', exact: true }).click();
        await page.getByRole('alert').waitFor();
        const retry = page.getByRole('button', { name: '重试同一次请求', exact: true }); await retry.waitFor();
        assert.equal(posts.length, 1, 'a server error and status query never automatically repeat a save');
        await retry.click(); await page.getByRole('status').filter({ hasText: '已完成' }).waitFor();
        assert.equal(posts.length, 2); assert.deepEqual(posts[0], posts[1], 'an explicit retry keeps the original request identity');
      } else if (approval) {
        const allow = page.getByRole('button', { name: keyboard ? 'Allow once' : '允许这一次', exact: true });
        await allow.waitFor();
        assert.equal(await button.isDisabled(), true); assert.equal(posts.length, 1);
        if (keyboard) {
          await page.getByRole('status').filter({ hasText: 'Waiting for approval' }).waitFor();
          assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'approval text wraps too');
          await page.keyboard.press('Tab'); assert.equal(await allow.evaluate(n => n === document.activeElement), true);
          await page.keyboard.press('Space');
        } else await allow.click();
        await page.getByRole('status').filter({ hasText: keyboard ? 'Completed' : '已完成' }).waitFor();
        assert.deepEqual(posts.map(item => item.command), ['start', 'approve']);
      } else if (scenario === 'lost-response') {
        await page.getByRole('alert').waitFor();
        await page.getByRole('button', { name: '查询结果', exact: true }).click();
        await page.getByRole('status').filter({ hasText: '已完成' }).waitFor();
        await page.reload(); await page.getByRole('status').filter({ hasText: '已完成' }).waitFor();
        assert.equal(posts.length, 1, 'query and remount never replay a write');
      } else if (scenario === 'query') {
        const apply = page.getByRole('button', { name: '采用这些参数' }); await apply.waitFor();
        assert.equal(await page.evaluate(() => window.store.getSnapshot().state.people), 4);
        assert.deepEqual(posts.map(item => item.command), ['start']);
        await apply.click(); await page.getByText('已采用参数', { exact: true }).waitFor();
        assert.equal(await page.evaluate(() => window.store.getSnapshot().state.people), 9);
        await button.click(); await apply.waitFor();
        holdWrites = true; await page.evaluate(() => window.store.change('people', 6));
        assert.equal(await apply.isDisabled(), true, 'a local dirty draft cannot be replaced by queried values');
        await page.waitForTimeout(350); holdWrites = false; releaseWrite?.();
        await page.waitForFunction(() => window.store.getSnapshot().status === 'saved');
        await apply.click(); await page.getByRole('alert').waitFor();
        assert.equal(await page.evaluate(() => window.store.getSnapshot().state.people), 6, 'the CAS rejection preserves newer parameters');
        assert.deepEqual(posts.map(item => item.command), ['start', 'apply', 'start', 'apply']);
      } else {
        await page.getByRole('status').filter({ hasText: '已完成' }).waitFor();
        assert.deepEqual(posts.map(item => item.command), ['start']);
      }
      if (process.env.PIORA_UI_ACTION_EVIDENCE_DIR && ['file-exists-zh', 'file-exists-en', 'invalid-parameters'].includes(scenario)) {
        const destination = path.resolve(process.env.PIORA_UI_ACTION_EVIDENCE_DIR); await mkdir(destination, { recursive: true });
        await page.screenshot({ path: path.join(destination, `${scenario}.png`), fullPage: true });
      }
      assert.deepEqual(errors, []); await page.close();
    });
  } finally {
    await browser?.close(); assert.ok(path.resolve(directory).startsWith(path.resolve(tmpdir()))); await rm(directory, { recursive: true, force: true });
  }
});
