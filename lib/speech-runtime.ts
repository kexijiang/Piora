import { delimiter, join } from "node:path";
import OpenCC from "opencc-js";
import { detectSpeechHardware } from "./speech-pack-catalog";
import { createExternalSpeechRequire, verifiedSpeechPackPath } from "./speech-pack-manager";
import { containsAudibleSpeech } from "./voice-audio";

interface SherpaWave {
  samples: Float32Array;
  sampleRate: number;
}

interface SherpaOfflineStream {
  acceptWaveform(input: SherpaWave): void;
}

interface SherpaRecognizerResult {
  text?: unknown;
}

interface SherpaOfflineRecognizer {
  createStream(): SherpaOfflineStream;
  decodeAsync(stream: SherpaOfflineStream): Promise<SherpaRecognizerResult>;
}

interface SherpaOfflineRecognizerConstructor {
  createAsync(config: unknown): Promise<SherpaOfflineRecognizer>;
}

interface SherpaModule {
  OfflineRecognizer: SherpaOfflineRecognizerConstructor;
}

interface SpeechRuntimeState {
  key: string;
  recognizer: Promise<SherpaOfflineRecognizer>;
  sherpa: SherpaModule;
  tail: Promise<void>;
}

type SpeechRuntimeGlobalThis = typeof globalThis & {
  __pioraLocalSpeechRuntime?: SpeechRuntimeState;
};

const toSimplifiedChinese = OpenCC.Converter({ from: "twp", to: "cn" });

export class SpeechUnavailableError extends Error {}

function prependLibraryPath(name: "LD_LIBRARY_PATH" | "DYLD_LIBRARY_PATH", path: string): void {
  const current = process.env[name]?.split(delimiter).filter(Boolean) ?? [];
  if (!current.includes(path)) process.env[name] = [path, ...current].join(delimiter);
}

