import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { isApiRequestAllowed } from "@/lib/request-security";
import { firstPartyRuntimeRoot } from "@/lib/first-party-extensions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** No paths, code or dependencies are accepted from the caller. */
export async function GET(request: Request) {
  if (!isApiRequestAllowed(request)) return new Response("Forbidden", { status: 403 });
  try {
    const directory=join(firstPartyRuntimeRoot(),".mini-app-runtime");
    const [source,manifest]=await Promise.all([readFile(join(directory,"renderer.js"),"utf8"),readFile(join(directory,"manifest.json"),"utf8").then(JSON.parse)]);
    if(source.length>4*1024*1024||createHash("sha256").update(source).digest("hex")!==manifest.sha256) throw new Error("Runtime asset mismatch");
    return Response.json({source,sha256:manifest.sha256},{headers:{"Cache-Control":"no-store"}});
  } catch { return Response.json({error:"Mini app renderer is unavailable"},{status:503,headers:{"Cache-Control":"no-store"}}); }
}
