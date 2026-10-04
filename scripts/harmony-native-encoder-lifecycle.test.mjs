import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test, { after } from 'node:test';

const run = promisify(execFile);
const header = await readFile(new URL('../third_party/harmony-mirror/entry/src/main/cpp/ScreenCaptureEncoder.h', import.meta.url), 'utf8');
const source = await readFile(new URL('../third_party/harmony-mirror/entry/src/main/cpp/ScreenCaptureEncoder.cpp', import.meta.url), 'utf8');
const tcpHeader = await readFile(new URL('../third_party/harmony-mirror/entry/src/main/cpp/TcpServer.h', import.meta.url), 'utf8');
const tcpSource = await readFile(new URL('../third_party/harmony-mirror/entry/src/main/cpp/TcpServer.cpp', import.meta.url), 'utf8');
const bridgeSource = await readFile(new URL('../third_party/harmony-mirror/entry/src/main/cpp/CaptureSurfaceBridge.cpp', import.meta.url), 'utf8');
const bridgeCmake = await readFile(new URL('../third_party/harmony-mirror/entry/src/main/cpp/CMakeLists.txt', import.meta.url), 'utf8');
const napiSource = await readFile(new URL('../third_party/harmony-mirror/entry/src/main/cpp/napi_init.cpp', import.meta.url), 'utf8');
const entryAbilitySource = await readFile(new URL('../third_party/harmony-mirror/entry/src/main/ets/entryability/EntryAbility.ets', import.meta.url), 'utf8');
const helpers = header.split('// BEGIN_OFFLINE_H264_HELPERS')[1]?.split('// END_OFFLINE_H264_HELPERS')[0];
const queueHelpers = tcpHeader.split('// BEGIN_OFFLINE_VIDEO_QUEUE_HELPERS')[1]?.split('// END_OFFLINE_VIDEO_QUEUE_HELPERS')[0];
assert.ok(helpers, 'tests must execute the production C++ helpers');
assert.ok(queueHelpers, 'tests must execute the production queue policy');
const toolchain = process.env.PIORA_NATIVE_LLVM_BIN || 'G:/softwore/DevEco Studio/sdk/default/openharmony/native/llvm/bin';
const isWindows = process.platform === 'win32';
// Linux CI uses its real system C++17 compiler. CXX is an executable name/path,
// not a shell command; an explicit override fails visibly if it is invalid.
const systemCompiler = process.env.PIORA_NATIVE_CXX || process.env.CXX || 'c++';
const nativeAvailable = isWindows
  ? await Promise.all([access(join(toolchain, 'clang++.exe')), access(join(toolchain, 'lld-link.exe'))]).then(() => true, () => false)
  : await run(systemCompiler, ['--version'], { windowsHide: true }).then(() => true, error => {
    if (error.code !== 'ENOENT') throw error;
    return false;
  });
const requireNative = process.env.PIORA_REQUIRE_NATIVE_TESTS === '1' ||
  (!isWindows && (process.env.CI === 'true' || process.env.CI === '1'));
assert.ok(nativeAvailable || !requireNative,
  'Native behavior tests require a real C++17 compiler. Set PIORA_NATIVE_CXX/CXX on Linux or PIORA_NATIVE_LLVM_BIN on Windows; missing compiler is not a CI pass.');