async function createRuntime(language: "zh" | "en"): Promise<SpeechRuntimeState> {
  const { path: packPath } = await verifiedSpeechPackPath();
  const hardware = detectSpeechHardware();
  if (!hardware.supported || !hardware.runtimePackage) {
    throw new SpeechUnavailableError(`Local speech is not supported on ${process.platform}/${process.arch}`);
  }
  const nativeDirectory = join(packPath, "runtime", "node_modules", hardware.runtimePackage);
  if (process.platform === "linux") prependLibraryPath("LD_LIBRARY_PATH", nativeDirectory);
  if (process.platform === "darwin") prependLibraryPath("DYLD_LIBRARY_PATH", nativeDirectory);

  let sherpa: SherpaModule;
  try {
    sherpa = createExternalSpeechRequire(packPath)("sherpa-onnx-node") as SherpaModule;
  } catch (error) {
    throw new SpeechUnavailableError(
      `Unable to load the local speech runtime: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!sherpa?.OfflineRecognizer?.createAsync) {
    throw new SpeechUnavailableError("The installed local speech runtime is incomplete");
  }
  const modelRoot = join(packPath, "model");
  const recognizer = sherpa.OfflineRecognizer.createAsync({
    featConfig: { sampleRate: 16_000, featureDim: 80 },
    modelConfig: {
      senseVoice: {
        model: join(modelRoot, "model.int8.onnx"),
        language,
        useInverseTextNormalization: 1,
      },
      tokens: join(modelRoot, "tokens.txt"),
      numThreads: hardware.threads,
      debug: false,
      provider: "cpu",
    },
  }).catch((error: unknown) => {
    const target = globalThis as SpeechRuntimeGlobalThis;
    if (target.__pioraLocalSpeechRuntime?.recognizer === recognizer) delete target.__pioraLocalSpeechRuntime;
    throw new SpeechUnavailableError(
      `Unable to initialize the local speech model: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
  return { key: `${packPath}:${hardware.threads}:${language}`, recognizer, sherpa, tail: Promise.resolve() };
}

async function getRuntime(language: "zh" | "en" = "zh"): Promise<SpeechRuntimeState> {
  const { path: packPath } = await verifiedSpeechPackPath();
  const hardware = detectSpeechHardware();
  const key = `${packPath}:${hardware.threads}:${language}`;
  const target = globalThis as SpeechRuntimeGlobalThis;
  if (target.__pioraLocalSpeechRuntime?.key === key) return target.__pioraLocalSpeechRuntime;
  const runtime = await createRuntime(language);
  target.__pioraLocalSpeechRuntime = runtime;
  // Covers even an initialization rejection that settled before cache assignment.
  void runtime.recognizer.catch(() => { if (target.__pioraLocalSpeechRuntime === runtime) delete target.__pioraLocalSpeechRuntime; });
  return runtime;
}

export async function warmLocalSpeechRuntime(): Promise<void> {
  const runtime = await getRuntime();
  await runtime.recognizer;
}

function normalizeSenseVoiceText(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/<\|[^|>]+\|>/g, "").replace(/\s+/g, " ").trim();
}

function decodePcm16Wav(bytes: Uint8Array): SherpaWave {
  if (bytes.byteLength < 44) throw new Error("Audio is too short");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (offset: number, length: number) => String.fromCharCode(...bytes.subarray(offset, offset + length));
  if (ascii(0, 4) !== "RIFF" || ascii(8, 4) !== "WAVE") throw new Error("Audio must be a WAV file");
  let offset = 12;
  let format: { audioFormat: number; channels: number; sampleRate: number; bitsPerSample: number } | null = null;
  let dataOffset = -1;
  let dataLength = 0;
  while (offset + 8 <= bytes.byteLength) {
    const id = ascii(offset, 4);
    const size = view.getUint32(offset + 4, true);
    const contentOffset = offset + 8;
    if (contentOffset + size > bytes.byteLength) throw new Error("WAV chunk exceeds the recording size");
    if (id === "fmt " && size >= 16) {
      format = {
        audioFormat: view.getUint16(contentOffset, true),
        channels: view.getUint16(contentOffset + 2, true),
        sampleRate: view.getUint32(contentOffset + 4, true),
        bitsPerSample: view.getUint16(contentOffset + 14, true),
      };
    } else if (id === "data") {
      dataOffset = contentOffset;
      dataLength = size;
      break;
    }
    offset = contentOffset + size + (size % 2);
  }
  if (!format || dataOffset < 0) throw new Error("WAV format or data chunk is missing");
  if (format.audioFormat !== 1 || format.channels !== 1 || format.bitsPerSample !== 16) {
    throw new Error("Audio must be mono PCM16 WAV");
  }
  if (format.sampleRate !== 16_000) throw new Error("Audio must use a 16 kHz sample rate");
  const sampleCount = Math.floor(dataLength / 2);
  const samples = new Float32Array(sampleCount);
  for (let index = 0; index < sampleCount; index += 1) {
    const sample = view.getInt16(dataOffset + index * 2, true);
    samples[index] = sample < 0 ? sample / 0x8000 : sample / 0x7fff;
  }
  return { samples, sampleRate: format.sampleRate };
}

export async function transcribeLocalSpeechWav(bytes: Uint8Array, language: "zh" | "en" = "zh"): Promise<string> {
  const runtime = await getRuntime(language);
  const job = runtime.tail.then(async () => {
    let wave: SherpaWave;
    try {
      wave = decodePcm16Wav(bytes);
    } catch (error) {
      throw new Error(`Invalid WAV audio: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!(wave.samples instanceof Float32Array) || !Number.isFinite(wave.sampleRate) || wave.samples.length === 0) {
      throw new Error("The recording contains no decodable audio");
    }
    if (!containsAudibleSpeech(wave.samples, wave.sampleRate)) return "";
    const recognizer = await runtime.recognizer;
    const stream = recognizer.createStream();
    stream.acceptWaveform(wave);
    const result = await recognizer.decodeAsync(stream);
    const text = normalizeSenseVoiceText(result?.text);
    return language === "zh" ? toSimplifiedChinese(text) : text;
  });
  runtime.tail = job.then(() => undefined, () => undefined);
  return job;
}

export function resetLocalSpeechRuntime(): void {
  delete (globalThis as SpeechRuntimeGlobalThis).__pioraLocalSpeechRuntime;
}
