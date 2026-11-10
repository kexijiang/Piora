import { createServer } from "node:net";
import { createRequire } from "node:module";
import { randomInt } from "node:crypto";
import { harmonyRuntimeAsset } from "./asset-path";

// Keep Piora-owned listeners outside DevEco's service and SDK allocation range.
export const isPioraPort = (port: number) => Number.isInteger(port) && port >= 20000 && port <= 65535;

export async function allocatePioraPort(): Promise<number> {
  for (let attempt = 0; attempt < 128; attempt++) {
    const port = await new Promise<number>((resolve, reject) => {
      const server = createServer(); server.unref();
      server.once("error", (error: NodeJS.ErrnoException) => error.code === "EADDRINUSE" || error.code === "EACCES" ? resolve(0) : reject(error));
      server.listen({ host: "127.0.0.1", port: randomInt(20000, 65536), exclusive: true }, () => {
        const address = server.address();
        server.close(error => error ? reject(error) : address && typeof address !== "string" ? resolve(address.port) : reject(new Error("Missing local address")));
      });
    });
    if (isPioraPort(port)) return port;
  }
  throw new Error("Could not allocate a Piora port outside the DevEco range");
}

/** Apply only inside Piora's worker, before SDK initialization. SDK internals
 * call this CJS export too; changing only its public re-export is insufficient. */
export function configureHypiumPorts(): void {
  const require = createRequire(harmonyRuntimeAsset("package.json"));
  const util = require("hypium-driver/build/lib/utils/util.js");
  if (typeof util.getFreePort !== "function") throw new Error("Unsupported Hypium port allocator");
  util.getFreePort = async (host = "127.0.0.1") => {
    if (host !== "127.0.0.1") throw new Error("Piora control requires a local HDC connection");
    return allocatePioraPort();
  };
}
