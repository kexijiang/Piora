import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { isApiRequestAllowed } from "@/lib/request-security";
import { firstPartyRuntimeRoot } from "@/lib/first-party-extensions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Serves only the pinned application binary, never a caller-selected resource. */
export async function GET(request: Request) {
  if (!isApiRequestAllowed(request)) return new Response("Forbidden", { status: 403 });
  try {
    const directory=join(firstPartyRuntimeRoot(),".mini-app-runtime");
    const [bytes,manifest]=await Promise.all([readFile(join(directory,"quickjs.wasm")),readFile(join(directory,"manifest.json"),"utf8").then(JSON.parse)]);
    if(bytes.length>8*1024*1024||createHash("sha256").update(bytes).digest("hex")!==manifest.wasmSha256)throw new Error("Runtime asset mismatch");
    return new Response(new Uint8Array(bytes), { headers: {
      "Content-Type": "application/wasm", "Content-Length": String(bytes.length),
      "Cache-Control": "private, max-age=3600", "X-Content-Type-Options": "nosniff",
    } });
  } catch { return new Response("Mini app runtime is unavailable",{status:503}); }
}
