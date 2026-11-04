import type { ExtensionUiRequest } from "./types";

export interface RoomUiRequest {
  sessionId: string;
  memberId: string;
  memberName: string;
  request: ExtensionUiRequest;
}

export function roomRequestKey(item: RoomUiRequest): string {
  return JSON.stringify([item.sessionId, item.request.id]);
}

export function isPendingRoomRequest(item: RoomUiRequest, now: number): boolean {
  const request = item.request;
  if (request.method === "custom") return !request.closed;
  return ["confirm", "select", "input", "editor", "request_user_input"].includes(request.method)
    && (!("expiresAt" in request) || !request.expiresAt || request.expiresAt > now);
}