const native = await mkdtemp(join(tmpdir(), 'piora-native-encoder-'));
let nativeRunner;
try { if (nativeAvailable) {
  const portableHarness = await readFile(new URL('./helpers/harmony-native-test-harness.cpp', import.meta.url), 'utf8');
  const nativeSource = `
typedef unsigned char uint8_t;
typedef unsigned int uint32_t;
typedef unsigned long long uint64_t;
typedef long long int64_t;
typedef int int32_t;
typedef unsigned long long size_t;
${helpers}
${queueHelpers}
static uint8_t fixture[131072];
static H264StreamGate gate;
static TransportTimestampClock timestampClock;
// The queue template uses only this small container interface; production
// instantiates it with std::deque<shared_ptr<const vector<uint8_t>>>. Fixtures
// carry real packet headers with synthetic lengths to avoid allocating MiBs.
struct TestPacket {
  uint8_t bytes[18]{};
  size_t length = 18;
  size_t size() const { return length; }
  uint8_t operator[](size_t index) const { return bytes[index]; }
};
struct TestQueue {
  // Deliberately larger than the production cap: this fixture must not make
  // an overflowing enqueue appear safe by silently saturating first.
  TestPacket *items[256]{};
  unsigned int count = 0;
  TestPacket **begin() { return items; }
  TestPacket **end() { return items + count; }
  TestPacket *const *begin() const { return items; }
  TestPacket *const *end() const { return items + count; }
  bool empty() const { return count == 0; }
  TestPacket *back() const { return items[count - 1]; }
  void push_back(TestPacket *packet) { if (count < 256) items[count++] = packet; }
  void swap(TestQueue &other) {
    for (unsigned int i = 0; i < 256; ++i) { auto *tmp = items[i]; items[i] = other.items[i]; other.items[i] = tmp; }
    auto tmp = count; count = other.count; other.count = tmp;
  }
};
struct TestClient {
  TestQueue queue;
  size_t offset = 0;
  bool awaiting = true;
  TestPacket *config = nullptr;
};
static TestPacket packets[128];
static TestClient clients[2];
extern "C" {
__declspec(dllexport) void load_fixture(const uint8_t *bytes, unsigned int size, unsigned int offset) {
  if (offset > sizeof(fixture) || size > sizeof(fixture) - offset) return;
  for (unsigned int i = 0; i < size; ++i) fixture[offset + i] = bytes[i];
}
__declspec(dllexport)
int geometry(unsigned int size) {
  int32_t width = 0, height = 0;
  return ReadH264SpsGeometry(fixture, size, width, height) ? width * 65536 + height : -1;
}
__declspec(dllexport) int parameter_sets(unsigned int spsSize, unsigned int ppsSize) {
  uint32_t id = 0;
  return ReadH264ParameterSetId(fixture, spsSize, fixture + 65536, ppsSize, id) ? static_cast<int>(id) : -1;
}
__declspec(dllexport) int idr_matches(unsigned int size, unsigned int id) { return H264IdrReferencesPps(fixture, size, id); }
__declspec(dllexport) void reset_gate() { gate.Reset(); }
__declspec(dllexport) int gate_accepts(int key, int ready) { return gate.CanEmitFrame(key, ready); }
__declspec(dllexport) int gate_needs_config() { return gate.NeedsConfiguration(); }
__declspec(dllexport) void emitted_config() { gate.ConfigurationEmitted(); }
__declspec(dllexport) void timestamp_reset() { timestampClock.Reset(); }
__declspec(dllexport) void timestamp_generation() { timestampClock.BeginGeneration(); }
__declspec(dllexport) int timestamp_normalize(int observedUs, int fps) {
  return static_cast<int>(timestampClock.Normalize(observedUs, fps));
}
__declspec(dllexport) int queue_reset(unsigned int client) {
  if (client > 1) return -1;
  clients[client].queue.count = 0; clients[client].offset = 0;
  clients[client].awaiting = true; clients[client].config = nullptr; return 0;
}
__declspec(dllexport) int queue_enqueue(unsigned int client, unsigned int id, unsigned int type, unsigned int length, unsigned int key) {
  if (client > 1 || id >= 128 || length < 8) return -1;
  auto &packet = packets[id]; packet.length = length;
  for (unsigned int i = 0; i < 4; ++i) { packet.bytes[i] = (type >> (24 - i * 8)) & 255; packet.bytes[4 + i] = ((length - 8) >> (24 - i * 8)) & 255; }
  packet.bytes[8] = key ? 1 : 0;
  auto &c = clients[client];
  return EnqueueVideoPacket(c.queue, c.offset, c.awaiting, c.config, &packet);
}
__declspec(dllexport) int queue_partial(unsigned int client, unsigned int offset) {
  if (client > 1 || clients[client].queue.empty() || offset >= clients[client].queue.items[0]->size()) return -1;
  clients[client].offset = offset; return 0;
}
__declspec(dllexport) int queue_drain_front(unsigned int client) {
  if (client > 1 || clients[client].queue.empty()) return -1;
  auto &c = clients[client];
  for (unsigned int i = 1; i < c.queue.count; ++i) c.queue.items[i - 1] = c.queue.items[i];
  --c.queue.count; c.offset = 0; return 0;
}
__declspec(dllexport) int queue_count(unsigned int client) { return client < 2 ? clients[client].queue.count : -1; }
__declspec(dllexport) int queue_id(unsigned int client, unsigned int index) {
  return client < 2 && index < clients[client].queue.count ? static_cast<int>(clients[client].queue.items[index] - packets) : -1;
}
__declspec(dllexport) int queue_offset(unsigned int client) { return client < 2 ? clients[client].offset : -1; }
__declspec(dllexport) int queue_awaiting(unsigned int client) { return client < 2 ? clients[client].awaiting : -1; }
}
`;
  await writeFile(join(native, 'helpers.cpp'), (isWindows ? nativeSource : nativeSource.replaceAll('__declspec(dllexport)', '')) + portableHarness);
  if (isWindows) {
  await run(join(toolchain, 'clang++.exe'), ['--target=x86_64-pc-windows-msvc', '-std=c++17', '-Oz', '-fno-exceptions', '-fno-rtti', '-fno-builtin', '-nostdlib', '-c', join(native, 'helpers.cpp'), '-o', join(native, 'helpers.obj')], { windowsHide: true });
  const dll = join(native, 'helpers.dll');
  await run(join(toolchain, 'lld-link.exe'), ['/dll', '/noentry', '/nodefaultlib', '/machine:x64', `/out:${dll}`, join(native, 'helpers.obj')], { windowsHide: true });
  const dllLiteral = dll.replaceAll('\\', '\\\\');
  nativeRunner = join(native, 'run.ps1');
  await writeFile(nativeRunner, `
Add-Type -TypeDefinition @'
using System.Runtime.InteropServices;
public static class NativeHelpers {
  [DllImport("${dllLiteral}")] public static extern void load_fixture(byte[] bytes, uint size, uint offset);
  [DllImport("${dllLiteral}")] public static extern int geometry(uint size);
  [DllImport("${dllLiteral}")] public static extern int parameter_sets(uint spsSize, uint ppsSize);
  [DllImport("${dllLiteral}")] public static extern int idr_matches(uint size, uint id);
  [DllImport("${dllLiteral}")] public static extern void reset_gate();
  [DllImport("${dllLiteral}")] public static extern int gate_accepts(int key, int ready);
  [DllImport("${dllLiteral}")] public static extern int gate_needs_config();
  [DllImport("${dllLiteral}")] public static extern void emitted_config();
  [DllImport("${dllLiteral}")] public static extern void timestamp_reset();
  [DllImport("${dllLiteral}")] public static extern void timestamp_generation();
  [DllImport("${dllLiteral}")] public static extern int timestamp_normalize(int observedUs, int fps);
  [DllImport("${dllLiteral}")] public static extern int queue_reset(uint client);
  [DllImport("${dllLiteral}")] public static extern int queue_enqueue(uint client, uint id, uint type, uint length, uint key);
  [DllImport("${dllLiteral}")] public static extern int queue_partial(uint client, uint offset);
  [DllImport("${dllLiteral}")] public static extern int queue_drain_front(uint client);
  [DllImport("${dllLiteral}")] public static extern int queue_count(uint client);
  [DllImport("${dllLiteral}")] public static extern int queue_id(uint client, uint index);
  [DllImport("${dllLiteral}")] public static extern int queue_offset(uint client);
  [DllImport("${dllLiteral}")] public static extern int queue_awaiting(uint client);
}
'@
$cases = [Console]::In.ReadToEnd() | ConvertFrom-Json
$results = @()
foreach ($case in $cases) {
  if ($null -ne $case.bytes) { [byte[]]$bytes = $case.bytes; [NativeHelpers]::load_fixture($bytes, $bytes.Length, 0) }
  if ($null -ne $case.pps) { [byte[]]$pps = $case.pps; [NativeHelpers]::load_fixture($pps, $pps.Length, 65536) }
  switch ($case.op) {
    geometry { $results += [NativeHelpers]::geometry($case.size) }
    parameters { $results += [NativeHelpers]::parameter_sets($case.size, $case.pps.Count) }
    idr { $results += [NativeHelpers]::idr_matches($case.size, $case.id) }
    reset { [NativeHelpers]::reset_gate(); $results += 0 }
    accepts { $results += [NativeHelpers]::gate_accepts($case.key, $case.ready) }
    needs { $results += [NativeHelpers]::gate_needs_config() }
    emitted { [NativeHelpers]::emitted_config(); $results += 0 }
    timestamp_reset { [NativeHelpers]::timestamp_reset(); $results += 0 }
    timestamp_generation { [NativeHelpers]::timestamp_generation(); $results += 0 }
    timestamp_normalize { $results += [NativeHelpers]::timestamp_normalize($case.observed, $case.fps) }
    queue_reset { $results += [NativeHelpers]::queue_reset($case.client) }
    queue_enqueue { $results += [NativeHelpers]::queue_enqueue($case.client, $case.id, $case.type, $case.length, $case.key) }
    queue_partial { $results += [NativeHelpers]::queue_partial($case.client, $case.offset) }
    queue_drain { $results += [NativeHelpers]::queue_drain_front($case.client) }
    queue_count { $results += [NativeHelpers]::queue_count($case.client) }
    queue_id { $results += [NativeHelpers]::queue_id($case.client, $case.index) }
    queue_offset { $results += [NativeHelpers]::queue_offset($case.client) }
    queue_awaiting { $results += [NativeHelpers]::queue_awaiting($case.client) }
    default { throw "Unknown native test operation" }
  }
}
ConvertTo-Json -InputObject $results -Compress
`);
    // Optional local frontend check for the portable Linux harness. This is
    // syntax validation only and must not be reported as Linux execution.
    if (process.env.PIORA_NATIVE_VERIFY_PORTABLE_SYNTAX === '1') {
      const portableSource = join(native, 'helpers-posix.cpp');
      await writeFile(portableSource, nativeSource.replaceAll('__declspec(dllexport)', '') + portableHarness);
      await run(join(toolchain, 'clang++.exe'), ['--target=x86_64-linux-gnu', '-std=c++17', '-fsyntax-only', portableSource], { windowsHide: true });
    }
  } else {
    nativeRunner = join(native, 'helpers');
    await run(systemCompiler, ['-std=c++17', '-O2', '-fno-exceptions', '-fno-rtti', join(native, 'helpers.cpp'), '-o', nativeRunner], { windowsHide: true });
  }
}
} catch (error) {
  await rm(native, { recursive: true, force: true });
  throw error;
}
after(async () => { await rm(native, { recursive: true, force: true }); });
function nativeTest(name, callback) {
  test(name, { skip: nativeAvailable ? false : 'Production C++ execution needs a real compiler: PIORA_NATIVE_LLVM_BIN (Windows), PIORA_NATIVE_CXX/CXX (Linux). PIORA_REQUIRE_NATIVE_TESTS=1 makes absence fail.' }, callback);
}

