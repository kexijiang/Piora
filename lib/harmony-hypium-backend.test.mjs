import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { HypiumAutomationDriver } = await jiti.import("./harmony/hypium-backend.ts");
const { HarmonyError } = await jiti.import("./harmony/errors.ts");

function fakeBy() {
  const by = {};
  for (const name of ["id", "text", "type", "hint", "inWindow", "clickable", "scrollable", "enabled", "focused", "selected", "checked", "within", "isBefore", "isAfter"]) {
    by[name] = () => by;
  }
  by.type = type => { by.typeName = type; return by; };
  return by;
}

function fakeModule(driver, connect) {
  return {
    BY: { id: fakeBy, text: fakeBy, type: fakeBy, hint: fakeBy, inWindow: fakeBy, clickable: fakeBy, scrollable: fakeBy, enabled: fakeBy, focused: fakeBy, selected: fakeBy, checked: fakeBy },
    MatchPattern: { EQUALS: 0, CONTAINS: 1, STARTS_WITH: 2, ENDS_WITH: 3 },
    KeyCode: { APPSELECT: 1, ENTER: 2 },
    UiDriver: { connect: connect ?? (async () => driver) },
  };
}

test("Hypium connects once per device and reuses the persistent UiDriver session", async () => {
  let connections = 0;
  let privacyChecks = 0;
  let clicks = 0;
  const component = { async exist() { return true; }, async click() { clicks += 1; } };
  const driver = { findComponent() { return component; }, async findComponents() { return [component]; }, async disconnect() {} };
  const driverModule = fakeModule(driver, async () => { connections += 1; return driver; });
  const hypium = new HypiumAutomationDriver({
    hdcPath: "C:\\fake\\hdc.exe",
    importDriver: async () => driverModule,
    preparePrivacy: () => { privacyChecks += 1; },
  });
  await Promise.all([
    hypium.semanticAction("phone-1", { action: "tap", selector: { id: "a" } }),
    hypium.semanticAction("phone-1", { action: "tap", selector: { id: "b" } }),
  ]);
  assert.equal(connections, 1);
  assert.equal(privacyChecks, 1);
  assert.equal(clicks, 2);
  assert.deepEqual(hypium.status(), [{ serial: "phone-1", state: "ready" }]);
  await hypium.reset();
});

test("Hypium semantic actions reject ambiguous targets and honor an explicit index", async () => {
  const clicked = [];
  const components = [0, 1].map((index) => ({
    async exist() { return true; },
    async click() { clicked.push(index); },
  }));
  const driver = {
    findComponent() { return components[0]; },
    async findComponents() { return components; },
    async disconnect() {},
  };
  const hypium = new HypiumAutomationDriver({
    hdcPath: "C:\\fake\\hdc.exe",
    importDriver: async () => fakeModule(driver),
    preparePrivacy: () => {},
  });
  await assert.rejects(
    () => hypium.semanticAction("phone-1", { action: "tap", selector: { text: "Open" } }),
    (error) => error instanceof HarmonyError && error.code === "UI_TARGET_AMBIGUOUS",
  );
  await hypium.semanticAction("phone-1", { action: "tap", selector: { text: "Open", index: 1 } });
  assert.deepEqual(clicked, [1]);
  await hypium.reset();
});

test("connection failures enter a bounded cooldown and remain eligible for HDC fallback", async () => {
  const hypium = new HypiumAutomationDriver({
    hdcPath: "C:\\fake\\hdc.exe",
    importDriver: async () => fakeModule(undefined, async () => { throw new Error("not supported"); }),
    preparePrivacy: () => {},
    now: () => Date.parse("2026-09-02T00:00:00.000Z"),
  });
  const first = await hypium.tryRun("phone-1", "tap", undefined, async () => undefined);
  const second = await hypium.tryRun("phone-1", "tap", undefined, async () => undefined);
  assert.deepEqual(first, { used: false });
  assert.deepEqual(second, { used: false });
  assert.equal(hypium.status()[0].state, "cooldown");
});

test("a connected RPC failure invalidates the session instead of duplicating the mutation", async () => {
  let disconnected = false;
  const driver = { async disconnect() { disconnected = true; } };
  const hypium = new HypiumAutomationDriver({
    hdcPath: "C:\\fake\\hdc.exe",
    importDriver: async () => fakeModule(driver),
    preparePrivacy: () => {},
  });
  await assert.rejects(
    () => hypium.tryRun("phone-1", "tap", undefined, async () => { throw new Error("rpc lost"); }),
    (error) => error instanceof HarmonyError && error.code === "AUTOMATION_DRIVER_FAILED",
  );
  assert.equal(disconnected, true);
  assert.equal(hypium.status().some((entry) => entry.state === "ready"), false);
});

test("text input selects the editable focused field instead of its focused ancestors", async () => {
  let text = "", writes = 0;
  const field = { getType: async () => "textField", inputText: async value => { text = value; writes++; }, getText: async () => text };
  let components = [...["root", "Navigation", "Stack", "Web"].map(type => ({ getType: async () => type })), field];
  const driver = { findComponents: async by => {
    const types = await Promise.all(components.map(component => component.getType()));
    return components.filter((_component, index) => types[index] === by.typeName);
  }, disconnect: async () => {} };
  const hypium = new HypiumAutomationDriver({ hdcPath: "fake", importDriver: async () => fakeModule(driver), preparePrivacy: () => {} });
  assert.equal((await hypium.execute("phone", "input_text", ["Piora 中文"])).used, true);
  assert.equal(text, "Piora 中文"); assert.equal(writes, 1);
  components.push({ ...field, getType: async () => "TextInput" });
  await assert.rejects(() => hypium.execute("phone", "input_text", ["ambiguous"]), error => error.code === "UI_TARGET_AMBIGUOUS" && error.details.dispatchState === "not-sent");
  components = [{ getType: async () => "Web" }];
  await assert.rejects(() => hypium.execute("phone", "input_text", ["missing"]), error => error.code === "UI_TARGET_NOT_FOUND");
  assert.equal(writes, 1, "missing/ambiguous targets must never receive input");
  components = [{ ...field, getText: async () => "different" }];
  await assert.rejects(() => hypium.execute("phone", "input_text", ["expected"]), error => error.code === "SCENARIO_FAILED");
  await hypium.reset();
});

