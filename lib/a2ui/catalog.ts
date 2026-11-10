import { z } from "zod";
import { basicCatalog, Catalog, DynamicValueSchema, DataBindingSchema, type ComponentApi, type FunctionApi } from "@a2ui/web_core/v1_0";

/** A local, versioned catalog identifier. Never fetch model-supplied catalogs. */
export const PIORA_A2UI_CATALOG = "urn:piora:a2ui:interactive:1";
export const A2UI_VERSION = "1.0" as const;
const id = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/);
const label = z.string().min(1).max(160);
const scalar = z.union([z.string().max(4000), z.number().finite(), z.boolean()]);
const dynamic = DynamicValueSchema;
const weight = { weight: z.number().min(0).max(100).optional() };
const entry = (name: string, properties: z.ZodRawShape): ComponentApi => ({ name, schema: z.object({ ...properties, ...weight }).strict() });

export const PIORA_A2UI_COMPONENTS: ComponentApi[] = [
  entry("PioraNumber", { label, value: DataBindingSchema, min: z.number().finite().optional(), max: z.number().finite().optional(), step: z.number().positive().optional(), unit: z.string().max(40).optional() }),
  entry("PioraChoice", { label, value: DataBindingSchema, options: z.array(label).min(1).max(40) }),
  entry("PioraMetric", { label, value: dynamic, unit: z.string().max(40).optional() }),
  entry("PioraTable", { columns: z.array(label).min(1).max(12), rows: z.array(z.array(dynamic).max(12)).max(100) }),
  entry("PioraBarChart", { labels: z.array(label).max(40), values: z.array(dynamic).max(40) }),
  // These components use the existing isolated mini-app runtime. Their content
  // still passes its SVG/viewport/repeat compiler; catalog validation is not a grant.
  entry("PioraSvg", { markup: z.string().min(1).max(64000) }),
  entry("PioraViewport", { viewportId: id }),
  entry("PioraRepeat", { repeatId: id, template: z.string().min(1).max(16000) }),
];
export const PIORA_A2UI_OPERATIONS = ["add", "subtract", "multiply", "divide", "round", "min", "max", "if", "equals", "lt", "lte", "gt", "gte"] as const;
const functions: FunctionApi[] = [
  ...PIORA_A2UI_OPERATIONS.map(name => ({ name, returnType: "any", schema: z.object({ values: z.array(z.unknown()).min(1).max(32) }).strict(), allowedCallers: "rendererOnly" as const })),
  { name: "concat", returnType: "string", schema: z.object({ values: z.array(z.unknown()).min(1).max(12) }).strict(), allowedCallers: "rendererOnly" },
  { name: "pioraSet", returnType: "void", schema: z.object({ input: id, value: scalar }).strict(), allowedCallers: "rendererOnly", requiresUserActivation: true },
  { name: "pioraEvent", returnType: "void", schema: z.object({ id }).strict(), allowedCallers: "rendererOnly", requiresUserActivation: true },
  { name: "pioraPreset", returnType: "void", schema: z.object({ id }).strict(), allowedCallers: "rendererOnly", requiresUserActivation: true },
];
export const pioraA2uiCatalog = new Catalog<ComponentApi>(PIORA_A2UI_CATALOG, "1.0",
  [...["Row", "Column", "Card", "Text", "Divider", "Slider", "CheckBox", "Button", "TextField"].map(name => basicCatalog.components.get(name)!), ...PIORA_A2UI_COMPONENTS],
  functions.map(fn => ({ ...fn, execute() { throw new Error("Piora catalog functions require the validated host execution context"); } })),
);