const nativeOperations = ['geometry', 'parameters', 'idr', 'reset', 'accepts', 'needs', 'emitted',
  'queue_reset', 'queue_enqueue', 'queue_partial', 'queue_drain', 'queue_count', 'queue_id', 'queue_offset', 'queue_awaiting',
  'timestamp_reset', 'timestamp_generation', 'timestamp_normalize'];
function encodeNativeCases(cases) {
  assert.ok(cases.length <= 4096);
  const count = Buffer.alloc(4); count.writeUInt32LE(cases.length);
  const packets = cases.map(value => {
    const bytes = Buffer.from(value.bytes || []), pps = Buffer.from(value.pps || []);
    const operation = nativeOperations.indexOf(value.op);
    assert.ok(operation >= 0 && bytes.length <= 65536 && pps.length <= 65535);
    const fields = [operation, value.size || value.observed || 0, value.id || value.fps || 0, value.client || 0, value.type || 0,
      value.length || 0, value.key || 0, value.ready || 0, value.offset || 0, value.index || 0, bytes.length, pps.length];
    const header = Buffer.alloc(fields.length * 4);
    fields.forEach((field, index) => { assert.ok(Number.isInteger(field) && field >= 0 && field <= 0xffffffff); header.writeUInt32LE(field, index * 4); });
    return Buffer.concat([header, bytes, pps]);
  });
  return Buffer.concat([count, ...packets]);
}

async function evaluate(cases) {
  const child = isWindows
    ? spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', nativeRunner], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    : spawn(nativeRunner, [], { stdio: ['pipe', 'pipe', 'pipe'] });
  const stdout = []; let stderr = '';
  child.stdout.on('data', chunk => { stdout.push(chunk); });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const input = isWindows ? JSON.stringify(cases) : encodeNativeCases(cases);
  child.stdin.on('error', () => {}); // The exit/error below reports a closed harness.
  child.stdin.end(input);
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => code === 0 && !stderr ? resolve() : reject(new Error(`Native helper test failed (${code}): ${stderr}`)));
  });
  const output = Buffer.concat(stdout);
  if (isWindows) return JSON.parse(output.toString('utf8'));
  assert.equal(output.length, cases.length * 4, 'the compiled native executable must return one result per case');
  return Array.from({ length: cases.length }, (_, index) => output.readInt32LE(index * 4));
}

class Bits {
  values = [];
  bit(value) { this.values.push(value ? 1 : 0); return this; }
  uint(value, count) { for (let i = count - 1; i >= 0; i--) this.bit((value >>> i) & 1); return this; }
  ue(value) { const encoded = value + 1, count = Math.floor(Math.log2(encoded)); for (let i = 0; i < count; i++) this.bit(0); return this.uint(encoded, count + 1); }
  se(value) { return this.ue(value <= 0 ? -value * 2 : value * 2 - 1); }
  nal(type) {
    this.bit(1);
    while (this.values.length % 8) this.bit(0);
    const output = [type]; let zeros = 0;
    for (let i = 0; i < this.values.length; i += 8) {
      const byte = this.values.slice(i, i + 8).reduce((result, bit) => result * 2 + bit, 0);
      if (zeros >= 2 && byte <= 3) { output.push(3); zeros = 0; }
      output.push(byte); zeros = byte === 0 ? zeros + 1 : 0;
    }
    return Uint8Array.from(output);
  }
}

