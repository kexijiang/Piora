import { isIP } from "node:net";
import { HarmonyError } from "./errors";

export function validateTcpDeviceAddress(value: string): string {
  if (typeof value !== "string" || value.length > 64) throw new HarmonyError("INVALID_ARGUMENT", "Enter a private IPv4 address and port");
  const match = /^(\d{1,3}(?:\.\d{1,3}){3}):(\d{1,5})$/.exec(value.trim());
  if (!match || isIP(match[1]) !== 4) throw new HarmonyError("INVALID_ARGUMENT", "Enter an IPv4 address and port, for example 192.168.1.10:8710");
  const octets = match[1].split(".").map(Number);
  const port = Number(match[2]);
  const privateAddress = octets[0] === 10 || octets[0] === 127 || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
    || (octets[0] === 192 && octets[1] === 168) || (octets[0] === 169 && octets[1] === 254);
  if (!privateAddress || port < 1 || port > 65535) throw new HarmonyError("INVALID_ARGUMENT", "Use a private or loopback IPv4 address and port 1–65535");
  return `${octets.join(".")}:${port}`;
}
