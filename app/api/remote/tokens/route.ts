import { createRemoteCapabilityToken, listRemoteCapabilityTokens } from "@/lib/remote-control-store";
import { REMOTE_CONTROL_SCOPES, type RemoteControlScope } from "@/lib/remote-control-types";
import { hasJsonContentType } from "@/lib/request-security";

export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json({ tokens: listRemoteCapabilityTokens() }, { headers: { "Cache-Control": "no-store" } });
}
export async function POST(request: Request) {
  try {
    if (!hasJsonContentType(request)) return Response.json({ error: "JSON content type is required." }, { status: 415 });
    const body = await request.json() as Record<string, unknown>;
    const scopes = Array.isArray(body.scopes) ? body.scopes.filter((scope): scope is RemoteControlScope => REMOTE_CONTROL_SCOPES.includes(scope as RemoteControlScope)) : [];
    const result = await createRemoteCapabilityToken({
      name: typeof body.name === "string" ? body.name : "Remote client",
      scopes,
      creationPolicy: body.creationPolicy,
      allowedSessionIds: Array.isArray(body.allowedSessionIds) ? body.allowedSessionIds.filter((id): id is string => typeof id === "string") : [],
      allowedRoomIds: Array.isArray(body.allowedRoomIds) ? body.allowedRoomIds.filter((id): id is string => typeof id === "string") : [],
      expiresAt: body.expiresAt === undefined ? undefined : Number(body.expiresAt),
    });
    return Response.json({ token: result.token, record: result.record, warning: "Store this token now. It will not be shown again." }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Unable to create token." }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
}
