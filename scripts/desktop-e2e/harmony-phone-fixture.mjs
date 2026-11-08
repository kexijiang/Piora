import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Real phone page: observations come from touch/text/scroll events on the device. */
export async function verifyMirrorInput({ page, directory, waitUntil }) {
  const execute = promisify(execFile);
  const hdc = async args => (await execute(process.env.PIORA_MIRROR_TEST_HDC,
    ['-t', process.env.PIORA_MIRROR_TEST_SERIAL, ...args],
    { encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024 })).stdout;
  const observations = [], inputRequests = [], inputResponses = [];
  const onRequest = request => {
    if (new URL(request.url()).pathname !== '/api/harmony/action' || request.method() !== 'POST') return;
    const { leaseToken: _token, ...body } = request.postDataJSON(); inputRequests.push(body);
  };
  const onResponse = async response => {
    if (new URL(response.url()).pathname === '/api/harmony/action') inputResponses.push({ status: response.status(), result: await response.json().catch(() => null) });
  };
  page.on('request', onRequest); page.on('response', onResponse);
  let latest = {}, forwarded = false;
  const server = createServer(async (request, response) => {
    try {
      if (request.url === '/state' && request.method === 'POST') {
        let body = ''; for await (const chunk of request) { body += chunk; if (body.length > 8192) throw new Error('Oversized phone observation'); }
        latest = JSON.parse(body); observations.push(latest); response.end('ok'); return;
      }
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1"><title>Piora input test</title>
        <style>html,body{margin:0;background:#152a3c;color:white;font:20px sans-serif}body{height:400vh;background:repeating-linear-gradient(#152a3c 0 25vh,#28536b 25vh 50vh)}button{position:fixed;left:5vw;top:12vh;width:90vw;height:60vh;font-size:30px}input{position:fixed;left:5vw;top:18vh;width:80vw;font-size:24px;padding:12px}p{position:fixed;bottom:12vh;margin:5vw}</style>
        <button>Tap to test Piora control</button><input hidden aria-label="Piora test text"><p>Piora authorized input test</p>
        <script>const button=document.querySelector('button'),input=document.querySelector('input'),label=document.querySelector('p');let clicks=0,revision=0,frames=0,fps=0,last=performance.now();
        let pointer;const report=()=>fetch('/state',{method:'POST',body:JSON.stringify({revision:++revision,clicks,text:input.value,scroll:scrollY,focused:document.activeElement===input,width:innerWidth,height:innerHeight,fps,pointer})});
        onpointerdown=onpointerup=e=>{pointer={type:e.type,x:e.clientX,y:e.clientY,target:e.target.tagName};report()};
        button.onclick=()=>{clicks++;button.hidden=true;input.hidden=false;input.focus();report()};input.oninput=report;input.onchange=report;onscroll=report;onresize=report;
        function animate(now){label.style.transform='translateX('+Math.sin(now/300)*30+'px)';frames++;if(now-last>=1000){fps=frames*1000/(now-last);frames=0;last=now;report()}requestAnimationFrame(animate)}report();requestAnimationFrame(animate);</script>`);
    } catch (error) { response.statusCode = 400; response.end(String(error)); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await writeFile(join(directory, 'phone-forward.json'), JSON.stringify({ serial: process.env.PIORA_MIRROR_TEST_SERIAL, port, direction: 'reverse' }));
  const control = page.getByRole('button', { name: /^(Control device|操控手机)$/ });
  try {
    const forward = await hdc(['rport', `tcp:${port}`, `tcp:${port}`]);
    assert.doesNotMatch(forward, /fail|error/i); forwarded = true;
    const launch = await hdc(['shell', `aa start -a MainAbility -b com.huawei.hmos.browser -U http://127.0.0.1:${port}/`]);
    assert.match(launch, /start ability successfully/i);
    await waitUntil(() => latest.revision > 0, 'real phone input page');
    await control.click();
    assert.equal(await control.getAttribute('aria-pressed'), 'true');
    const zoom = page.getByRole('combobox', { name: /^(Video zoom|画面缩放)$/ });
    await zoom.selectOption('0.5');
    const surface = page.getByLabel(/^(Mirror interaction area|投屏交互区域)$/);
    assert.equal(await surface.evaluate(element => element.parentElement.dataset.zoomed), 'true');
    await zoom.selectOption('fit');
    const pin = page.getByRole('button', { name: /^(Always on top|窗口置顶)$/ });
    await pin.click(); await waitUntil(async () => await pin.getAttribute('aria-pressed') === 'true', 'native always-on-top acknowledgement');
    await pin.click(); await waitUntil(async () => await pin.getAttribute('aria-pressed') === 'false', 'native always-on-top restoration');
    await surface.evaluate(element => {
      window.mirrorInputEvents = [];
      for (const type of ['pointerdown', 'pointerup']) element.addEventListener(type, event => window.mirrorInputEvents.push({ type, x: event.clientX, y: event.clientY, timestamp: event.timeStamp, bounds: element.getBoundingClientRect().toJSON() }), { capture: true });
    });
    await surface.click();
    await waitUntil(() => latest.clicks === 1 && latest.focused, 'phone touch event and focused input');
    const text = 'Piora 投屏真机测试 2026';
    await page.getByRole('textbox', { name: /^(Send text to device|发送文字到手机)$/ }).fill(text);
    await page.getByRole('button', { name: /^(Send|发送)$/, exact: true }).last().click();
    await waitUntil(() => latest.text === text, 'text observed by the real phone browser');
    await waitUntil(async () => await page.getByRole('textbox', { name: /^(Send text to device|发送文字到手机)$/ }).inputValue() === '', 'successful input receipt clears the originating text');
    await page.getByRole('button', { name: /^(back|返回)$/, exact: true }).last().click();
    const dragReceipt = () => page.waitForResponse(response => new URL(response.url()).pathname === '/api/harmony/action'
      && response.request().postDataJSON()?.action === 'drag');
    await surface.hover();
    const wheelReceipt = dragReceipt(); await page.mouse.wheel(0, 400);
    assert.equal((await wheelReceipt).status(), 200);
    await waitUntil(() => latest.scroll > 0, 'phone scroll from mirror wheel gesture');
    let settledAt = Date.now(), previousScroll = latest.scroll;
    await waitUntil(() => {
      if (latest.scroll !== previousScroll) { previousScroll = latest.scroll; settledAt = Date.now(); }
      return Date.now() - settledAt >= 300;
    }, 'wheel inertia settles before the independent drag');
    const before = latest.scroll;
    const observationStart = observations.length, movedReceipt = dragReceipt();
    const box = await surface.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height * .7);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height * .4, { steps: 15 });
    await page.mouse.up();
    assert.equal((await movedReceipt).status(), 200);
    await waitUntil(() => latest.scroll > before && observations.slice(observationStart).some(item => item.pointer?.type === 'pointerdown'), 'phone touch and scroll from mirror drag gesture');
    const start = await page.evaluate(() => performance.now());
    const samples = () => page.evaluate(since => (window.mirrorWorkerEvents ?? [])
      .filter(event => event.type === 'statistics' && event.at >= since).map(event => event.statistics), start);
    await waitUntil(async () => (await samples()).length >= 30, '30 seconds of actual desktop video statistics');
    const statistics = await samples();
    await writeFile(join(directory, 'application-video-statistics.json'), JSON.stringify(statistics, null, 2));
    assert.ok(statistics.every(sample => sample.presentedFps >= 60), 'actual Next/Electron authenticated stream must draw at least 60 FPS in every measured window');
    await page.screenshot({ path: join(directory, 'input-verified.png') });
  } finally {
    page.off('request', onRequest); page.off('response', onResponse);
    await writeFile(join(directory, 'mirror-input-dispatch.json'), JSON.stringify({ inputRequests, inputResponses, pointerEvents: await page.evaluate(() => window.mirrorInputEvents ?? []).catch(() => []) }, null, 2));
    if (await control.getAttribute('aria-pressed').catch(() => null) === 'true') await control.click().catch(() => {});
    await writeFile(join(directory, 'phone-input-observations.json'), JSON.stringify(observations, null, 2));
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    if (forwarded) {
      const removed = await hdc(['fport', 'rm', `tcp:${port}`, `tcp:${port}`]);
      assert.doesNotMatch(removed, /\[fail\]/i);
      const remaining = await hdc(['fport', 'ls']);
      assert.ok(!remaining.split(/\r?\n/).some(line => line.trim().split(/\s+/).slice(0, 3).join(' ') === `${process.env.PIORA_MIRROR_TEST_SERIAL} tcp:${port} tcp:${port}`), 'owned reverse forward must be removed');
    }
  }
}
