import { availableParallelism, totalmem } from "node:os";
import type { SpeechHardwareProfile } from "./speech-types";

export const SPEECH_PACK_VERSION = "1.13.6-sensevoice-2024-07-17";
export const SPEECH_PACK_APPROXIMATE_DOWNLOAD_BYTES = 270 * 1024 * 1024;
const SPEECH_PACK_RELEASE_BASE_URL = `https://github.com/kexijiang/Piora/releases/download/speech-pack-${SPEECH_PACK_VERSION}`;

export interface SpeechDownloadSource {
  name: string;
  url: string;
  fallbackUrls?: string[];
  algorithm: "sha256" | "sha512";
  digest: string;
  encoding: "hex" | "base64";
}

export interface SpeechRuntimeSource extends SpeechDownloadSource {
  packageName: string;
  unpackedBytes: number;
}

export const SHERPA_NODE_SOURCE: SpeechRuntimeSource = {
  name: "sherpa-onnx-node-1.13.6.tgz",
  packageName: "sherpa-onnx-node",
  url: "https://registry.npmjs.org/sherpa-onnx-node/-/sherpa-onnx-node-1.13.6.tgz",
  algorithm: "sha512",
  digest: "FjUSQSStTi/wcLqlScGFmNA7ySjW3QwquJcMRJ1yDkDpBp0BmWXkXoirDuEj8/v2/Cs4wLYJp2BKaMD9+1lDGA==",
  encoding: "base64",
  unpackedBytes: 59_654,
};

const RUNTIME_SOURCES: Record<string, SpeechRuntimeSource> = {
  "win32-x64": {
    name: "sherpa-onnx-win-x64-1.13.6.tgz",
    packageName: "sherpa-onnx-win-x64",
    url: "https://registry.npmjs.org/sherpa-onnx-win-x64/-/sherpa-onnx-win-x64-1.13.6.tgz",
    algorithm: "sha512",
    digest: "bPMdURD1XCu1Zr3eYYlYx2obc5CMSQhEnd1GQuv7FXjdyOeMJ8jNbQEKFEIAyQdC481FgZvPBb2oSJXaLOOeVw==",
    encoding: "base64",
    unpackedBytes: 23_005_758,
  },
  "linux-x64": {
    name: "sherpa-onnx-linux-x64-1.13.6.tgz",
    packageName: "sherpa-onnx-linux-x64",
    url: "https://registry.npmjs.org/sherpa-onnx-linux-x64/-/sherpa-onnx-linux-x64-1.13.6.tgz",
    algorithm: "sha512",
    digest: "HiR3yolQDl3WoU1zSXn8L0MSXzF9PXLQpMv+Ptozg1y/DJU8HuvoXBasOarX4cer5d9kGimnOUGm0dl47PCN1A==",
    encoding: "base64",
    unpackedBytes: 32_745_901,
  },
  "linux-arm64": {
    name: "sherpa-onnx-linux-arm64-1.13.6.tgz",
    packageName: "sherpa-onnx-linux-arm64",
    url: "https://registry.npmjs.org/sherpa-onnx-linux-arm64/-/sherpa-onnx-linux-arm64-1.13.6.tgz",
    algorithm: "sha512",
    digest: "xSzhqrGFbBrykpbEFt5dLXB3Sp3a8idNzjhf92uylDgUhupBSRHj3ISeYaL9ZZWTNSzszNXBKlM+xH36dHQjPg==",
    encoding: "base64",
    unpackedBytes: 39_639_408,
  },
  "darwin-x64": {
    name: "sherpa-onnx-darwin-x64-1.13.6.tgz",
    packageName: "sherpa-onnx-darwin-x64",
    url: "https://registry.npmjs.org/sherpa-onnx-darwin-x64/-/sherpa-onnx-darwin-x64-1.13.6.tgz",
    algorithm: "sha512",
    digest: "3X5FQ9PpwlBmxLqtb2/uvl7/W2HXXzXHT0MLmB9c0TRMANLujzvIF7YbT6VW3k92ClL/1q9sbIOul0rHgxCTmw==",
    encoding: "base64",
    unpackedBytes: 36_879_094,
  },
  "darwin-arm64": {
    name: "sherpa-onnx-darwin-arm64-1.13.6.tgz",
    packageName: "sherpa-onnx-darwin-arm64",
    url: "https://registry.npmjs.org/sherpa-onnx-darwin-arm64/-/sherpa-onnx-darwin-arm64-1.13.6.tgz",
    algorithm: "sha512",
    digest: "m3QMOGUHVPUl7bAOPc7oJtmzOVdzQVQPsCuTjNuQ2N6zlYuXDZu9NdUR3Er3rxbhHa6SmWa94flUwmUsO1atow==",
    encoding: "base64",
    unpackedBytes: 33_355_434,
  },
};

export const SENSEVOICE_MODEL_SOURCE: SpeechDownloadSource & { bytes: number } = {
  name: "model.int8.onnx",
  url: `${SPEECH_PACK_RELEASE_BASE_URL}/model.int8.onnx`,
  fallbackUrls: ["https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main/model.int8.onnx", "https://hf-mirror.com/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main/model.int8.onnx"],
  algorithm: "sha256",
  digest: "c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51",
  encoding: "hex",
  bytes: 239_233_841,
};

export const SENSEVOICE_TOKENS_SOURCE: SpeechDownloadSource & { bytes: number } = {
  name: "tokens.txt",
  url: `${SPEECH_PACK_RELEASE_BASE_URL}/tokens.txt`,
  fallbackUrls: ["https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main/tokens.txt", "https://hf-mirror.com/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main/tokens.txt"],
  algorithm: "sha256",
  digest: "f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc",
  encoding: "hex",
  bytes: 315_894,
};

export function speechRuntimeKey(platform = process.platform, arch = process.arch): string {
  return `${platform}-${arch}`;
}

export function getSpeechRuntimeSource(
  platform = process.platform,
  arch = process.arch,
): SpeechRuntimeSource | null {
  return RUNTIME_SOURCES[speechRuntimeKey(platform, arch)] ?? null;
}

export function detectSpeechHardware(): SpeechHardwareProfile {
  const logicalCores = Math.max(1, availableParallelism());
  const memoryGiB = Math.max(1, Math.round((totalmem() / 1024 ** 3) * 10) / 10);
  const runtime = getSpeechRuntimeSource();
  const tier = logicalCores <= 4 || memoryGiB < 8
    ? "compact"
    : logicalCores >= 12 && memoryGiB >= 16
      ? "performance"
      : "balanced";
  const threadCeiling = tier === "compact" ? 2 : tier === "balanced" ? 4 : 8;
  const threads = Math.max(1, Math.min(threadCeiling, Math.max(1, logicalCores - 1)));
  return {
    platform: process.platform,
    arch: process.arch,
    logicalCores,
    memoryGiB,
    threads,
    tier,
    supported: runtime !== null,
    runtimePackage: runtime?.packageName ?? null,
  };
}
