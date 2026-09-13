import type {RemoteCreationPolicy} from "./remote-creation-policy";
export const REMOTE_CONTROL_SCOPES = [
  "capabilities.read",
  "session.create",
  "session.state.read",
  "session.history.read",
  "session.tools.read",
  "session.message.send",
  "session.steer",
  "session.abort",
  "session.events.read",
  "session.messages.read",
] as const;

export type RemoteControlScope = (typeof REMOTE_CONTROL_SCOPES)[number];

export interface RemoteCapabilityTokenRecord {
  id: string;
  tokenHash: string;
  name: string;
  scopes: RemoteControlScope[];
  allowedSessionIds: string[];
  allowedRoomIds: string[];
  createdAt: number;
  expiresAt?: number;
  revokedAt?: number;
  lastUsedAt?: number;
  creationPolicy?: RemoteCreationPolicy;
}
export interface PublicRemoteCapabilityToken extends Omit<RemoteCapabilityTokenRecord, "tokenHash"> {
  active: boolean;
}

export interface RemoteCapabilityPrincipal {
  tokenId: string;
  expectedServerId?: string;
  scopes: ReadonlySet<RemoteControlScope>;
  allowedSessionIds: ReadonlySet<string>;
  allowedRoomIds: ReadonlySet<string>;
  creationPolicy?: RemoteCreationPolicy;
}
