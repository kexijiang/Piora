import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, ListResourcesRequestSchema, ListResourceTemplatesRequestSchema, ReadResourceRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { pathToFileURL } from "node:url";

export function createFixtureServer(state = { calls: [], cancelled: 0, withdrawn: false }) {
  const server = new Server({ name: "piora-local-mcp-fixture", version: "1" }, { capabilities: { tools: { listChanged: true }, resources: {} }, instructions: "LOCAL_FIXTURE_ONLY" });
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    if (state.discoveryGate) await state.discoveryGate;
    return { tools: (state.withdrawn ? ["echo", "wait", "fail", "withdraw"] : ["echo", "wait", "fail", "withdraw", "image"]).map(name => ({ name, description: `Fixture ${name}`, inputSchema: { type: "object", properties: { value: { type: "string" } } }, ...(name === "echo" ? { outputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] } } : {}) })) };
  });
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const { name, arguments: args = {} } = request.params;
    state.calls.push({ name, args });
    if (name === "wait") {
      if (request.params._meta?.progressToken !== undefined) await extra.sendNotification({ method: "notifications/progress", params: { progressToken: request.params._meta.progressToken, progress: 1, total: 2, message: "FIXTURE_PROGRESS" } });
      await new Promise((resolve, reject) => { const timeout = setTimeout(resolve, 5000); extra.signal.addEventListener("abort", () => { clearTimeout(timeout); state.cancelled++; reject(new Error("Fixture cancelled")); }, { once: true }); });
    }
    if (name === "withdraw") { state.withdrawn = true; await server.sendToolListChanged(); }
    if (name === "fail") return { content: [{ type: "text", text: "FIXTURE_ERROR" }], isError: true };
    if (name === "image") return { content: [{ type: "image", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==", mimeType: "image/png" }] };
    return { content: [{ type: "text", text: String(args.value ?? "fixture") }], ...(name === "echo" ? { structuredContent: { value: String(args.value ?? "fixture") } } : {}) };
  });
  server.setRequestHandler(ListResourcesRequestSchema, () => ({ resources: [{ uri: "fixture://private", name: "FIXTURE_PRIVATE_RESOURCE" }] }));
  server.setRequestHandler(ListResourceTemplatesRequestSchema, () => ({ resourceTemplates: [{ uriTemplate: "fixture://{id}", name: "FIXTURE_TEMPLATE" }] }));
  server.setRequestHandler(ReadResourceRequestSchema, request => ({ contents: [{ uri: request.params.uri, mimeType: "text/plain", text: "FIXTURE_RESOURCE_CONTENT" }] }));
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await createFixtureServer().connect(new StdioServerTransport());
