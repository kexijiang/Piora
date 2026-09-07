import { getAgentTerminalCommands } from "@/lib/agent-terminal-registry";

export const dynamic = "force-dynamic";
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return Response.json({ commands: getAgentTerminalCommands(id) }, { headers: { "Cache-Control": "no-store" } });
}
