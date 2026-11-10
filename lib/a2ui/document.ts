import { AgentToRendererMessageSchema, MessageProcessor, type ProcessableMessagePayload } from "@a2ui/web_core/v1_0";
import { boundedJson, jsonRecord } from "../mini-app/json";
import { A2UI_VERSION, PIORA_A2UI_CATALOG, pioraA2uiCatalog } from "./catalog";

export interface A2uiComponent { id: string; component: string; [key: string]: unknown }
export interface A2uiDocument { version: "1.0"; surfaceId: string; components: A2uiComponent[]; dataModel: Record<string, unknown> }
export class A2uiError extends Error {
  constructor(readonly path: string, message: string) { super(`${path}: ${message}`); this.name = "A2uiError"; }
}
export function requireA2ui(ok: unknown, path: string, message: string): asserts ok { if (!ok) throw new A2uiError(path, message); }
export const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
export function a2uiKeys(value: Record<string, unknown>, allowed: string[], path: string) {
  requireA2ui(Object.keys(value).every(key => allowed.includes(key)), path, `Supported properties: ${allowed.join(", ")}`);
}
export function a2uiChildren(component: A2uiComponent): string[] {
  if (["Row", "Column"].includes(component.component)) {
    requireA2ui(Array.isArray(component.children) && component.children.every(item => typeof item === "string"), component.id, "Use explicit child IDs in this catalog profile");
    return component.children as string[];
  }
  if (["Card", "Button"].includes(component.component)) {
    requireA2ui(typeof component.child === "string", component.id, "Expected one child ID"); return [component.child];
  }
  return [];
}
export function a2uiPath(value: unknown, prefix: "inputs" | "frame"): string | undefined {
  if (!object(value)) return;
  const path = value["@path"];
  if (typeof path !== "string" || !new RegExp(`^/${prefix}/[A-Za-z][A-Za-z0-9_-]{0,63}$`).test(path)) return;
  a2uiKeys(value, ["@path"], "binding"); return path.slice(prefix.length + 2);
}
/** Complete tool submissions are atomic A2UI message batches. The official SDK
 * validates protocol/catalog/graph semantics; the host additionally bounds resources.
 * RPC and deletion are deliberately not accepted by this create/revise endpoint. */
export function parseA2uiMessages(input: unknown, expectedId?: string): A2uiDocument {
  boundedJson(input, 96_000, "messages");
  requireA2ui(Array.isArray(input) && input.length > 0 && input.length <= 32, "messages", "Expected 1 to 32 A2UI 1.0 messages");
  const processor = new MessageProcessor([pioraA2uiCatalog], undefined, { version: "v1.0" });
  let surfaceId = "";
  const components = new Map<string, A2uiComponent>();
  try {
    input.forEach((value, index) => {
      const path = `messages/${index}`;
      const result = AgentToRendererMessageSchema.safeParse(value);
      requireA2ui(result.success, path, "Expected an official A2UI 1.0 message");
      const message = jsonRecord(value, path);
      requireA2ui(message.version === A2UI_VERSION, path, "Use version 1.0");
      const type = "createSurface" in message ? "createSurface" : "updateComponents" in message ? "updateComponents" : "updateDataModel" in message ? "updateDataModel" : "";
      requireA2ui(type, path, "Only createSurface, updateComponents and updateDataModel are supported here");
      const body = jsonRecord(message[type], path);
      if (index === 0) {
        requireA2ui(type === "createSurface" && typeof body.surfaceId === "string" && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(body.surfaceId), path, "Begin with createSurface and a stable task ID");
        requireA2ui(body.catalogId === PIORA_A2UI_CATALOG, path, `Use catalogId ${PIORA_A2UI_CATALOG}`);
        surfaceId = body.surfaceId;
        requireA2ui(expectedId === undefined || surfaceId === expectedId, path, "surfaceId must match the answer ID");
      } else requireA2ui(type !== "createSurface" && body.surfaceId === surfaceId, path, "One surface per complete submission");
      if (Array.isArray(body.components)) for (const raw of body.components) {
        const component = raw as A2uiComponent;
        requireA2ui(typeof component.id === "string" && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(component.id), path, "Use bounded component IDs");
        requireA2ui(component.catalogId === undefined || component.catalogId === PIORA_A2UI_CATALOG, path, "Unregistered component catalog");
        requireA2ui(component.checks === undefined, path, "This profile uses declared host input constraints; component checks are not supported");
        requireA2ui(component.component !== "TextField" || component.variant === undefined || component.variant === "shortText", path, "Only shortText fields are supported by this runtime profile");
        components.set(component.id, component);
      }
      // Delay graph completeness checks until the entire snapshot has arrived.
      processor.processMessages([message] as ProcessableMessagePayload, { validationConfig: { allowOrphanComponents: true, allowDanglingReferences: true, allowMissingRoot: true, maxDepth: 12 } });
      requireA2ui(components.size <= 160, path, "At most 160 components");
    });
    const surface = processor.getSurface(surfaceId);
    requireA2ui(surface, "messages", "Surface was not created");
    const dataModel = surface.dataModel.get<Record<string, unknown>>("/");
    boundedJson(dataModel, 64_000, "dataModel");
    const visited = new Set<string>();
    const visit = (id: string, depth: number) => {
      requireA2ui(depth <= 12 && !visited.has(id), id, "A bounded tree without cycles or shared child IDs is required");
      const component = components.get(id); requireA2ui(component, id, "Unknown child reference");
      visited.add(id); for (const child of a2uiChildren(component)) visit(child, depth + 1);
    };
    visit("root", 0);
    requireA2ui(visited.size === components.size, "components", "Every component must be reachable from root");
    return JSON.parse(JSON.stringify({ version: A2UI_VERSION, surfaceId, components: [...components.values()], dataModel }));
  } catch (error) {
    if (error instanceof A2uiError) throw error;
    throw new A2uiError("messages", error instanceof Error ? error.message.slice(0, 1200) : "A2UI validation failed");
  } finally { processor.dispose(); }
}
export function a2uiMessages(document: A2uiDocument): unknown[] {
  requireA2ui(document?.version === A2UI_VERSION, "document/version", "Unsupported saved A2UI version");
  return [{ version: A2UI_VERSION, createSurface: { surfaceId: document.surfaceId, catalogId: PIORA_A2UI_CATALOG,
    components: document.components, dataModel: document.dataModel } }];
}
