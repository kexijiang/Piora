import { createServer } from "node:http";
import { resolve } from "node:path";
import { createJiti } from "jiti";
import { readFileSync } from "node:fs";

// Local, read-only preview of the exact desktop document. No application state.
const { createStartupDocument, loadStartupMedia } = await createJiti(import.meta.url).import("../desktop/src/startup-scene.ts");
const port = Number(process.argv[2] ?? 31043);
const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid preview port");
createServer((request, response) => {
  if (request.url !== "/") { response.writeHead(404); response.end(); return; }
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  response.end(createStartupDocument({ chinese: true, updated: true, version, ...loadStartupMedia(resolve("desktop/build/startup")) }));
}).listen(port, "127.0.0.1", () => console.log(`Startup preview: http://127.0.0.1:${port}`));
