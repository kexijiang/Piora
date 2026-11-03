import { MINI_APP_LIMITS } from "./limits";

/** Trusted guest prelude is evaluated and captured BEFORE any generated code. */
export const MINI_APP_GUEST_RUNTIME = `(() => {
  "use strict";
  const parse = JSON.parse, stringify = JSON.stringify, keys = Object.keys;
  const own = Object.getOwnPropertyDescriptor, proto = Object.getPrototypeOf;
  const freeze = Object.freeze, isArray = Array.isArray, finite = Number.isFinite;
  const objectPrototype = Object.prototype;
  const forbidden = new Set(["__proto__", "constructor", "prototype", "toJSON"]);
  const fail = code => { throw new Error(code); };
  const encode = (value, maximum, depthOffset = 0, totals) => {
    let count = 0, approximate = 0;
    const seen = new Set();
    const visit = (v, depth) => {
      if (++count > ${MINI_APP_LIMITS.jsonNodes} || depth > ${MINI_APP_LIMITS.depth}) fail("JSON_LIMIT");
      if (v === null || typeof v === "boolean" || typeof v === "number" && finite(v)) approximate += 4;
      else if (typeof v === "string") approximate += v.length;
      else if (v && typeof v === "object") {
        if (seen.has(v) || !isArray(v) && proto(v) !== objectPrototype && proto(v) !== null) fail("JSON_TYPE");
        if (isArray(v) && v.length > ${MINI_APP_LIMITS.jsonNodes}) fail("JSON_LIMIT");
        seen.add(v);
        const names = Object.getOwnPropertyNames(v);
        if (names.length > ${MINI_APP_LIMITS.jsonNodes} || Object.getOwnPropertySymbols(v).length) fail("JSON_LIMIT");
        for (const key of names) {
          if (isArray(v) && key === "length") continue;
          const d = own(v, key);
          if (forbidden.has(key) || !d || !("value" in d) || !d.enumerable) fail("JSON_TYPE");
          if (isArray(v) && !(String(Number(key)) === key && Number.isInteger(Number(key)) && Number(key) >= 0)) fail("JSON_TYPE");
          approximate += key.length + 3; visit(d.value, depth + 1);
        }
        if (isArray(v) && names.length !== v.length + 1) fail("JSON_TYPE");
        seen.delete(v);
      } else fail("JSON_TYPE");
      if (approximate > maximum) fail("JSON_LIMIT");
    };
    visit(value, depthOffset);
    const result = stringify(value);
    if (result.length > maximum) fail("JSON_LIMIT");
    let bytes = 0;
    for (let i = 0; i < result.length; i++) {
      const c = result.charCodeAt(i);
      if (c < 128) bytes++;
      else if (c < 2048) bytes += 2;
      else if (c >= 0xd800 && c <= 0xdbff && i + 1 < result.length && result.charCodeAt(i + 1) >= 0xdc00 && result.charCodeAt(i + 1) <= 0xdfff) { bytes += 4; i++; }
      else bytes += 3;
      if (bytes > maximum) fail("JSON_LIMIT");
    }
    if (totals) {
      totals.nodes += count; totals.bytes += bytes; totals.approximate += approximate;
      if (totals.nodes > ${MINI_APP_LIMITS.jsonNodes} || totals.approximate > ${MINI_APP_LIMITS.replyBytes}) fail("JSON_LIMIT");
    }
    return result;
  };
  const deepFreeze = v => {
    if (v && typeof v === "object") { for (const key of keys(v)) deepFreeze(v[key]); freeze(v); }
    return v;
  };
  // Freeze reachable intrinsics before the program can modify serializers or prototypes.
  delete globalThis.eval;
  delete globalThis.Function;
  Object.defineProperty(Math, "random", { value: () => fail("USE_CONTEXT_RANDOM"), writable: false, configurable: false });
  const hardened = new Set();
  const harden = value => {
    if (!value || typeof value !== "object" && typeof value !== "function" || hardened.has(value)) return;
    hardened.add(value);
    for (const key of Object.getOwnPropertyNames(value)) {
      const d = own(value, key);
      if (d && "value" in d) harden(d.value);
      else if (d) { harden(d.get); harden(d.set); }
    }
    freeze(value);
  };
  harden(globalThis);
  return (factory, requestText) => {
    const request = parse(requestText);
    let { state, inputs, tick, rng } = request.snapshot;
    const functions = factory();
    for (const name of ["init", "reduce", "advance", "project"]) {
      const d = own(functions, name);
      if (!d || !("value" in d) || typeof d.value !== "function") fail("LIFECYCLE");
    }
    let projecting = false;
    const random = () => {
      if (projecting) fail("PROJECT_RANDOM");
      rng = (Math.imul(1664525, rng) + 1013904223) >>> 0;
      return rng / 4294967296;
    };
    inputs = deepFreeze(inputs);
    if (request.command === "step") tick++;
    const context = freeze({ inputs, tick, elapsed: tick / ${MINI_APP_LIMITS.framesPerSecond}, random });
    if (request.command === "init") state = functions.init(inputs, context);
    else if (request.command === "migrate") {
      const migration = own(functions, "migrate");
      if (!migration || !("value" in migration) || typeof migration.value !== "function") fail("LIFECYCLE");
      state = migration.value(deepFreeze(request.previous), inputs, context);
      // A transferred checkpoint must not keep old held keys or pointer grabs.
      state = functions.reduce(state, deepFreeze({type:"blur"}), context);
    }
    else if (request.command === "restore") state = functions.reduce(state, deepFreeze({type:"blur"}), context);
    else if (request.command === "event") state = functions.reduce(state, deepFreeze(request.event), context);
    else if (request.command === "preset") {
      const values = deepFreeze(request.event.values);
      // All handlers see the complete new input set. Only the final state/frame
      // leaves this bounded transaction; no partially applied UI is published.
      for (const id of keys(values)) state = functions.reduce(state, freeze({type:"input",id,value:values[id]}), context);
    }
    else if (request.command === "step") state = request.event
      ? functions.reduce(state, deepFreeze(request.event), context)
      : functions.advance(state, 1 / ${MINI_APP_LIMITS.framesPerSecond}, context);
    else if (request.command !== "project") fail("COMMAND");
    const stateText = encode(state, ${MINI_APP_LIMITS.stateBytes});
    projecting = true;
    const frame = functions.project(deepFreeze(parse(stateText)), inputs, context);
    // Validate each output subtree once at its real envelope depth. The old
    // path walked the entire frame twice inside the same 8ms operation. Keep
    // aggregate node/UTF-8 limits without rewalking model-owned structures.
    // 57 is the original walk's key-size estimate for the fixed envelope and
    // two numeric clock values. Preserve that early bound as well as exact bytes.
    const totals = { nodes: 4, bytes: 0, approximate: 57 }; // envelope, snapshot, rng and tick
    const inputsText = encode(inputs, ${MINI_APP_LIMITS.replyBytes}, 2, totals);
    const finalStateText = encode(state, ${MINI_APP_LIMITS.stateBytes}, 2, totals);
    const frameText = encode(frame, ${MINI_APP_LIMITS.frameBytes}, 1, totals);
    const reply = '{"snapshot":{"inputs":'+inputsText+',"state":'+finalStateText+',"rng":'+rng+',"tick":'+tick+'},"frame":'+frameText+'}';
    const overhead = reply.length-inputsText.length-finalStateText.length-frameText.length;
    if (totals.bytes+overhead > ${MINI_APP_LIMITS.replyBytes}) fail("JSON_LIMIT");
    return reply;
  };
})()`;
