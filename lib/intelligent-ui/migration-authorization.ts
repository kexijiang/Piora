import type { PromptRunIdentity } from "../prompt-run-registry";

export interface UiMigrationAuthorization { readonly kind: "host-ui-migration" }
interface Binding {
  identity: PromptRunIdentity; proposalId: string; digest: string; choiceDigest: string;
  signal?: AbortSignal; isActive(): boolean; assertOwned(): void;
}
const bindings = new WeakMap<UiMigrationAuthorization, Binding>();

/** Only a trusted same-origin click handler creates this non-serializable grant. */
export function authorizeUiMigration(binding: Binding): UiMigrationAuthorization {
  const authorization = Object.freeze({ kind: "host-ui-migration" as const });
  bindings.set(authorization, { ...binding, identity: Object.freeze({ ...binding.identity }) });
  return authorization;
}
export function assertUiMigrationAuthorization(authorization: UiMigrationAuthorization,
  expected: { sessionId: string; proposalId: string; digest: string; choiceDigest: string }): PromptRunIdentity {
  const binding = bindings.get(authorization);
  if (!binding || binding.signal?.aborted || !binding.isActive() || binding.identity.sessionId !== expected.sessionId
    || binding.proposalId !== expected.proposalId || binding.digest !== expected.digest || binding.choiceDigest !== expected.choiceDigest) {
    throw new Error("UI migration confirmation is no longer authorized");
  }
  binding.assertOwned(); return { ...binding.identity };
}
export function revokeUiMigrationAuthorization(authorization: UiMigrationAuthorization): void { bindings.delete(authorization); }
