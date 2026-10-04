import { createHash } from "node:crypto";
import { basename, extname, isAbsolute } from "node:path";
import JSZip from "jszip";
import { HarmonyError } from "../errors";
import type { HarmonyHapPreview } from "../hap-preview";
import { readBoundedRegularFile } from "./bounded-file";

const MAX_METADATA = 512 * 1024;
const identifier = /^[A-Za-z][A-Za-z0-9_.:]{0,255}$/;
const object = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const text = (value: unknown) => typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value) ? value : undefined;
const integer = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const names = (value: unknown) => Array.isArray(value) ? [...new Set(value.slice(0, 256).map(item => typeof item === "string" ? item : object(item)?.name).filter((name): name is string => typeof name === "string" && identifier.test(name)))] : [];
const invalid = (message: string) => new HarmonyError("INVALID_ARGUMENT", message, { details: { reason: "hap-preview-invalid" } });

/** Read only the root configuration. Never extract or execute archive contents. */
export async function previewHapArtifact(path: string, signal?: AbortSignal): Promise<HarmonyHapPreview> {
  signal?.throwIfAborted();
  if (!isAbsolute(path) || extname(path).toLowerCase() !== ".hap") throw invalid("Choose an absolute HAP file path");
  const data = await readBoundedRegularFile(path, 256 * 1024 * 1024);
  if (!data.length) throw invalid("The HAP is empty");
  signal?.throwIfAborted();
  let zip: JSZip;
  try { zip = await JSZip.loadAsync(data, { createFolders: false }); }
  catch { throw invalid("Cannot read this HAP archive"); }
  if (Object.keys(zip.files).length > 20_000) throw invalid("The HAP contains too many entries");
  const entry = zip.file("module.json") ?? zip.file("config.json");
  const original = (entry as (JSZip.JSZipObject & { unsafeOriginalName?: string }) | null)?.unsafeOriginalName;
  if (!entry || entry.dir || (original !== undefined && original !== entry.name)) throw invalid("The HAP has no regular root module.json or config.json");
  // Bound actual decompressed bytes, including archives with false size declarations.
  // JSZip 3.10 implements this documented API but omits it from JSZipObject's declarations.
  const stream = (entry as JSZip.JSZipObject & { internalStream(type: "nodebuffer"): JSZip.JSZipStreamHelper<Buffer> }).internalStream("nodebuffer");
  let metadata: Buffer;
  try {
    metadata = await new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = []; let bytes = 0, finished = false;
      const fail = (error: unknown) => { if (finished) return; finished = true; stream.pause(); signal?.removeEventListener("abort", abort); reject(error); };
      const abort = () => fail(new HarmonyError("COMMAND_ABORTED", "Package preview was cancelled"));
      signal?.addEventListener("abort", abort, { once: true });
      stream.on("data", chunk => { if (finished) return; bytes += chunk.length; if (bytes > MAX_METADATA) fail(invalid("The HAP configuration is too large")); else chunks.push(chunk); });
      stream.on("error", fail);
      stream.on("end", () => { if (finished) return; finished = true; signal?.removeEventListener("abort", abort); resolve(Buffer.concat(chunks)); });
      if (signal?.aborted) abort(); else stream.resume();
    });
  } catch (error) {
    if (signal?.aborted) throw new HarmonyError("COMMAND_ABORTED", "Package preview was cancelled");
    if (error instanceof HarmonyError) throw error;
    throw invalid("Cannot decode the HAP configuration");
  } finally { stream.pause(); }
  let root: Record<string, unknown> | undefined;
  try { root = object(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(metadata))); }
  catch { throw invalid("The HAP configuration is not valid UTF-8 JSON"); }
  const app = object(root?.app), moduleInfo = object(root?.module);
  const bundleName = app?.bundleName;
  if (typeof bundleName !== "string" || !/^[A-Za-z][A-Za-z0-9_.]{0,255}$/.test(bundleName) || !moduleInfo) throw invalid("The HAP has no valid application identity or module");
  const legacyVersion = object(app?.version);
  signal?.throwIfAborted();
  return { filename: basename(path), size: data.length, sha256: createHash("sha256").update(data).digest("hex"), bundleName,
    versionName: text(app?.versionName ?? legacyVersion?.name), versionCode: integer(app?.versionCode ?? legacyVersion?.code),
    moduleName: text(moduleInfo.name), moduleType: text(moduleInfo.type), abilities: names(moduleInfo.abilities),
    deviceTypes: names(moduleInfo.deviceTypes), permissions: names(moduleInfo.requestPermissions ?? moduleInfo.reqPermissions), signature: "unverified" };
}
