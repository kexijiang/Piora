import { Type } from "@earendil-works/pi-ai";
import { createUiPlanSchema, uiPlanAtomSchema, uiPlanOperationSchema } from "./plan-schema";
import { UI_RICH_LIMITS } from "./rich-protocol";

const strict = { additionalProperties: false };
const id = Type.String({ pattern: "^[a-zA-Z][a-zA-Z0-9_-]{0,63}$" });
const title = Type.String({ minLength: 1, maxLength: 160 });
const nodeIds = Type.Array(id, { minItems: 1, maxItems: UI_RICH_LIMITS.nodes, uniqueItems: true });
const filter = Type.Object({
  // SDK Value.Convert truncates Type.Integer values before validation. Number
  // plus multipleOf preserves a fractional input so validation can reject it.
  column: Type.Number({ multipleOf: 1, minimum: 0, maximum: 11 }), controlId: id,
  operator: Type.Union([Type.Literal("equals"), Type.Literal("contains"), Type.Literal("gte"), Type.Literal("lte")]),
  inactiveValue: Type.Optional(Type.Union([Type.String({ maxLength: 160 }), Type.Number({ minimum: -1e12, maximum: 1e12 }), Type.Boolean()])),
}, strict);

/** A finite union of flat blocks; no recursive containers or arbitrary actions. */
export const uiRichLayoutBlockSchema = Type.Union([
  Type.Object({ id, type: Type.Literal("group"), title, columns: Type.Union([Type.Literal(1), Type.Literal(2), Type.Literal(3)]), nodeIds }, strict),
  Type.Object({ id, type: Type.Literal("comparison"), title,
    cards: Type.Array(Type.Object({ id, title, nodeIds }, strict), { minItems: 2, maxItems: UI_RICH_LIMITS.cardsPerComparison }),
  }, strict),
  Type.Object({ id, type: Type.Literal("filteredTable"), title, tableId: id,
    filters: Type.Array(filter, { minItems: 1, maxItems: UI_RICH_LIMITS.filtersPerTable }),
  }, strict),
]);

/** Selected alone by the host's plan-2 tool mode. Compiler cross-checks are mandatory. */
// Keep the provider schema finite and compact. The mandatory original-plan
// compiler validates every nested operand before SDK coercion or execution;
// preview likewise parses all closed operands, including non-visible ones.
const inlineOperation = Type.Object({ op: uiPlanOperationSchema,
  args: Type.Array(Type.Unknown(), { minItems: 1, maxItems: 32,
    description: "Each operand is a literal, an explicit input/derived reference, or another {op,args} operation. Host validates types, references, depth and total cost." }),
}, strict);
const richAtom = Type.Union([uiPlanAtomSchema, Type.String({ maxLength: 2000 }), Type.Number({ minimum: -1e12, maximum: 1e12 }), Type.Boolean(), inlineOperation]);
const coreSchema = createUiPlanSchema(richAtom);
export const uiRichPlanSchema = Type.Object({
  ...coreSchema.properties,
  views: Type.Array(Type.Union([...coreSchema.properties.views.items.anyOf,
    Type.Object({ id, kind: Type.Literal("dynamicText"), parts: Type.Array(richAtom, { minItems: 1, maxItems: 12,
      description: "Literal prose interleaved with explicit input/derived references or bounded expressions. Values update with controls; never hardcode the current result in prose." }) }, strict),
  ]), { maxItems: 64 }),
  planVersion: Type.Literal(2),
  layout: Type.Array(uiRichLayoutBlockSchema, { minItems: 1, maxItems: UI_RICH_LIMITS.blocks }),
  actions: Type.Optional(Type.Object({ version: Type.Literal(1), actions: Type.Array(Type.Union([
    Type.Object({ id, label: Type.String({ minLength: 1, maxLength: 120 }), kind: Type.Literal("read_json_parameters"), path: Type.String({ minLength: 1, maxLength: 240 }) }, strict),
    Type.Object({ id, label: Type.String({ minLength: 1, maxLength: 120 }), kind: Type.Literal("save_snapshot"), path: Type.String({ minLength: 1, maxLength: 240 }), format: Type.Union([Type.Literal("json"), Type.Literal("markdown")]) }, strict),
  ]), { maxItems: 8 }) }, strict)),
}, strict);
