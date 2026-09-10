import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

const require = createRequire(import.meta.url);
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

/** Actual OLE FileDrop delivery to a separate, owned Windows process. */
export async function verifyNativeClipboardDrag(application, quick, directory) {
  assert.equal(process.platform, 'win32');
  const koffi = require('koffi'), user32 = koffi.load('user32.dll');
  const sendInput = user32.func('uint32_t __stdcall SendInput(uint32_t count, const void *input, int size)');
  const metrics = user32.func('int __stdcall GetSystemMetrics(int index)');
  const cursor = user32.func('int __stdcall GetCursorPos(void *point)');
  const keyState = user32.func('int16_t __stdcall GetAsyncKeyState(int key)');
  const pointType = koffi.struct('ClipboardDragProbePoint', { x: 'int32_t', y: 'int32_t' });
  const windowAt = user32.func('WindowFromPoint', 'uintptr_t', [pointType]);
  const ancestor = user32.func('uintptr_t __stdcall GetAncestor(uintptr_t window, uint32_t flags)');
  const windowPid = user32.func('uint32_t __stdcall GetWindowThreadProcessId(uintptr_t window, void *pid)');
  const showWindow = user32.func('int __stdcall ShowWindow(uintptr_t window, int command)');
  const visible = user32.func('int __stdcall IsWindowVisible(uintptr_t window)');
  // Node's console process can otherwise receive DPI-virtualized coordinates
  // while Electron and the target report physical screen pixels.
  const setDpiContext = user32.func('intptr_t __stdcall SetThreadDpiAwarenessContext(intptr_t context)');
  const previousDpiContext = setDpiContext(-4);
  assert.notEqual(Number(previousDpiContext), 0);
  const desktop = { x: metrics(76), y: metrics(77), width: metrics(78), height: metrics(79) };
  const original = Buffer.alloc(8); assert.ok(cursor(original));
  let mouseDown = false, lastPoint = null, child;
  const mouse = (point, button = 0) => {
    const size = process.arch === 'ia32' ? 28 : 40, offset = process.arch === 'ia32' ? 4 : 8;
    const input = Buffer.alloc(size);
    input.writeInt32LE(Math.round((point.x - desktop.x) * 65535 / (desktop.width - 1)), offset);
    input.writeInt32LE(Math.round((point.y - desktop.y) * 65535 / (desktop.height - 1)), offset + 4);
    input.writeUInt32LE(0x8000 | 0x4000 | 1 | button, offset + 12);
    assert.equal(sendInput(1, input, size), 1, 'Windows accepted the owned drag input');
    lastPoint = point;
  };
  const statePath = join(directory, 'native-drag-state.json'), script = join(directory, 'native-drag-target.ps1');
  try {
    for (const key of [1, 2, 0x10, 0x11, 0x12]) assert.equal(keyState(key) & 0x8000, 0, 'drag test requires released mouse buttons and modifiers');
    const layout = await application.evaluate(({ screen }) => {
      const area = screen.getPrimaryDisplay().workArea;
      if (area.width < 1050 || area.height < 540) throw new Error('Native drag acceptance needs a 1050×540 DIP work area');
      const width = Math.min(760, area.width - 420);
      const target = screen.dipToScreenRect(null, { x: area.x + area.width - 400, y: area.y + 80, width: 380, height: 300 });
      return { area, width, target, scaleFactor: screen.getPrimaryDisplay().scaleFactor };
    });
    await writeFile(script, `param([string]$StatePath,[int]$X,[int]$Y,[int]$Width,[int]$Height)
Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public static class ClipboardDragDpi { [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value); }'
[void][ClipboardDragDpi]::SetProcessDpiAwarenessContext([IntPtr](-4))
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$form = New-Object System.Windows.Forms.Form
$form.Text = 'Piora isolated native drop acceptance'
$form.StartPosition = 'Manual'; $form.Left = $X; $form.Top = $Y; $form.Width = $Width; $form.Height = $Height
$form.TopMost = $true; $form.AllowDrop = $true
$script:drops = @()
$form.Add_DragEnter({ param($sender,$eventArgs)
  if ($eventArgs.Data.GetDataPresent([System.Windows.Forms.DataFormats]::FileDrop)) { $eventArgs.Effect = [System.Windows.Forms.DragDropEffects]::Copy }
})
$form.Add_DragOver({ param($sender,$eventArgs)
  if ($eventArgs.Data.GetDataPresent([System.Windows.Forms.DataFormats]::FileDrop)) { $eventArgs.Effect = [System.Windows.Forms.DragDropEffects]::Copy }
})
$form.Add_DragDrop({ param($sender,$eventArgs)
  $files = @($eventArgs.Data.GetData([System.Windows.Forms.DataFormats]::FileDrop))
  $script:drops += @{ files = $files; effect = $eventArgs.Effect.ToString() }
})
$timer = New-Object System.Windows.Forms.Timer; $timer.Interval = 50
$timer.Add_Tick({
  $point = $form.PointToScreen((New-Object System.Drawing.Point([int]($form.ClientSize.Width / 2),[int]($form.ClientSize.Height / 2))))
  $state = @{ handle = $form.Handle.ToInt64().ToString(); pid = $PID; x = $point.X; y = $point.Y; drops = @($script:drops) }
  [System.IO.File]::WriteAllText($StatePath, ($state | ConvertTo-Json -Depth 5 -Compress), (New-Object System.Text.UTF8Encoding($false)))
})
$form.Add_Shown({ $timer.Start() })
try { [System.Windows.Forms.Application]::Run($form) } finally { $timer.Stop(); $timer.Dispose(); $form.Dispose() }
`, 'utf8');
    child = spawn('powershell.exe', ['-NoProfile', '-STA', '-File', script, '-StatePath', statePath, '-X', String(layout.target.x), '-Y', String(layout.target.y), '-Width', String(layout.target.width), '-Height', String(layout.target.height)], { windowsHide: true, stdio: 'ignore' });
    const state = async predicate => {
      const deadline = Date.now() + 20000;
      while (Date.now() < deadline) {
        assert.equal(child.exitCode, null, 'owned drop target remains alive');
        const value = await readFile(statePath, 'utf8').then(JSON.parse).catch(() => null);
        if (value && predicate(value)) return value;
        await pause(80);
      }
      throw new Error('Independent Windows drop target did not acknowledge the drag');
    };
    const ready = await state(value => value.handle && value.pid === child.pid);
    const pid = Buffer.alloc(4); windowPid(BigInt(ready.handle), pid); assert.equal(pid.readUInt32LE(), child.pid);
    // windowsHide suppresses the PowerShell console and can also hide the first
    // owned form through STARTUPINFO. Explicitly show only its verified HWND.
    showWindow(BigInt(ready.handle), 9);
    assert.ok(visible(BigInt(ready.handle)), 'owned drop receiver is visible');
    const folder = join(directory, '拖放验收 文件夹'), file = join(directory, '拖放验收 😀 文件.txt');
    await mkdir(folder); await writeFile(join(folder, 'child.txt'), 'folder child 中文'); await writeFile(file, 'native file drop 中文😀');
    const ids = await application.evaluate(async (_electron, { folder, file, fileName, folderName }) => ({
      image: global.imageId,
      files: await global.controller.runtime.store.capture({ files: [{ path: file, name: fileName, directory: false }, { path: folder, name: folderName, directory: true }], source: { name: 'Native drop fixture', executable: 'fixture.exe' } }),
    }), { folder, file, fileName: basename(file), folderName: basename(folder) });
    const imageHash = await quick.evaluate(async id => (await window.piDesktop.clipboard.historyV2.getDetail(id)).image.hash, ids.image);
    const results = [];
    for (const [kind, id] of Object.entries(ids)) {
      await application.evaluate(async ({ screen }, layout) => {
        await global.controller.open('quick');
        const window = global.controller.windows.get('quick');
        window.setBounds({ x: layout.area.x, y: layout.area.y, width: layout.width, height: 540 });
        window.show(); window.focus();
      }, layout);
      const title = await quick.evaluate(async id => (await window.piDesktop.clipboard.historyV2.getDetail(id)).title, id);
      await quick.getByLabel('搜索剪贴板', { exact: true }).fill(title);
      const row = quick.locator('#clipboard-' + id); await row.click();
      await quick.waitForFunction(id => document.getElementById('clipboard-' + id)?.draggable, id);
      const bounds = await row.boundingBox(); assert.ok(bounds);
      const origin = await application.evaluate(({ screen }, point) => {
        const window = global.controller.windows.get('quick'), bounds = window.getContentBounds(), handle = window.getNativeWindowHandle();
        return { ...screen.dipToScreenPoint({ x: Math.round(bounds.x + point.x), y: Math.round(bounds.y + point.y) }), handle: (handle.length === 8 ? handle.readBigUInt64LE() : BigInt(handle.readUInt32LE())).toString() };
      }, { x: bounds.x + Math.min(100, bounds.width / 2), y: bounds.y + bounds.height / 2 });
      assert.equal(String(ancestor(windowAt(origin), 2)), origin.handle, 'mouse down is confined to the owned quick window');
      const target = await state(value => value.drops.length === results.length);
      assert.equal(String(ancestor(windowAt(target), 2)), ready.handle, 'drop point belongs to the owned receiver: ' + JSON.stringify({ desktop, layout, origin, target }));
      mouse(origin); await pause(100); mouse(origin, 2); mouseDown = true;
      try {
        for (let step = 1; step <= 25; step++) {
          mouse({ x: Math.round(origin.x + (target.x - origin.x) * step / 25), y: Math.round(origin.y + (target.y - origin.y) * step / 25) });
          await pause(35);
        }
        await pause(200); mouse(target, 4); mouseDown = false;
      } finally { if (mouseDown) { mouse(lastPoint, 4); mouseDown = false; } }
      const receipt = (await state(value => value.drops.length === results.length + 1)).drops.at(-1);
      assert.equal(receipt.effect, 'Copy');
      if (kind === 'image') {
        assert.equal(receipt.files.length, 1);
        assert.equal(createHash('sha256').update(await readFile(receipt.files[0])).digest('hex'), imageHash, 'the received image matches the complete stored PNG');
      } else {
        assert.deepEqual(receipt.files.map(value => value.toLowerCase()).sort(), [file, folder].map(value => value.toLowerCase()).sort());
        assert.equal(await readFile(file, 'utf8'), 'native file drop 中文😀');
        assert.equal(await readFile(join(folder, 'child.txt'), 'utf8'), 'folder child 中文');
      }
      results.push({ kind, filesReceived: receipt.files.length, effect: receipt.effect });
    }
    return { distinctWindowsProcess: true, source: 'production quick-window row drag', receiver: 'Windows Forms OLE FileDrop', systemClipboardWritten: false, unicodeAndSpacePaths: true, scaleFactor: layout.scaleFactor, drops: results };
  } finally {
    const cleanupErrors = [];
    try { if (mouseDown) mouse(lastPoint, 4); } catch (error) { cleanupErrors.push(error); }
    try {
      const current = Buffer.alloc(8);
      if (lastPoint && cursor(current) && Math.abs(current.readInt32LE() - lastPoint.x) <= 3 && Math.abs(current.readInt32LE(4) - lastPoint.y) <= 3) mouse({ x: original.readInt32LE(), y: original.readInt32LE(4) });
    } catch (error) { cleanupErrors.push(error); }
    try {
      if (child && child.exitCode === null && child.signalCode === null) {
        const exited = new Promise(resolve => child.once('exit', resolve)); child.kill(); await exited;
      }
    } finally { setDpiContext(previousDpiContext); }
    if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'Owned native drag input cleanup failed');
  }
}
