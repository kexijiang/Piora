import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { formatHarmonyDeviceLabel, formatHarmonyDeviceTitle } = await jiti.import("./harmony/device-label.ts");

test("shows the market name and certified model before a user nickname", () => {
  assert.equal(formatHarmonyDeviceLabel({
    serial: "phone-1",
    product: "HUAWEI Mate 60 Pro",
    model: "ALN-AL00",
    name: "Living room phone",
  }), "HUAWEI Mate 60 Pro (ALN-AL00) · Living room phone");
});

test("deduplicates identical identity fields and falls back safely", () => {
  assert.equal(formatHarmonyDeviceLabel({
    serial: "phone-1",
    product: "MatePad Pro",
    model: "MatePad Pro",
    name: "matepad pro",
  }), "MatePad Pro");
  assert.equal(formatHarmonyDeviceLabel({ serial: "phone-2", model: "BRA-AL00" }), "BRA-AL00");
  assert.equal(formatHarmonyDeviceLabel({ serial: "phone-3" }), "phone-3");
});

test("small mirror titles prefer marketing names and keep certification codes in details", () => {
  assert.equal(formatHarmonyDeviceTitle({ serial: "phone", name: "BRA-AL00", model: "BRA-AL00", product: "HUAWEI Mate 60 " }), "HUAWEI Mate 60");
  assert.equal(formatHarmonyDeviceTitle({ serial: "phone", model: "PLR-AL00", product: "HUAWEI Pura 70" }), "HUAWEI Pura 70");
  assert.equal(formatHarmonyDeviceTitle({ serial: "phone", name: "HUAWEI Pura 70", model: "PLR-AL00", product: "PLR-AL00" }), "HUAWEI Pura 70");
  assert.equal(formatHarmonyDeviceTitle({ serial: "phone", name: "PLR-AL00", model: "PLR-AL00" }), "鸿蒙设备");
});