test("ordinary volume and power keys use one bounded key event without hold calibration", async () => {
  const codes=[];
  const driver={async triggerKey(code){codes.push(code);},async disconnect(){}};
  const hypium=new HypiumAutomationDriver({hdcPath:"fixture",importDriver:async()=>fakeModule(driver),preparePrivacy:()=>{}});
  try {
    for(const key of ["volume_up","volume_down","power"]) await hypium.execute("phone", "press_key", [key]);
    assert.deepEqual(codes,[16,17,18]);
  } finally { await hypium.reset(); }
});

test("persistent geometry retains primary display identity and rejects rotation races", async () => {
  let rotations=[0,0], size={x:1216,y:2688,displayId:0};
  const driver={async getDisplayRotation(){return rotations.shift();},rpcClient:{async callUiTestRpc(api){assert.equal(api,"Driver.getDisplaySize");return JSON.stringify(size);}},async disconnect(){}};
  const hypium=new HypiumAutomationDriver({hdcPath:"fixture",importDriver:async()=>fakeModule(driver),preparePrivacy:()=>{}});
  try {
    assert.deepEqual(await hypium.execute("phone","display_geometry",[]),{used:true,value:{nativeWidth:1216,nativeHeight:2688,displayId:"0",displayRotation:0}});
    rotations=[0,1];await assert.rejects(()=>hypium.execute("phone","display_geometry",[]),e=>e.code==="STALE_SNAPSHOT");
    rotations=[1,1];size={x:2688,y:1216,displayId:0};assert.equal((await hypium.execute("phone","display_geometry",[])).value.displayRotation,90);
    for(const invalid of [{x:0,y:10,displayId:0},{x:100,y:100,displayId:2},{x:100,y:100}]) {
      size=invalid;rotations=[0,0];
      await assert.rejects(()=>hypium.execute("phone","display_geometry",[]),e=>e.code==="CAPABILITY_UNAVAILABLE");
    }
    size={x:100,y:100,displayId:0};rotations=[4,4];await assert.rejects(()=>hypium.execute("phone","display_geometry",[]),e=>e.code==="CAPABILITY_UNAVAILABLE");
  } finally {await hypium.reset();}
});

test("tap uses persistent down/up and never replays an ambiguous down", async()=>{
  const steps=[];let opened=0,closed=0;
  const driver={async disconnect(){}};
  const hypium=new HypiumAutomationDriver({hdcPath:"fixture",importDriver:async()=>fakeModule(driver),preparePrivacy:()=>{},
    async openGesture(){opened++;return{channel:{async touch(phase,x,y){steps.push([phase,x,y]);if(phase==="down")throw Error("ambiguous");}},async close(){closed++;}};}});
  try{await assert.rejects(()=>hypium.execute("phone","tap",[100,200]),e=>e.code==="AUTOMATION_DRIVER_FAILED");assert.deepEqual(steps,[["down",100,200],["up",100,200]]);assert.equal(opened,1);assert.equal(closed,1);}finally{await hypium.reset();}
});

test("successive taps reuse their owned gesture connection and reset removes it", async()=>{
  const phases=[];let opened=0,closed=0;
  const hypium=new HypiumAutomationDriver({hdcPath:"fixture",importDriver:async()=>fakeModule({async disconnect(){}}),preparePrivacy:()=>{},
    async openGesture(){opened++;return{channel:{async touch(phase){phases.push(phase);}},async close(){closed++;}};}});
  await hypium.execute("phone","tap",[100,200]);await hypium.execute("phone","tap",[100,200]);await hypium.reset();
  assert.equal(opened,1);assert.equal(closed,1);assert.deepEqual(phases,["down","up","down","up"]);
});

test("live pointer phases share the socket and reject interleaved or foreign input", async()=>{
  const phases=[];
  const hypium=new HypiumAutomationDriver({hdcPath:"fixture",importDriver:async()=>fakeModule({async disconnect(){}}),preparePrivacy:()=>{},
    async openGesture(){return{channel:{async touch(phase,x,y){phases.push([phase,x,y]);}},async close(){}};}});
  try {
    const id="a".repeat(32);
    await hypium.execute("phone","pointer_down",[id,100,200]);
    await assert.rejects(()=>hypium.execute("phone","press_key",["back"]),e=>e.code==="DEVICE_BUSY");
    await assert.rejects(()=>hypium.semanticAction("phone",{action:"tap",selector:{id:"button"}}),e=>e.code==="DEVICE_BUSY");
    await assert.rejects(()=>hypium.execute("phone","pointer_up",["b".repeat(32),100,200]),e=>e.code==="STALE_SNAPSHOT");
    await hypium.execute("phone","pointer_move",[id,150,250]);
    await hypium.execute("phone","pointer_up",[id,150,250]);
    assert.deepEqual(phases,[["down",100,200],["move",150,250],["up",150,250]]);
  } finally {await hypium.reset();}
});
