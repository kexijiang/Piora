import assert from 'node:assert/strict';
import { mkdir, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { verifyMirrorInput } from '../harmony-phone-fixture.mjs';

export const harmonyMirror = {
  id: 'harmony-mirror',
  scope: 'real Electron, Next.js worker bundle, authenticated manager and authorized HDC device',
  coverage: ['passive video', 'worker reload', 'screenshot save', 'independent MP4 recording', 'floating/sidebar handoff', 'close',
    ...(process.env.PIORA_MIRROR_TEST_INPUT === 'true' ? ['real phone tap/text/wheel/drag', 'zoom', 'always on top', '30-second authenticated video draw FPS'] : [])],
  limits: ['physical display latency and sustained FPS (separate performance test)', 'packaged build',
    ...(process.env.PIORA_MIRROR_TEST_INPUT === 'true' ? [] : ['input injection'])],
  async prepare({ paths, directory }) {
    if (!process.env.PIORA_MIRROR_TEST_HDC || !process.env.PIORA_MIRROR_TEST_SERIAL) throw new Error('Set PIORA_MIRROR_TEST_HDC and PIORA_MIRROR_TEST_SERIAL for an authorized real device');
    const data = join(paths.profile, 'runtime', 'normal'), media = join(directory, 'media');
    await mkdir(data, { recursive: true }); await mkdir(media);
    await writeFile(join(data, 'harmony.json'), JSON.stringify({ hdcPath: process.env.PIORA_MIRROR_TEST_HDC,
      storage: { screenshotDirectory: media, recordingDirectory: media } }));
  },
  async run({ page, getBrowser, directory, step, waitUntil }) {
    await page.context().addInitScript(() => {
      const NativeWorker = window.Worker; window.mirrorWorkerEvents = [];
      window.Worker = class extends NativeWorker {
        constructor(...args) {
          super(...args);
          this.addEventListener('message', ({ data }) => {
            if (data.type === 'statistics' || data.type === 'state') {
              window.mirrorWorkerEvents.push({ ...data, at: performance.now() });
              if (window.mirrorWorkerEvents.length > 500) window.mirrorWorkerEvents.shift();
            }
          });
        }
      };
    });
    const serial = process.env.PIORA_MIRROR_TEST_SERIAL;
    const mutations = [], artifacts = [];
    const track = target => {
      target.on('request', request => { if (request.method() === 'POST' && /\/api\/harmony\/(action|manual)/.test(request.url())) mutations.push(request.url()); });
      target.on('response', async response => {
        if (response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/harmony/media' && response.ok()) {
          const result = await response.json().catch(() => ({})); if (result.artifact) artifacts.push(result.artifact);
        }
      });
    };
    track(page);
    let mirror;
    const observations = [];
    const live = async target => {
      await target.getByRole('img', { name: /^(Device screen|手机画面)$/ }).waitFor();
      await waitUntil(async () => {
        const image = target.getByRole('img', { name: /^(Device screen|手机画面)$/ });
        return image.evaluate(canvas => canvas.width > 100 && canvas.height > 100);
      }, 'worker frame geometry');
      // Compact native windows intentionally hide the FPS badge. Its populated
      // value still proves the real worker decoded and drew a complete sample.
      const fps = target.locator('header button').filter({ hasText: /^\d+\s*FPS$/ });
      await fps.waitFor({ state: 'attached', timeout: 60000 });
      try {
        await waitUntil(async () => Number.parseInt(await fps.textContent(), 10) > 0, 'positive drawn frame rate');
      } finally {
        observations.push({ url: target.url(), events: await target.evaluate(() => window.mirrorWorkerEvents ?? []) });
        await writeFile(join(directory, 'worker-observations.json'), JSON.stringify(observations, null, 2));
        await target.screenshot({ path: join(directory, 'latest-mirror.png') });
      }
    };
    await step('open-device-workbench', async () => {
      const toggle = page.locator('.right-panel-toggle');
      if (await toggle.getAttribute('aria-expanded') === 'false') await toggle.click();
      await page.getByRole('button', { name: /^(Harmony device|鸿蒙设备)$/ }).click();
      const devices = page.getByRole('combobox', { name: /^(Select device|选择设备)$/ });
      await waitUntil(() => devices.locator('option').evaluateAll((items, expected) => items.some(item => item.value === expected), serial), 'connected phone');
      await devices.selectOption(serial);
      await page.getByRole('combobox', { name: /^(Mirror position|投屏位置)$/ }).selectOption('floating');
    });
    await step('open-passive-mirror', async () => {
      await page.getByRole('button', { name: /^(Open mirror|打开投屏)$/, exact: true }).first().click();
      mirror = await waitUntil(() => getBrowser().contexts().flatMap(context => context.pages()).find(candidate => candidate.url().includes('desktop-harmony')), 'native mirror window');
      track(mirror); await live(mirror);
      assert.equal(await mirror.getByRole('button', { name: /^(Control device|操控手机)$/ }).getAttribute('aria-pressed'), 'false');
      assert.deepEqual(mutations, [], 'opening must not acquire control or change the phone');
      await mirror.screenshot({ path: join(directory, 'floating.png') });
    });
    await step('prepare-sidebar-renderer', async () => {
      // Exercise both independently before the timed handoff. Next development
      // compilation is intentionally outside the native 30-second handoff SLA.
      await mirror.getByRole('button', { name: /^(Close mirror|关闭投屏)$/ }).click();
      const position = page.getByRole('combobox', { name: /^(Mirror position|投屏位置)$/ });
      await position.selectOption('sidebar');
      await page.getByRole('button', { name: /^(Open mirror|打开投屏)$/, exact: true }).first().click();
      await live(page);
      await page.getByRole('button', { name: /^(Close mirror|关闭投屏)$/ }).click();
      await position.selectOption('floating');
      await page.getByRole('button', { name: /^(Open mirror|打开投屏)$/, exact: true }).first().click();
      mirror = await waitUntil(() => getBrowser().contexts().flatMap(context => context.pages()).find(candidate => candidate.url().includes('desktop-harmony')), 'reopened native mirror window');
      track(mirror); await live(mirror);
    });
    await step('worker-reload', async () => { await mirror.reload(); await live(mirror); });
    await step('save-screenshot', async () => {
      await mirror.getByRole('button', { name: /^(Screenshot|截图)$/ }).click();
      await waitUntil(() => artifacts.find(file => file.kind === 'screenshot'), 'saved screenshot');
      assert.ok((await stat(artifacts.find(file => file.kind === 'screenshot').path)).size > 100);
    });
    await step('record-and-handoff', async () => {
      await mirror.getByRole('button', { name: /^(Start recording|开始录屏)$/ }).click();
      await mirror.getByRole('button', { name: /^(Stop recording|停止录屏)$/ }).waitFor();
      await mirror.getByRole('button', { name: /^(Dock mirror|在侧栏显示)$/ }).click();
      await live(page);
      await page.getByRole('button', { name: /^(Stop recording|停止录屏)$/ }).last().click();
      await waitUntil(() => artifacts.find(file => file.kind === 'recording'), 'saved MP4');
      assert.ok((await stat(artifacts.find(file => file.kind === 'recording').path)).size > 1000);
      await page.screenshot({ path: join(directory, 'docked.png') });
    });
    assert.deepEqual(mutations, [], 'viewing and recording must remain passive');
    if (process.env.PIORA_MIRROR_TEST_INPUT === 'true') {
      await step('real-device-input', async () => {
        await page.getByRole('button', { name: /^(Float mirror|切换到悬浮投屏)$/ }).click();
        mirror = await waitUntil(() => getBrowser().contexts().flatMap(context => context.pages()).find(candidate => candidate.url().includes('desktop-harmony')), 'returned native mirror window');
        await live(mirror);
        await verifyMirrorInput({ page: mirror, directory, waitUntil });
        await mirror.getByRole('button', { name: /^(Dock mirror|在侧栏显示)$/ }).click();
        await live(page);
      });
    }
    await step('close-mirror', async () => {
      await page.getByRole('button', { name: /^(Close mirror|关闭投屏)$/ }).click();
      await page.getByRole('img', { name: /^(Device screen|手机画面)$/ }).waitFor({ state: 'detached' });
      if (process.env.PIORA_MIRROR_TEST_INPUT !== 'true') assert.deepEqual(mutations, [], 'viewing and recording must remain passive');
      await writeFile(join(directory, 'media-evidence.json'), JSON.stringify(artifacts, null, 2));
    });
  },
};
