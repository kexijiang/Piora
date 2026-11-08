import { HypiumAutomationDriver } from "../hypium-backend";
import { asHarmonyError, HarmonyError } from "../errors";
import { validateWorkerRequest, WORKER_PROTOCOL_VERSION } from "./worker-protocol";

const driver = new HypiumAutomationDriver({ hdcPath: process.env.PIORA_HARMONY_WORKER_HDC! });
const epoch = process.env.PIORA_HARMONY_WORKER_EPOCH, serial = process.env.PIORA_HARMONY_WORKER_SERIAL;
let lane = Promise.resolve(), pending = 0, lastId = 0;
process.on("message", (raw: unknown) => {
  const envelope = raw && typeof raw === "object" ? raw as { id?: number } : {};
  const respond = (result: Record<string, unknown>) => process.send?.({ protocol: WORKER_PROTOCOL_VERSION, epoch, id: envelope.id, status: driver.status().find(value => value.serial === serial), ...result });
  try {
    validateWorkerRequest(raw, epoch, serial);
    if (raw.id <= lastId || pending >= 64) throw new HarmonyError("DEVICE_BUSY", "Worker request was replayed or its queue is full", { details: { dispatchState: "not-sent" } });
    lastId = raw.id; pending++;
    const execute = async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        validateWorkerRequest(raw, epoch, serial);
        const controller = new AbortController();
        timer = setTimeout(() => controller.abort("worker_deadline"), Math.max(1, raw.deadline - Date.now()));
        let value: unknown;
        if (raw.method === "execute") value = await driver.execute(raw.serial, raw.args[0] as string, raw.args[1] as unknown[], controller.signal);
        else if (raw.method === "semantic") value = await driver.semanticAction(raw.serial, raw.args[0] as Parameters<typeof driver.semanticAction>[1], controller.signal);
        else value = await driver.waitForIdle(raw.serial, Number(raw.args[0]), Number(raw.args[1]), controller.signal);
        respond({ value });
      } catch (error) { respond({ error: asHarmonyError(error).toJSON() }); }
      finally { clearTimeout(timer); pending--; }
    };
    // MOVE/UP use a separate TCP channel and must not wait behind read-only
    // geometry RPCs. DOWN still enters the lane; the driver binds subsequent
    // phases to its gesture ID and blocks other mutations until release.
    const livePhase = raw.method === "execute" && ["pointer_move", "pointer_up", "pointer_release"].includes(String(raw.args[0]));
    if (livePhase) void execute().catch(() => { process.exit(1); });
    else lane = lane.then(execute).catch(() => { process.exit(1); });
  } catch (error) { respond({ error: asHarmonyError(error).toJSON() }); }
});
process.on("disconnect", () => { void driver.reset().finally(() => process.exit(0)); setTimeout(() => process.exit(1), 1500).unref(); });
