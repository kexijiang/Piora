import { deleteRemoteCapabilityToken, revokeRemoteCapabilityToken } from "@/lib/remote-control-store";

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (new URL(request.url).searchParams.get("permanent") === "true") {
    const result = await deleteRemoteCapabilityToken(id);
    if (result !== "deleted") {
      return Response.json({ error: result === "active" ? "Revoke the token before deleting its record." : "Token record not found." }, {
        status: result === "active" ? 409 : 404,
        headers: { "Cache-Control": "no-store" },
      });
    }
    return Response.json({ deleted: true }, { headers: { "Cache-Control": "no-store" } });
  }
  const revoked = await revokeRemoteCapabilityToken(id);
  return Response.json({ revoked }, { status: revoked ? 200 : 404, headers: { "Cache-Control": "no-store" } });
}
