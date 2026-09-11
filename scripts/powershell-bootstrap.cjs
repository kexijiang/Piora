/* eslint-disable @typescript-eslint/no-require-imports -- Loaded by the packaged CommonJS server launcher. */
const path = require("node:path");

// This file ships beside pwsh.exe, outside both ASAR archives. Derive the path
// on each launch: portable caches and installation directories can move.
if (process.platform === "win32") {
  process.env.PIORA_BUNDLED_PWSH = path.join(__dirname, "pwsh.exe");
  const pathKeys = Object.keys(process.env).filter(key => key.toLowerCase() === "path");
  const inherited = pathKeys.map(key => process.env[key]).find(Boolean) || "";
  for (const key of pathKeys) delete process.env[key];
  process.env.PATH = [__dirname, inherited].filter(Boolean).join(path.delimiter);
  process.env.POWERSHELL_UPDATECHECK = "Off";
  process.env.POWERSHELL_TELEMETRY_OPTOUT = "1";
}
