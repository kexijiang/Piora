import { Type } from "@earendil-works/pi-ai";
import { answerConversionSchema } from "../answer-output-conversion-schema";
import { MINI_APP_CSS_MEDIA_CONTRACT, MINI_APP_DOCUMENT_CONTRACT, MINI_APP_PROGRAM_SCOPE_CONTRACT, MINI_APP_STATE_MEANING_CONTRACT } from "./authoring-contract";

const strict = { additionalProperties: false };
const id = Type.String({ pattern: "^[A-Za-z][A-Za-z0-9_-]{0,63}$" });
const label = Type.String({ minLength: 1, maxLength: 120 });
const base = { id, label, meaning: Type.String({ minLength: 1, maxLength: 300 }) };
const number = Type.Number({ minimum: -1e12, maximum: 1e12 });

/** Transport schema stays finite. The compiler checks the bounded nested state schema. */
export const miniAppPlanSchema = Type.Object({
  planVersion: Type.Literal(1, { description: "Required on every submission including corrections. Mini-app tool version is always 1; component Plan2 is a separate tool." }), id, title: Type.String({ minLength: 1, maxLength: 160 }),
  conversion: answerConversionSchema("mini-app"),
  migration: Type.Optional(Type.Object({ fromPlanDigest: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    description: Type.String({ minLength: 1, maxLength: 600 }), clock: Type.Union([Type.Literal("reset"), Type.Literal("preserve")]),
  }, { ...strict, description: "Optional same-app progress migration, only with the stateMigration capability and a complete saved progressSource. Bind its exact planDigest and add migrate(previous,inputs,ctx) to program. previous contains frozen source inputs/state/tick/rng; return only the new state. The host requires explicit user confirmation, validates the new schema, sends blur, resets camera, and either preserves or resets tick/RNG per clock. The user can always choose fresh init instead. No external actions." })),
  inputPresets: Type.Optional(Type.Array(Type.Object({ id, label,
    values: Type.Record(id, Type.Union([number, Type.String({ maxLength: 4000 }), Type.Boolean()]), { minProperties: 1, maxProperties: 24 }),
  }, strict), { minItems: 1, maxItems: 16, description: "Static local input presets, such as resetting angles or choosing an example. Values must match declared input constraints. Mount each once as a plain button with data-preset=id; label is supplied here. The host updates all listed inputs atomically, calls reduce with ordinary input events in input declaration order, and projects once. Omitted inputs and host camera are preserved; no external action or implicit state restart." })),
  purpose: Type.String({ minLength: 1, maxLength: 600 }),
  assumptions: Type.Array(Type.String({ minLength: 1, maxLength: 300 }), { maxItems: 12 }),
  playback: Type.Union([
    Type.Object({ mode: Type.Literal("none") }, strict),
    Type.Object({ mode: Type.Literal("discrete"), stepEvent: id }, strict),
    Type.Object({ mode: Type.Literal("continuous") }, strict),
  ], { description: "none for event-only tools; discrete names a button data-event used by both that button and host step/play; continuous calls advance(state,dt,ctx). Playable frames must include playback:{finished:boolean}." }),
  inputs: Type.Array(Type.Union([
    Type.Object({ ...base, type: Type.Union([Type.Literal("number"), Type.Literal("range")]), value: number, min: number, max: number, step: Type.Number({ minimum: 1e-9, maximum: 1e12 }) }, strict),
    Type.Object({ ...base, type: Type.Literal("checkbox"), value: Type.Boolean() }, strict),
    Type.Object({ ...base, type: Type.Literal("text"), value: Type.String({ maxLength: 2000 }), maxLength: Type.Number({ minimum: 1, maximum: 2000, multipleOf: 1 }) }, strict),
    Type.Object({ ...base, type: Type.Literal("select"), value: label, options: Type.Array(Type.Object({ value: label, label }, strict), { minItems: 1, maxItems: 32 }) }, strict),
  ]), { maxItems: 24 }),
  stateSchema: Type.Object({ type: Type.Union(["null", "boolean", "number", "integer", "string", "array", "object"].map(value => Type.Literal(value))) }, {
    additionalProperties: true,
    description: "Bounded JSON Schema subset: finite numeric minimum/maximum; string maxLength<=4000 and optional string enum; array maxItems<=2000 and items; object properties, required (all keys), additionalProperties:false. No refs, patterns or unions. Nesting<=8, total schema nodes<=128.",
  }),
  document: Type.Object({ html: Type.String({ minLength: 1, maxLength: 64_000, description: "Bounded semantic markup only; no scripts, inline handlers or external resources. Every input id must occur once in data-input, every viewport id in data-viewport. Runtime text belongs in data-text bindings." }), css: Type.String({ maxLength: 24_000, description: MINI_APP_CSS_MEDIA_CONTRACT }) }, { ...strict, description: MINI_APP_DOCUMENT_CONTRACT }),
  viewports: Type.Array(Type.Object({ id, kind: Type.Union([Type.Literal("canvas2d"), Type.Literal("scene3d")]),
    picking: Type.Optional(Type.Literal(true)), cameraControls: Type.Optional(Type.Literal(true)), groups: Type.Optional(Type.Literal(true, { description: "Enable bounded parent transform groups on this scene3d viewport; requires the sceneGroups capability." })),
    label: Type.String({ minLength: 1, maxLength: 160 }), width: Type.Number({ multipleOf: 1, minimum: 32, maximum: 1024 }), height: Type.Number({ multipleOf: 1, minimum: 32, maximum: 1024 }) }, strict), { maxItems: 3 }),
  program: Type.String({ minLength: 1, maxLength: 64_000, description: "Declare init(inputs,ctx), reduce(state,event,ctx), advance(state,dt,ctx) and project(state,inputs,ctx). " + MINI_APP_PROGRAM_SCOPE_CONTRACT + " " + MINI_APP_STATE_MEANING_CONTRACT }), initialSnapshot: Type.String({ minLength: 1, maxLength: 4000 }),
  actions: Type.Optional(Type.Object({ version: Type.Literal(1), actions: Type.Array(Type.Union([
    Type.Object({ id, label, kind: Type.Literal("read_json_parameters"), path: Type.String({ minLength: 1, maxLength: 240 }) }, strict),
    Type.Object({ id, label, kind: Type.Literal("save_snapshot"), path: Type.String({ minLength: 1, maxLength: 240 }), format: Type.Union([Type.Literal("json"), Type.Literal("markdown")]) }, strict),
  ]), { maxItems: 8 }) }, { ...strict, description: "Only when registeredActions is available. Declarative host actions, rendered outside the generated document. Paths are project-relative, parent directories must exist. read_json_parameters reads a complete JSON object with exactly the input IDs; the host shows values for explicit adoption, runs input reducers, and retains progress/clocks. save_snapshot creates a server-confirmed report without overwriting. Existing session permissions apply; no generated event can invoke an action." })),
}, strict);
