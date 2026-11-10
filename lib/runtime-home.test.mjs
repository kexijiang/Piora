import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

async function loadSubject() {
  try {
    const { createJiti } = await import("jiti");
    return createJiti(import.meta.url).import("./runtime-home.ts");
  } catch {
    return import("./runtime-home.ts");
  }
}

const { getRuntimeAgentDataDirectory, getRuntimeHomeDirectory, getRuntimeUserHomeDirectory } = await loadSubject();

test("OS tilde expansion remains independent of Piora's data-home override", () => {
  const environment = { PIORA_HOME: "C:/Piora-data", USERPROFILE: "C:/Users/person", HOME: "/home/person" };
  assert.equal(getRuntimeUserHomeDirectory(environment), path.resolve(process.platform === "win32" ? environment.USERPROFILE : environment.HOME));
  environment.USERPROFILE = "D:/another-user"; environment.HOME = "/home/another";
  assert.equal(getRuntimeUserHomeDirectory(environment), path.resolve(process.platform === "win32" ? environment.USERPROFILE : environment.HOME));
});

test("prefers an explicit Pi GUI home directory", () => {
  assert.equal(
    getRuntimeHomeDirectory({
      PIORA_HOME: "C:\\PiHome",
      USERPROFILE: "C:\\Users\\fallback",
    }),
    path.resolve("C:\\PiHome"),
  );
});

test("falls back to standard home environment variables", () => {
  const expected = path.resolve(process.platform === "win32" ? "C:\\Users\\pi" : "/home/pi");
  assert.equal(
    getRuntimeHomeDirectory({ USERPROFILE: "C:\\Users\\pi", HOME: "/home/pi" }),
    expected,
  );
});

test("rejects a missing runtime home directory", () => {
  assert.throws(
    () => getRuntimeHomeDirectory({}),
    /PIORA_HOME, USERPROFILE, or HOME/,
  );
});

test("agent data follows PI_CODING_AGENT_DIR with a home-based fallback", () => {
  const configured = path.resolve("D:\\PiData");
  assert.equal(
    getRuntimeAgentDataDirectory({
      PI_CODING_AGENT_DIR: configured,
      USERPROFILE: "C:\\Users\\fallback",
    }),
    configured,
  );
  assert.equal(
    getRuntimeAgentDataDirectory({ USERPROFILE: "C:\\Users\\pi", HOME: "/home/pi" }),
    path.join(getRuntimeHomeDirectory({ USERPROFILE: "C:\\Users\\pi", HOME: "/home/pi" }), ".pi", "agent"),
  );
});
