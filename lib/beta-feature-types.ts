/** Small shared contract; importing it never loads an experimental runtime. */
export interface BetaFeatures { intelligentUi: boolean }
export const DEFAULT_BETA_FEATURES: Readonly<BetaFeatures> = Object.freeze({ intelligentUi: false });
export const BETA_FEATURES = [{ id: "intelligentUi", label: "Intelligent UI", toolName: "piora_render_ui" }] as const;
export function betaFeatureSignature(features: BetaFeatures): string {
  return BETA_FEATURES.map(({ id }) => `${id}:${features[id]}`).join(";");
}
export function loadedBetaFeatureSignature(tools: readonly { name: string }[]): string {
  const names = new Set(tools.map(tool => tool.name));
  return BETA_FEATURES.map(({ id, toolName }) => `${id}:${names.has(toolName)}`).join(";");
}
