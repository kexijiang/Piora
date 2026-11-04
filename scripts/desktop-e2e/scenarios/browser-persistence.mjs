import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

let fixture;
export const browserPersistence = {
  id: 'browser-persistence',
  scope: 'real Electron browser, two prepared chats, controlled loopback login and isolated-profile process restart',
  coverage: ['UI navigation and login', 'HttpOnly session cookie across chats', 'localStorage and IndexedDB across chats and restart', 'real Electron encrypted cookie recovery'],
  limits: ['original reported site and enterprise SSO', 'remote model-controlled browsing', 'packaged release', 'graceful OS logout or power loss'],
  async prepare({ paths, directory, registerCleanup, report }) {
    const server = createServer((request, response) => {
      if (request.url === '/login' && request.method === 'POST') {
        response.writeHead(303, { 'Set-Cookie': 'fixture_login=present; HttpOnly; SameSite=Lax; Path=/', Location: '/chat-a' });
        response.end(); return;
      }
      const authenticated = (request.headers.cookie ?? '').includes('fixture_login=present');
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end(`<!doctype html><title>Persistence fixture</title><h1>${authenticated ? 'Signed in' : 'Signed out'}</h1>
        <form method="post" action="/login"><button>Sign in to fixture</button></form>
        <button id="save">Save site data</button><output id="saved"></output>
        <script>document.querySelector('#save').onclick=()=>{localStorage.setItem('fixture','retained');const request=indexedDB.open('fixture',1);request.onupgradeneeded=()=>request.result.createObjectStore('data');request.onsuccess=()=>{const db=request.result,tx=db.transaction('data','readwrite');tx.objectStore('data').put('retained','key');tx.oncomplete=()=>{db.close();document.querySelector('#saved').textContent='Saved';}}}</script>`);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    registerCleanup(() => new Promise((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); }));
    const sessions = join(paths.agent, 'sessions', '--persistence-fixture--');
    const cwd = join(directory, 'workspace');
    await mkdir(sessions, { recursive: true }); await mkdir(cwd);
    const sessionIds = {};
    for (const name of ['Persistence chat A', 'Persistence chat B']) {
      const id = randomUUID(), timestamp = new Date().toISOString();
      sessionIds[name] = id;
      await writeFile(join(sessions, `${id}.jsonl`), [
        {type:'session',version:3,id,timestamp,cwd},
        {type:'message',id:'user1',parentId:null,message:{role:'user',content:'Controlled browser persistence fixture',timestamp:Date.now()}},
        {type:'session_info',id:'info1',parentId:'user1',name,timestamp},
      ].map(row => JSON.stringify(row)).join('\n')+'\n');
    }
    fixture = { origin: `http://127.0.0.1:${server.address().port}`, profile: paths.profile, sessionIds };
    report.fixture = { origin: fixture.origin, sessions: 'two synthetic local histories; no model call', restart: 'owned process tree termination and relaunch with the same isolated profile' };
  },
  async run({ page: initialPage, getBrowser, restart, screenshot, step, waitUntil, directory }) {
    let page = initialPage;
    let loginAt = 0;
    const observations = [];
    async function open(name) {
      await page.getByText(name, { exact: true }).first().click();
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+t' : 'Control+t');
      const address = page.getByRole('textbox', { name: /^(Address|地址)$/ });
      const target = `${fixture.origin}/${name.endsWith("A") ? "chat-a" : "chat-b"}`;
      await waitUntil(async () => (await page.evaluate(() => window.piDesktop.browser.getState())).sessionId === fixture.sessionIds[name], "selected chat browser binding");
      await address.fill(target); await address.press('Enter');
      return waitUntil(() => getBrowser().contexts().flatMap(context => context.pages()).find(candidate => candidate.url() === target), 'controlled site native browser target');
    }
    async function verify(site, phase) {
      await site.getByRole('heading', { name: 'Signed in', exact: true }).waitFor();
      const state = await site.evaluate(async () => ({ local: localStorage.getItem('fixture'), indexed: await new Promise((resolve,reject)=>{
        const request=indexedDB.open('fixture',1);request.onerror=()=>reject(request.error);request.onsuccess=()=>{const db=request.result,tx=db.transaction('data');const read=tx.objectStore('data').get('key');read.onsuccess=()=>resolve(read.result);read.onerror=()=>reject(read.error);tx.oncomplete=()=>db.close();};
      }) }));
      assert.deepEqual(state,{local:'retained',indexed:'retained'});
      observations.push({ phase, authenticated: true, ...state });
    }
    try {
      await step('login-first-chat', async () => {
        const site = await open('Persistence chat A');
        loginAt = Date.now();
        await site.getByRole('button', {name:'Sign in to fixture'}).click();
        await site.getByRole('heading', {name:'Signed in',exact:true}).waitFor();
        await site.getByRole('button', {name:'Save site data'}).click();
        await site.getByText('Saved',{exact:true}).waitFor();
        await verify(site,'first-chat');
      });
      await step('switch-chat-retains-login', async () => { await verify(await open('Persistence chat B'),'second-chat'); await screenshot('browser-second-chat.png'); });
      await step('wait-encrypted-cookie-snapshot', async () => {
        await waitUntil(async () => { try { const saved = await stat(join(fixture.profile,'browser-session-cookies.enc')); return saved.size > 0 && saved.mtimeMs >= loginAt; } catch { return false; } }, 'encrypted session-cookie snapshot');
      });
      await step('restart-same-profile', async () => { page = await restart(); });
      await step('restart-retains-login', async () => { await verify(await open('Persistence chat A'),'restarted'); await screenshot('browser-restarted.png'); });
    } finally { await writeFile(join(directory,'browser-persistence-evidence.json'),JSON.stringify(observations,null,2)); }
  },
};
