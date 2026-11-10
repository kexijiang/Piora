import { GestureChannel } from "./gesture-channel";

export interface GestureConnection {
  channel: Pick<GestureChannel, "touch">;
  close(): Promise<void>;
}

/** The SDK initializes the agent; this connection owns only its own forwarding rule. */
export async function openGestureConnection(device: {
  hdcHost: string; isUnixSocket: boolean;
  createForward(local: string, remote: string): Promise<boolean>;
  removeForward(local: string, remote: string): Promise<boolean>;
}, freePort: () => Promise<number>): Promise<GestureConnection> {
  if (device.hdcHost !== "127.0.0.1" || !device.isUnixSocket) throw new Error("Live touch requires a local Unix-socket agent");
  const local = `tcp:${await freePort()}`, remote = "localabstract:uitest_socket";
  if (!await device.createForward(local, remote)) throw new Error("Could not forward live touch channel");
  const channel = new GestureChannel(Number(local.slice(4)));
  let closed = false;
  const close = async () => {
    if (closed) return; closed = true; channel.close();
    if (!await device.removeForward(local, remote)) throw new Error("Live touch forwarding cleanup could not be confirmed");
  };
  try { await channel.connect(); return { channel, close }; }
  catch (error) { await close(); throw error; }
}