function sps({ width = 1080, height = 2386, profile = 77, chroma = 1, separate = false, frameOnly = true,
  id = 0, order = 0, scaling = false, crop, cycle = 0 } = {}) {
  const bits = new Bits().uint(profile, 8).uint(0, 8).uint(40, 8).ue(id);
  if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(profile)) {
    bits.ue(chroma); if (chroma === 3) bits.bit(separate);
    bits.ue(0).ue(0).bit(0).bit(scaling);
    if (scaling) for (let i = 0; i < (chroma === 3 ? 12 : 8); i++) {
      bits.bit(1); for (let j = 0; j < (i < 6 ? 16 : 64); j++) bits.se(0);
    }
  }
  bits.ue(0).ue(order);
  if (order === 0) bits.ue(0);
  if (order === 1) { bits.bit(0).se(-2).se(1).ue(cycle); for (let i = 0; i < cycle; i++) bits.se(i % 2 ? -1 : 1); }
  const codedWidth = Math.ceil(width / 16) * 16;
  const verticalUnit = frameOnly ? 16 : 32;
  const codedHeight = Math.ceil(height / verticalUnit) * verticalUnit;
  bits.ue(2).bit(0).ue(codedWidth / 16 - 1).ue(codedHeight / verticalUnit - 1).bit(frameOnly);
  if (!frameOnly) bits.bit(0);
  bits.bit(1);
  const array = separate ? 0 : chroma;
  const cropX = array === 1 || array === 2 ? 2 : 1;
  const cropY = (array === 1 ? 2 : 1) * (frameOnly ? 1 : 2);
  const trim = crop || [0, (codedWidth - width) / cropX, 0, (codedHeight - height) / cropY];
  bits.bit(trim.some(Boolean)); if (trim.some(Boolean)) for (const value of trim) bits.ue(value);
  return bits.bit(0).nal(0x67);
}

function geometryCase(bytes, size = bytes.length) { return { op: 'geometry', bytes: Array.from(bytes), size }; }
function geometryResult(value) { return value === -1 ? null : { width: value >>> 16, height: value & 65535 }; }

nativeTest('the native IDR gate rejects dependent frames and incomplete new parameter sets on every reset', async () => {
  const cases = [{ op: 'reset' }, { op: 'needs' }, { op: 'accepts', key: 0, ready: 1 },
    { op: 'accepts', key: 1, ready: 0 }, { op: 'accepts', key: 1, ready: 1 }, { op: 'needs' },
    { op: 'emitted' }, { op: 'accepts', key: 0, ready: 1 }, { op: 'reset' }, { op: 'accepts', key: 0, ready: 1 }];
  assert.deepEqual(await evaluate(cases), [0, 1, 0, 0, 1, 1, 0, 1, 0, 0]);
});

nativeTest('transport timestamps advance through repeated source PTS and remain monotonic across encoder generations', async () => {
  const cases = [
    { op: 'timestamp_reset' },
    { op: 'timestamp_normalize', observed: 1_000_000, fps: 30 },
    { op: 'timestamp_normalize', observed: 1_000_000, fps: 30 },
    { op: 'timestamp_normalize', observed: 1_033_333, fps: 30 },
    { op: 'timestamp_generation' },
    { op: 'timestamp_normalize', observed: 2_000_000, fps: 30 },
    { op: 'timestamp_normalize', observed: 2_100_000, fps: 30 },
  ];
  assert.deepEqual(await evaluate(cases), [0, 0, 33_333, 66_666, 0, 66_667, 166_667]);
});

nativeTest('production SPS parsing reads real portrait, landscape and square coded dimensions with crop', async () => {
  const cases = [], expected = [];
  for (const profile of [66, 77, 88, 100]) for (const [width, height] of [[1080, 2386], [2386, 1080], [2386, 2386], [720, 1592]]) {
    cases.push(geometryCase(sps({ width, height, profile }))); expected.push({ width, height });
  }
  assert.deepEqual((await evaluate(cases)).map(geometryResult), expected);
});

nativeTest('production SPS parsing handles chroma, separate colour planes, interlacing, scaling lists and POC cycles', async () => {
  const cases = [];
  for (const chroma of [0, 1, 2, 3]) for (const frameOnly of [true, false]) {
    cases.push(geometryCase(sps({ profile: 100, chroma, frameOnly, width: 640, height: 480, order: 1, cycle: 3 })));
  }
  cases.push(geometryCase(sps({ profile: 244, chroma: 3, separate: true, width: 639, height: 479, scaling: true, order: 2 })));
  assert.deepEqual((await evaluate(cases)).map(geometryResult), [...Array(8).fill({ width: 640, height: 480 }), { width: 639, height: 479 }]);
});

nativeTest('production SPS parser rejects truncation, excessive Exp-Golomb, lengths, crop and unsupported syntax', async () => {
  const valid = sps();
  const cases = [];
  for (let size = 0; size < valid.length - 2; size++) cases.push(geometryCase(valid.subarray(0, size)));
  cases.push(geometryCase(valid, 65536), geometryCase(Uint8Array.from([0x67, 77, 0, 40, ...Array(12).fill(0)])),
    geometryCase(Uint8Array.from([0x65, ...valid.subarray(1)])), geometryCase(Uint8Array.from([0xe7, ...valid.subarray(1)])));
  for (const settings of [{ profile: 1 }, { profile: 100, chroma: 4 }, { id: 32 }, { width: 8208 }, { order: 3 }, { order: 1, cycle: 256 }, { crop: [1000000, 0, 0, 0] }]) {
    cases.push(geometryCase(sps(settings)));
  }
  assert.deepEqual(await evaluate(cases), Array(cases.length).fill(-1));
});

