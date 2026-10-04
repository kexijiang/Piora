/** Package declarations are untrusted metadata, not a verified signing identity. */
export interface HarmonyHapPreview {
  filename: string;
  size: number;
  sha256: string;
  bundleName: string;
  versionName?: string;
  versionCode?: number;
  moduleName?: string;
  moduleType?: string;
  abilities: string[];
  deviceTypes: string[];
  permissions: string[];
  signature: "unverified";
}
