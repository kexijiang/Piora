import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { createJiti } from "jiti";
const { allocatePioraPort, configureHypiumPorts, isPioraPort } = await createJiti(import.meta.url).import("./harmony/runtime/local-port.ts");
test("Piora and Hypium allocations exclude DevEco services even when they are not running", async () => {
  for (const port of [1633, 8710, 9000, 9515, 9523, 9999, 19999]) assert.equal(isPioraPort(port), false);
  configureHypiumPorts();
  const util = createRequire(import.meta.url)("hypium-driver/build/lib/utils/util.js");
  for (const allocate of [allocatePioraPort, util.getFreePort]) {
    const port = await allocate(); assert.ok(isPioraPort(port));
    const server = createServer();
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
    await new Promise(resolve => server.close(resolve));
  }
  await assert.rejects(util.getFreePort("192.168.1.2"), /local HDC/);
});