nativeTest('PPS must reference the current SPS and the initial actual IDR must reference that PPS', async () => {
  const current = sps({ id: 3 });
  const idr = new Bits().ue(0).ue(2).ue(7).nal(0x65);
  const delta = new Bits().ue(0).ue(2).ue(7).nal(0x61);
  assert.deepEqual(await evaluate([
    { op: 'parameters', bytes: Array.from(current), size: current.length, pps: Array.from(new Bits().ue(7).ue(3).nal(0x68)) },
    { op: 'parameters', bytes: Array.from(current), size: current.length, pps: Array.from(new Bits().ue(7).ue(2).nal(0x68)) },
    { op: 'idr', bytes: Array.from(idr), size: idr.length, id: 7 },
    { op: 'idr', bytes: Array.from(idr), size: idr.length, id: 6 },
    { op: 'idr', bytes: Array.from(delta), size: delta.length, id: 7 }
  ]), [7, -1, 1, 0, 0]);
});

const packet = (id, type, length = 32, key = 0, client = 0) => ({ op: 'queue_enqueue', client, id, type, length, key });
const queue = (op, extra = {}, client = 0) => ({ op: `queue_${op}`, client, ...extra });
function inspectQueue(count, client = 0) {
  return [queue('count', {}, client), ...Array.from({ length: count }, (_, index) => queue('id', { index }, client)),
    queue('offset', {}, client), queue('awaiting', {}, client)];
}

nativeTest('production queue gates every new config until its first IDR while preserving ordinary frame order', async () => {
  const result = await evaluate([queue('reset'), packet(1, 2), packet(2, 3), packet(3, 3, 32, 1),
    queue('drain'), packet(4, 3), ...inspectQueue(2)]);
  assert.deepEqual(result.slice(-5), [2, 3, 4, 0, 0]);
});

nativeTest('production backpressure preserves an in-progress old frame and restores new config before new IDR', async () => {
  const result = await evaluate([queue('reset'), packet(1, 2), packet(2, 3, 1572864, 1), queue('drain'),
    queue('partial', { offset: 11 }), packet(3, 3, 1572864), packet(4, 2), packet(5, 3, 2097152, 1), ...inspectQueue(3)]);
  assert.equal(result[7], 1, 'incoming new IDR actually exercises congestion');
  assert.deepEqual(result.slice(-6), [3, 2, 4, 5, 11, 0]);
});

nativeTest('production backpressure keeps a partial old config intact and coalesces unstarted configs to the newest', async () => {
  const result = await evaluate([queue('reset'), packet(1, 2), queue('partial', { offset: 6 }),
    packet(2, 3, 3670016, 1), packet(3, 2), packet(4, 2), packet(5, 3, 2097152, 1), ...inspectQueue(3)]);
  assert.equal(result[6], 1);
  assert.deepEqual(result.slice(-6), [3, 1, 4, 5, 6, 0]);
});

nativeTest('production congestion drops unstarted old video packets but preserves heartbeat/status order', async () => {
  const result = await evaluate([queue('reset'), packet(1, 2), packet(2, 3, 3670016, 1), packet(3, 1),
    packet(4, 0x20), packet(5, 2), packet(6, 3, 2097152, 1), ...inspectQueue(4)]);
  assert.equal(result[6], 1);
  assert.deepEqual(result.slice(-7), [4, 3, 4, 5, 6, 0, 0]);
});

nativeTest('production congestion can restore an already-delivered config and gate delta without disturbing another client', async () => {
  const result = await evaluate([queue('reset'), queue('reset', {}, 1), packet(10, 2, 32, 0, 1), packet(11, 3, 32, 1, 1), packet(12, 3, 32, 0, 1),
    packet(1, 2), packet(2, 3, 3670016, 1), queue('drain'), queue('partial', { offset: 9 }),
    packet(3, 3, 2097152), packet(4, 3), ...inspectQueue(2), ...inspectQueue(3, 1)]);
  assert.equal(result[9], 1);
  assert.deepEqual(result.slice(-11), [2, 2, 1, 9, 1, 3, 10, 11, 12, 0, 0]);
});

nativeTest('production queue makes progress for a single oversized IDR and never splits its partial bytes', async () => {
  const result = await evaluate([queue('reset'), packet(1, 2), packet(2, 3, 6291456, 1), queue('drain'),
    queue('partial', { offset: 4096 }), packet(3, 3), ...inspectQueue(2)]);
  assert.equal(result[2], 1);
  assert.equal(result[5], 1);
  assert.deepEqual(result.slice(-5), [2, 2, 1, 4096, 1]);
});

nativeTest('production hard packet cap rejects the next acknowledgement without dropping the partial front', async () => {
  const result = await evaluate([queue('reset'), packet(1, 1, 40), queue('partial', { offset: 11 }),
    ...Array.from({ length: 127 }, () => packet(2, 0x20, 32)), packet(3, 1, 40),
    queue('count'), queue('id', { index: 0 }), queue('id', { index: 127 }), queue('offset')]);
  assert.deepEqual(result.slice(-5), [2, 128, 1, 2, 11]);
  assert.ok(result.slice(3, 130).every(value => value === 0), 'all acknowledgements before the cap remain queued');
});

nativeTest('production hard byte cap counts the full partial allocation and rejects recovery plus an oversized IDR', async () => {
  const result = await evaluate([queue('reset'), packet(1, 2), packet(2, 3, 16 * 1024 * 1024, 1), queue('drain'),
    queue('partial', { offset: 15 * 1024 * 1024 }), packet(3, 0x20, 2 * 1024 * 1024), packet(4, 2),
    packet(5, 3, 16 * 1024 * 1024, 1), ...inspectQueue(3)]);
  assert.equal(result[7], 2, 'hard cap includes both restored config and incoming IDR');
  assert.deepEqual(result.slice(-6), [3, 2, 3, 4, 15 * 1024 * 1024, 1]);
});

nativeTest('production hard byte cap preserves statuses and rejects a single packet beyond the limit', async () => {
  const result = await evaluate([queue('reset'), packet(1, 0x20, 24 * 1024 * 1024), queue('partial', { offset: 7 }),
    packet(2, 1, 40), ...inspectQueue(1), queue('reset'), packet(3, 2, 24 * 1024 * 1024 + 1), ...inspectQueue(0)]);
  assert.deepEqual(result.slice(3, 8), [2, 1, 1, 7, 1]);
  assert.deepEqual(result.slice(-4), [2, 0, 0, 1]);
});

