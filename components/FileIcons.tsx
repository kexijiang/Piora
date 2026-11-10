// Selected Material Icon Theme SVGs; upstream source and MIT license live in public/file-icons.
import { AliIcon, getAdaptiveIconStrokeWidth } from "./AliIcon";

interface IconProps { size?: number }

// Kept for the fallback glyphs and callers that use the shared optical scale.
export function getFileIconStrokeWidth(size: number): number {
  return getAdaptiveIconStrokeWidth(size) * (14 / 24);
}

const FILE_TYPES: Record<string, string> = {
  ts: "typescript", mts: "typescript", cts: "typescript", tsx: "react_ts",
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "react",
  json: "json", jsonc: "json", jsonl: "json", md: "markdown", mdx: "markdown",
  css: "css", less: "css", scss: "sass", sass: "sass", html: "html", htm: "html",
  py: "python", pyi: "python", yaml: "yaml", yml: "yaml", toml: "toml",
  sh: "console", bash: "console", zsh: "console", fish: "console", ps1: "console", bat: "console", cmd: "console",
  rs: "rust", go: "go", sql: "database", db: "database", sqlite: "database",
  png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image", svg: "image", ico: "image", avif: "image", bmp: "image",
  pdf: "pdf", doc: "document", docx: "document", txt: "document", rtf: "document",
  xml: "xml", plist: "xml", vue: "vue", svelte: "svelte", java: "java", kt: "kotlin", kts: "kotlin",
  c: "c", h: "c", cpp: "cpp", hpp: "cpp", cc: "cpp", cs: "csharp",
  graphql: "graphql", gql: "graphql", tf: "terraform", hcl: "terraform", lock: "lock",
  zip: "zip", tar: "zip", gz: "zip", tgz: "zip", rar: "zip", "7z": "zip",
  mp4: "video", webm: "video", mov: "video", mp3: "audio", wav: "audio", ogg: "audio", flac: "audio",
  woff: "font", woff2: "font", ttf: "font", otf: "font",
};
const FOLDER_TYPES: Record<string, string> = {
  node_modules: "node", src: "src", source: "src", lib: "lib", app: "app", apps: "app",
  test: "test", tests: "test", spec: "test", specs: "test", __tests__: "test", __mocks__: "test",
  ".git": "git", ".github": "github", config: "config", ".config": "config", configs: "config",
  dist: "dist", build: "dist", out: "dist", ".next": "dist", target: "dist",
  components: "components", docs: "docs", doc: "docs", public: "public",
  images: "images", img: "images", assets: "resource", resources: "resource",
  api: "api", scripts: "scripts",
};

function basename(name: string): string { return name.replaceAll("\\", "/").split("/").filter(Boolean).pop()?.toLowerCase() ?? ""; }

export function resolveFileIcon(name: string): string | null {
  const lower = basename(name);
  if (lower === "dockerfile" || lower.startsWith("dockerfile.") || /^(?:docker-)?compose\.ya?ml$/.test(lower)) return "docker";
  if (lower === ".env" || lower.startsWith(".env.")) return "tune";
  if (lower.startsWith(".git")) return "git";
  if (["package.json", "package-lock.json", "npm-shrinkwrap.json", ".npmrc", ".nvmrc"].includes(lower)) return "nodejs";
  if (["yarn.lock", "bun.lock", "bun.lockb", "pnpm-lock.yaml", "cargo.lock"].includes(lower)) return "lock";
  if (/\.config\.[cm]?[jt]s$/.test(lower) || /^(?:\.eslintrc|\.prettierrc|tsconfig(?:\.[\w-]+)?\.json|jsconfig\.json)/.test(lower)) return "settings";
  if (/\.d\.[cm]?ts$/.test(lower)) return "typescript";
  const ext = lower.includes(".") ? lower.split(".").pop()! : "";
  return FILE_TYPES[ext] ?? null;
}

function MaterialIcon({ icon, size = 14 }: IconProps & { icon: string }) {
  const light = icon === "toml" ? "toml_light" : icon;
  return <svg width={size} height={size} viewBox="0 0 16 16" className="material-file-icon" data-file-icon={icon} aria-hidden="true" focusable="false" style={{ display: "block", flexShrink: 0 }}>
    <use href={`/file-icons/material.svg#${light}`} className={light !== icon ? "material-icon-light" : undefined} />
    {light !== icon ? <use href={`/file-icons/material.svg#${icon}`} className="material-icon-dark" /> : null}
  </svg>;
}

export function FolderIcon({ size = 14, open = false, name = "" }: IconProps & { open?: boolean; name?: string }) {
  const kind = FOLDER_TYPES[basename(name)];
  return <MaterialIcon icon={`${kind ? `folder-${kind}` : "folder"}${open ? "-open" : ""}`} size={size} />;
}
export function GenericFileIcon({ size = 14 }: IconProps) {
  return <AliIcon name="file" size={size} style={{ color: "var(--text-dim)" }} />;
}
export function getFileIcon(name: string, size = 14): React.ReactNode {
  const icon = resolveFileIcon(name);
  return icon ? <MaterialIcon icon={icon} size={size} /> : <GenericFileIcon size={size} />;
}
