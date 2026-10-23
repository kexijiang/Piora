import type { CollaborationRoomV3 } from "./team-types";

/** Reused chats remain visible; only sessions owned by a group live inside it. */
export function getManagedRoomSessionIds(rooms: CollaborationRoomV3[]): Set<string> {
  return new Set(rooms.flatMap((room) => room.members
    .filter((member) => member.binding.managedByPiora)
    .map((member) => member.binding.sessionId)));
}