test('TcpServer uses the production queue policy and initializes cached config for late subscribers', () => {
  assert.ok(tcpSource.includes('EnqueueVideoPacket(c.txQueue, c.txOffset, c.awaitingKeyframe, c.latestConfig, frame)'));
  assert.ok(tcpSource.includes('st.latestConfig = lastConfig_'));
  assert.ok(tcpSource.includes('EnqueueFor(st, lastConfig_)'), 'late subscribers must use the same hard queue cap');
  const enqueueStart = tcpSource.indexOf('void TcpServer::EnqueueFor(');
  const enqueueEnd = tcpSource.indexOf('void TcpServer::UpdateInterest(', enqueueStart);
  const enqueue = tcpSource.slice(enqueueStart, enqueueEnd);
  assert.ok(enqueue.includes('if (c.closing) return;'));
  assert.match(enqueue, /if \(result == kVideoQueueClose\)\s*\{[\s\S]*?c\.closing = true;[\s\S]*?shutdown\(c\.fd, SHUT_RDWR\);[\s\S]*?return;/);
  assert.ok(!tcpSource.includes('c.txQueue.clear()'), 'transport mutations must not drop a partial packet or fresh config');
});

function sourceSegment(text, begin, end) { const start = text.indexOf(begin); assert.ok(start >= 0, begin); const stop = text.indexOf(end, start + begin.length); assert.ok(stop > start, end); return text.slice(start, stop); }
function segment(begin, end) { return sourceSegment(source, begin, end); }
test('native callback fences retain immutable context until codec destruction and free through callback codec', () => {
  const identity = segment('bool CaptureSession::IsCurrentEncoder(', 'void CaptureSession::OnEncOutput(');
  for (const guard of ['encoder_ == codec', 'context->codec == codec', 'encoder_context_.get() == context', 'epoch_.load() == context->epoch', 'encoder_generation_.load() == context->generation', '!stopping_.load()']) assert.ok(identity.includes(guard), guard);
  const output = segment('void CaptureSession::OnEncOutput(', 'void CaptureSession::OnEncInput(');
  assert.ok(output.indexOf('IsCurrentEncoder(codec, context)') < output.indexOf('HandleEncodedOutput(codec, index, buffer)'));
  const changed = segment('void CaptureSession::OnEncStreamChanged(', 'void CaptureSession::OnEncError(');
  for (const guard of ['IsCurrentEncoder(codec, context)', 'sps_.clear()', 'pps_.clear()', 'h264_gate_.Reset()']) assert.ok(changed.includes(guard), guard);
  const frames = segment('void CaptureSession::HandleEncodedOutput(', 'bool CaptureSession::ParseSpsPps(');
  assert.ok(frames.includes('OH_VideoEncoder_FreeOutputBuffer(codec, index)'));
  assert.ok(!frames.includes('OH_VideoEncoder_FreeOutputBuffer(encoder_'));
  assert.ok(frames.indexOf('HasMatchingIdr(data, size, ppsId)') < frames.indexOf('SendH264Config(spsCopy, ppsCopy)'));
  assert.ok(frames.indexOf('SendH264Config(spsCopy, ppsCopy)') < frames.indexOf('SendVideoFrame(isKey, normalized'));
});

test('native cleanup releases capture and its bridge producer before the encoder destination', () => {
  const cleanup = segment('void CaptureSession::StopResourcesWithLifecycleLock()', '// ----- H264 callbacks -----');
  const stopCapture = cleanup.indexOf('OH_AVScreenCapture_StopScreenCapture(c)');
  const releaseCapture = cleanup.indexOf('OH_AVScreenCapture_Release(c)');
  const stopBridge = cleanup.indexOf('surface_bridge_.Stop()');
  const barrier = cleanup.match(/\{\s*std::lock_guard<std::mutex> cg\(callback_mu_\);\s*\}/);
  assert.ok(barrier, 'callback barrier must release its mutex before SDK calls');
  const flushEncoder = cleanup.indexOf('OH_VideoEncoder_Flush(enc)');
  const stopEncoder = cleanup.indexOf('OH_VideoEncoder_Stop(enc)');
  assert.ok(stopCapture >= 0 && releaseCapture > stopCapture && stopBridge > releaseCapture,
    'ScreenCapture must release its borrowed bridge producer before NativeImage teardown');
  assert.ok(barrier.index > stopBridge && flushEncoder > barrier.index + barrier[0].length && stopEncoder > flushEncoder,
    'existing output buffers must finish before Flush invalidates them');
  const destroyWindow = cleanup.indexOf('OH_NativeWindow_DestroyNativeWindow(window)');
  const destroyCodec = cleanup.indexOf('OH_VideoEncoder_Destroy(enc)');
  assert.ok(destroyWindow > stopEncoder && destroyCodec > destroyWindow,
    'the joined bridge must detach its EGL surface before the encoder window is destroyed');
  assert.ok(cleanup.indexOf('encoderContext.reset()') > destroyCodec);
  assert.ok(cleanup.includes('if (hadCapture || enc != nullptr || window != nullptr) TcpServer::Instance().ClearVideoConfig()'));

  const bridgeCleanup = sourceSegment(bridgeSource, 'void Cleanup()', 'void Run(');
  assert.ok(bridgeCleanup.includes('OH_NativeImage_Destroy(&nativeImage)'));
  assert.ok(!bridgeSource.includes('OH_NativeWindow_DestroyNativeWindow'),
    'OH_NativeImage_Destroy owns the acquired capture window; a separate destroy double-releases it');
  const start = segment('bool CaptureSession::Start(', 'bool CaptureSession::TryStartH264()');
  assert.ok(start.indexOf('g.unlock()') < start.indexOf('TryStartH264()'), 'device APIs must not deadlock stream callbacks on mu_');
});

test('H264 capture binds ScreenCapture to the stable NativeImage bridge producer', () => {
  assert.match(bridgeSource, /#include <GLES2\/gl2\.h>/);
  assert.match(bridgeSource, /EGL_OPENGL_ES2_BIT/);
  assert.match(bridgeSource, /EGL_CONTEXT_CLIENT_VERSION, 2/);
  assert.match(bridgeSource, /GL_OES_EGL_image_external/);
  assert.match(bridgeCmake, /libGLESv3\.so/);
  assert.match(bridgeSource, /eglGetCurrentContext\(\) != context/);
  assert.match(bridgeSource, /glVersion == nullptr/);
  const start = segment('bool CaptureSession::TryStartH264()', 'bool CaptureSession::StartSurfaceBridgeLocked()');
  assert.ok(start.indexOf('StartH264EncoderLocked()') < start.indexOf('StartSurfaceBridgeLocked()'));
  assert.ok(start.indexOf('StartSurfaceBridgeLocked()') < start.indexOf('StartH264ScreenCaptureLocked()'));

  const capture = segment('bool CaptureSession::StartH264CaptureWithSurfaceLocked()', 'void CaptureSession::ApplyCaptureMaxFrameRateLocked()');
  const acquireProducer = capture.indexOf('surface_bridge_.CaptureWindow()');
  const bindProducer = capture.indexOf('OH_AVScreenCapture_StartScreenCaptureWithSurface(capture_, captureWindow)');
  assert.ok(acquireProducer >= 0 && bindProducer > acquireProducer);
  assert.ok(!capture.includes('window_'), 'ScreenCapture must never bind directly to the replaceable encoder window');

  const initialize = sourceSegment(bridgeSource, 'bool Initialize(', 'bool ReplaceEncoderSurface(');
  assert.ok(initialize.includes('nativeImage = OH_NativeImage_Create(texture, GL_TEXTURE_EXTERNAL_OES)'));
  assert.ok(initialize.indexOf('captureWindow = OH_NativeImage_AcquireNativeWindow(nativeImage)') <
    initialize.indexOf('return ReplaceEncoderSurface(initialWindow, width, height)'));
});

test('live encoder reconfigure preserves ScreenCapture and detaches EGL before replacing its window', () => {
  const reconfigure = segment('bool CaptureSession::Reconfigure(', 'void CaptureSession::StopResourcesWithLifecycleLock()');
  assert.doesNotMatch(reconfigure,
    /OH_AVScreenCapture_(?:Create|Init|StartScreenCapture|StartScreenCaptureWithSurface|StopScreenCapture|Release)\s*\(/,
    'a successful rotation must stay inside the already-authorized ScreenCapture session');
  assert.ok(!reconfigure.includes('StartH264ScreenCaptureLocked()'));
  assert.ok(!reconfigure.includes('surface_bridge_.Start('));
  assert.ok(!reconfigure.includes('surface_bridge_.Stop('));
  assert.doesNotMatch(reconfigure, /\bcapture_\s*=(?!=)/, 'rotation must not replace the capture object');

  const invalidate = reconfigure.indexOf('TcpServer::Instance().InvalidateVideoConfig()');
  const detach = reconfigure.indexOf('surface_bridge_.SetEncoderWindow(nullptr, 0, 0)');
  const destroyWindow = reconfigure.indexOf('OH_NativeWindow_DestroyNativeWindow(oldWindow)');
  const destroyCodec = reconfigure.indexOf('OH_VideoEncoder_Destroy(oldEncoder)');
  const createEncoder = reconfigure.indexOf('StartH264EncoderLocked()');
  const attach = reconfigure.indexOf('surface_bridge_.SetEncoderWindow(newWindow, cfg.width, cfg.height)');
  assert.ok(invalidate >= 0 && detach > invalidate && destroyWindow > detach && destroyCodec > destroyWindow &&
    createEncoder > destroyCodec && attach > createEncoder);

  const replaceSurface = sourceSegment(bridgeSource, 'bool ReplaceEncoderSurface(', 'bool RenderNewestFrame()');
  const park = replaceSurface.indexOf('eglMakeCurrent(display, pbufferSurface, pbufferSurface, context)');
  const destroySurface = replaceSurface.indexOf('eglDestroySurface(display, encoderSurface)');
  assert.ok(park >= 0 && destroySurface > park,
    'the render thread must park on its pbuffer before destroying the old encoder EGL surface');
  const setGeometry = replaceSurface.indexOf('SET_BUFFER_GEOMETRY, width, height');
  const setRgba = replaceSurface.indexOf('SET_FORMAT, NATIVEBUFFER_PIXEL_FMT_RGBA_8888');
  const createSurface = replaceSurface.indexOf('eglCreateWindowSurface(');
  assert.ok(setGeometry > destroySurface && setRgba > setGeometry && createSurface > setRgba,
    'the EGL producer must declare RGBA geometry before allocating encoder surface buffers');
  assert.ok(replaceSurface.indexOf('PresentCurrentImage(true)') > createSurface,
    'a replacement surface must immediately receive the latest cached texture');
});

test('NativeImage callbacks are consumed while the encoder surface is parked and replayed after attachment', () => {
  const update = sourceSegment(bridgeSource, 'bool UpdateCurrentImage()', 'bool PresentCurrentImage(');
  assert.match(update, /encoderSurface != EGL_NO_SURFACE \? encoderSurface : pbufferSurface/);
  assert.ok(update.indexOf('OH_NativeImage_UpdateSurfaceImage(nativeImage)') <
    update.indexOf('hasCurrentImage = true'),
  'the bridge must release the queued NativeImage buffer before caching replay state');
  assert.ok(update.indexOf('OH_NativeImage_GetTransformMatrix') <
    update.indexOf('currentTransform = transform'),
  'the replay must retain the transform that belongs to the consumed texture');

  const present = sourceSegment(bridgeSource, 'bool PresentCurrentImage(', 'bool RenderNewestFrame()');
  assert.ok(present.indexOf('hasCurrentImage') < present.indexOf('eglSwapBuffers(display, encoderSurface)'));
  assert.match(present, /glUniformMatrix4fv\(transformLocation, 1, GL_FALSE, currentTransform\.data\(\)\)/);

  const render = sourceSegment(bridgeSource, 'bool RenderNewestFrame()', 'void Cleanup()');
  assert.match(render, /return UpdateCurrentImage\(\) && PresentCurrentImage\(\);/);
  assert.doesNotMatch(render, /encoderSurface == EGL_NO_SURFACE/,
    'detached callbacks must update the NativeImage instead of being acknowledged without consumption');
});

test('reconfigure invalidates cached video without closing clients and requires fresh SPS, PPS and IDR', () => {
  const invalidate = sourceSegment(tcpSource, 'void TcpServer::InvalidateVideoConfig()', 'void TcpServer::ClearVideoConfig()');
  for (const reset of ['lastConfig_.reset()', 'client.latestConfig.reset()', 'client.awaitingKeyframe = true']) {
    assert.ok(invalidate.includes(reset), reset);
  }
  assert.ok(!invalidate.includes('shutdown('), 'live reconfigure must keep the authorized viewer connection open');

  const reconfigure = segment('bool CaptureSession::Reconfigure(', 'void CaptureSession::StopResourcesWithLifecycleLock()');
  const gateReset = reconfigure.indexOf('h264_gate_.Reset()');
  assert.ok(reconfigure.indexOf('configEmitted_ = false') < gateReset);
  assert.ok(gateReset < reconfigure.indexOf('StartH264EncoderLocked()'));
  assert.ok(reconfigure.indexOf('sps_.clear()') < reconfigure.indexOf('StartH264EncoderLocked()'));
  assert.ok(reconfigure.indexOf('pps_.clear()') < reconfigure.indexOf('StartH264EncoderLocked()'));

  const frames = segment('void CaptureSession::HandleEncodedOutput(', 'bool CaptureSession::ParseSpsPps(');
  assert.ok(frames.indexOf('h264_gate_.CanEmitFrame(isKey, parameterSetsReady)') <
    frames.indexOf('HasMatchingIdr(data, size, ppsId)'));
  assert.ok(frames.indexOf('HasMatchingIdr(data, size, ppsId)') <
    frames.indexOf('SendH264Config(spsCopy, ppsCopy)'));
  assert.ok(frames.indexOf('SendH264Config(spsCopy, ppsCopy)') <
    frames.indexOf('SendVideoFrame(isKey, normalized'));
});

test('each replacement encoder rebases callback time onto a monotonic transport generation', () => {
  const reconfigure = segment('bool CaptureSession::Reconfigure(', 'void CaptureSession::StopResourcesWithLifecycleLock()');
  assert.ok(reconfigure.includes('timestampClock_.BeginGeneration()'));

  const normalize = segment('int64_t CaptureSession::NormalizeTimestampUs(', 'void CaptureSession::SendVideoFrame(');
  assert.ok(normalize.includes('std::chrono::steady_clock::now()'));
  assert.ok(normalize.includes('timestampClock_.Normalize(observedUs, cfg_.frameRate)'));
  assert.ok(!normalize.includes('sourcePts -'), 'mixed or repeated device PTS must not drive WebCodecs timestamps');
});

test('ArkTS display changes reach native encoder reconfigure through the exported NAPI contract', () => {
  const displayChange = sourceSegment(entryAbilitySource, 'private displayChange =', 'private dimensions(');
  assert.ok(displayChange.indexOf('this.dimensions(this.captureEdge)') <
    displayChange.indexOf("AppStorage.get<boolean>('mirrorCaptureRequested')"));
  assert.ok(displayChange.indexOf("AppStorage.get<boolean>('mirrorCaptureRequested')") <
    displayChange.indexOf('reconfigureEncoder(this.cfg)'));
  assert.ok(entryAbilitySource.includes("display.on('change', this.displayChange)"));
  assert.ok(entryAbilitySource.includes("display.off('change', this.displayChange)"));

  const napi = sourceSegment(napiSource, 'static napi_value ReconfigureEncoderJs(', 'static napi_value BroadcastDeviceStatus(');
  for (const field of ['width', 'height', 'frameRate', 'bitrate']) {
    assert.ok(napi.includes(`GetIntProp(env, args[0], "${field}"`), field);
  }
  assert.ok(napi.includes('scrcpy::ReconfigureEncoder(cfg)'));
  assert.ok(napiSource.includes('{"reconfigureEncoder", nullptr, ReconfigureEncoderJs'));
  const exported = segment('bool ReconfigureEncoder(const CaptureConfig &cfg)', '} // namespace scrcpy');
  assert.ok(exported.includes('return CaptureSession::Instance().Reconfigure(cfg)'));
});

test('native capture enables automatic canvas rotation before either capture path initializes', () => {
  const strategy = segment('bool ConfigureCanvasFollowRotation(', 'class CaptureSession');
  const create = strategy.indexOf('OH_AVScreenCapture_CreateCaptureStrategy()');
  const configure = strategy.indexOf('OH_AVScreenCapture_StrategyForCanvasFollowRotation(strategy, true)');
  const apply = strategy.indexOf('OH_AVScreenCapture_SetCaptureStrategy(capture, strategy)');
  const release = strategy.indexOf('OH_AVScreenCapture_ReleaseCaptureStrategy(strategy)');
  assert.ok(create >= 0 && configure > create && apply > configure && release > apply,
    'the API 20 rotation strategy must be configured, applied and released in its documented order');
  for (const result of ['configure == AV_SCREEN_CAPTURE_ERR_OK', 'apply == AV_SCREEN_CAPTURE_ERR_OK',
    'release == AV_SCREEN_CAPTURE_ERR_OK']) assert.ok(strategy.includes(result), result);

  const h264 = segment('bool CaptureSession::StartH264ScreenCaptureLocked()',
    'bool CaptureSession::StartH264CaptureWithSurfaceLocked()');
  const raw = segment('bool CaptureSession::StartRaw()', 'void CaptureSession::Stop(');
  for (const path of [h264, raw]) {
    assert.ok(path.indexOf('ConfigureCanvasFollowRotation(capture_)') > path.indexOf('OH_AVScreenCapture_Create()'));
    assert.ok(path.indexOf('ConfigureCanvasFollowRotation(capture_)') < path.indexOf('OH_AVScreenCapture_Init(capture_, screenCfg)'),
      'the virtual display must follow rotation before capture initialization');
  }
});
