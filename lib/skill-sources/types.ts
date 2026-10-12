export type SkillSourceKind = "git" | "skills-sh" | "skillhub" | "clawhub";
export type SourceState = "ready" | "disabled" | "auth-required" | "error" | "unsupported";
export interface SkillSource {
  id: string;
  name: string;
  kind: SkillSourceKind;
  url: string;
  ref?: string;
  subdirectory?: string;
  enabled: boolean;
  builtin?: boolean;
  hasCredential?: boolean;
  lastRefreshedAt?: string;
  state?: SourceState;
  capabilities?: { browse: boolean; search: boolean };
}
export interface SourceInput {
  name: string;
  kind: SkillSourceKind;
  url: string;
  ref?: string;
  subdirectory?: string;
  enabled?: boolean;
  credential?: string;
  clearCredential?: boolean;
}
export interface CatalogSkill {
  sourceId: string;
  id: string;
  name: string;
  description?: string;
  publisher?: string;
  url?: string;
  version?: string;
  downloads?: number;
}
export interface SkillDetail extends CatalogSkill {
  readme: string;
  files: string[];
  requirements?: string;
  pinned?: boolean;
}
export interface CatalogPage {
  sourceId: string;
  state: SourceState;
  items: CatalogSkill[];
  nextCursor?: string;
  fetchedAt?: string;
  stale?: boolean;
  error?: string;
}
export interface SkillBundle {
  detail: SkillDetail;
  files: Map<string, Buffer>;
  executableFiles?: string[];
}
export class SkillSourceError extends Error {
  constructor(public code: string, message: string, public status = 400) { super(message); }
}
