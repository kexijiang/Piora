import { Type } from "@earendil-works/pi-ai";
import type { TSchema } from "typebox";
import { UI_PLAN_LIMITS } from "./plan-types";

const id = Type.String({ pattern: "^[a-zA-Z][a-zA-Z0-9_-]{0,63}$" });
const label = Type.String({ maxLength: 160 });
const numeric = () => Type.Number({ minimum: -1e12, maximum: 1e12 });
const unit = Type.Optional(Type.String({ minLength: 1, maxLength: 40 }));
const strict = { additionalProperties: false };
/** A flat union: no recursive schema, nested operations, code or formula strings. */
export const uiPlanAtomSchema = Type.Union([
  Type.Object({ literal: Type.Union([Type.String({ maxLength: 2000 }), numeric(), Type.Boolean()]) }, strict),
  Type.Object({ input: id }, strict),
  Type.Object({ derived: id }, strict),
]);
const input = Type.Union([
  Type.Object({ id, label, unit, valueType: Type.Literal("number"), value: numeric(), min: Type.Optional(numeric()), max: Type.Optional(numeric()), step: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 1e12 })), presentation: Type.Optional(Type.Union([Type.Literal("number"), Type.Literal("slider")])) }, strict),
  Type.Object({ id, label, unit, valueType: Type.Literal("string"), value: label, options: Type.Array(label, { minItems: 1, maxItems: 40, uniqueItems: true }) }, strict),
  Type.Object({ id, label, unit, valueType: Type.Literal("boolean"), value: Type.Boolean() }, strict),
]);
export const uiPlanOperationSchema = Type.Union(["add", "subtract", "multiply", "divide", "round", "min", "max", "if", "equals"].map(op => Type.Literal(op)));
const views = (atom: TSchema) => Type.Union([
  Type.Object({ id, kind: Type.Literal("text"), text: Type.String({ maxLength: 2000 }) }, strict),
  Type.Object({ id, kind: Type.Literal("metric"), label, unit, value: atom }, strict),
  Type.Object({ id, kind: Type.Literal("table"), columns: Type.Array(label, { minItems: 1, maxItems: 12 }), rows: Type.Array(Type.Array(atom, { minItems: 1, maxItems: 12 }), { maxItems: 100 }) }, strict),
  Type.Object({ id, kind: Type.Literal("barChart"), labels: Type.Array(label, { maxItems: 40 }), values: Type.Array(atom, { maxItems: 40 }) }, strict),
]);
/** Use compileUiPlan after provider validation: cross-field and graph checks are mandatory. */
export const createUiPlanSchema = (atom: TSchema) => Type.Object({
  planVersion: Type.Literal(1), id, title: Type.String({ minLength: 1, maxLength: 160 }),
  inputs: Type.Array(input, { maxItems: UI_PLAN_LIMITS.inputs }),
  derived: Type.Array(Type.Object({ id, op: uiPlanOperationSchema, args: Type.Array(atom, { minItems: 1, maxItems: 32 }) }, strict), { maxItems: UI_PLAN_LIMITS.derived }),
  views: Type.Array(views(atom), { minItems: 1, maxItems: UI_PLAN_LIMITS.views }),
}, strict);
export const uiPlanSchema = createUiPlanSchema(uiPlanAtomSchema);
