import { resolveLocalFileHref, resolveWorkspaceFilePath } from "./file-links";

export interface FileReference { path: string; line?: number; column?: number }
export const FILE_REFERENCE_HREF = "#piora-file=";

/** Location suffixes are metadata; a Windows drive colon belongs to the path. */
export function parseFileReference(value: string): FileReference | null {
  if (/[\x00-\x1f]/.test(value)) return null;
  let path = value.trim();
  if (!path || /[\x00-\x1f]/.test(path)) return null;
  if (/^\/(?:api|_next)\//.test(path)) return null;
  const suffix = /(?::([1-9]\d*)(?::([1-9]\d*))?|#L([1-9]\d*)(?:C([1-9]\d*))?)$/.exec(path);
  const line = suffix ? Number(suffix[1] ?? suffix[3]) : undefined;
  const column = suffix?.[2] || suffix?.[4] ? Number(suffix[2] ?? suffix[4]) : undefined;
  if (line !== undefined && (!Number.isSafeInteger(line) || line > 2147483647) || column !== undefined && (!Number.isSafeInteger(column) || column > 2147483647)) return null;
  if (suffix) path = path.slice(0, suffix.index);
  if (/^[a-z][\w+.-]*:/i.test(path) && !/^[a-z]:[\\/]/i.test(path) && !/^file:\/\//i.test(path)) return null;
  if (/[?#]/.test(path) || path.startsWith("//") || path.includes("@") && !/[\\/]/.test(path)) return null;
  const filename = path.replaceAll("\\", "/").split("/").pop() ?? "";
  if (!/\.[a-z][\w+-]{0,12}$/i.test(filename) && !/^(?:Dockerfile|Makefile|CMakeLists\.txt|\.gitignore|\.env)$/i.test(filename)) return null;
  return { path, ...(line ? { line } : {}), ...(column ? { column } : {}) };
}

export function formatFileReference({ path, line, column }: FileReference): string {
  return `${path}${line ? `:${line}${column ? `:${column}` : ""}` : ""}`;
}

export function resolveFileReferenceTarget(value: string, cwd?: string): { filePath: string; line?: number; column?: number } | null {
  const reference = parseFileReference(value)
    ?? (value.startsWith("//") ? parseFileReference("\\\\" + value.slice(2).replaceAll("/", "\\")) : null)
    ?? { path: value };
  if (!cwd && !/^(?:[a-z]:[\\/]|[\\/]|file:\/\/)/i.test(reference.path)) return null;
  if (/^[a-z][\w+.-]*:/i.test(reference.path) && !/^[a-z]:[\\/]/i.test(reference.path) && !/^file:\/\//i.test(reference.path)) return null;
  const filePath = /^file:\/\//i.test(reference.path) ? resolveLocalFileHref(reference.path, cwd) : resolveWorkspaceFilePath(reference.path, cwd);
  return filePath ? { filePath, ...(reference.line ? { line: reference.line } : {}), ...(reference.column ? { column: reference.column } : {}) } : null;
}

const bareSourceFile = /\.(?:[cm]?[jt]sx?|ets|vue|svelte|rs|go|py|java|kt|swift|[ch](?:pp|xx)?|cs|jsonc?|ya?ml|toml|md|txt|sql|xml|sh|ps1|gradle|proto|properties)$/i;
export function looksLikeFileReference(value: string): boolean {
  const reference = parseFileReference(value);
  return Boolean(reference && (reference.line || /[\\/]/.test(reference.path) || bareSourceFile.test(reference.path)));
}

type Node = { type: string; value?: string; url?: string; title?: string; lang?: string | null; children?: Node[] };
const token = /[A-Za-z]:[\\/][^\r\n<>\[\]{}()"'`，。！？；：、]+?\.[A-Za-z][\w+-]{0,12}:[1-9]\d*(?::[1-9]\d*)?(?=$|[\s<>\[\]{}()"'`，。！？；：、,.!;])|[^\s<>\[\]{}()"'`，。！？；：、]+?\.[A-Za-z][\w+-]{0,12}(?::[1-9]\d*(?::[1-9]\d*)?|#L[1-9]\d*(?:C[1-9]\d*)?)?(?=$|[\s<>\[\]{}()"'`，。！？；：、,.!;])/g;
const link = (value: string, child: Node): Node => ({ type: "link", url: FILE_REFERENCE_HREF + encodeURIComponent(value), title: value, children: [child] });

/** Link prose and inline-code references, preserving code examples and existing links. */
export function remarkFileReferences() {
  return (tree: Node) => {
    const walk = (parent: Node) => {
      if (!parent.children || ["link", "linkReference", "image", "definition", "html"].includes(parent.type)) return;
      parent.children = parent.children.flatMap((node): Node[] => {
        const value = node.value ?? "";
        if (node.type === "link" && node.url) {
          let target = node.url;
          try { target = decodeURIComponent(target); } catch { /* Keep malformed escapes literal. */ }
          if (parseFileReference(target)) { node.url = FILE_REFERENCE_HREF + encodeURIComponent(target); node.title ??= target; }
          return [node];
        }
        if (node.type === "inlineCode" && looksLikeFileReference(value)) return [link(value, node)];
        if (node.type === "code" && (!node.lang || /^(?:text|plaintext)$/.test(node.lang))) {
          const lines = value.split(/\r?\n/);
          if (lines.length && lines.every(line => looksLikeFileReference(line))) return [{ type: "paragraph", children: lines.flatMap((line, index) => [...(index ? [{ type: "break" }] : []), link(line, { type: "inlineCode", value: line })]) }];
        }
        if (node.type !== "text") { walk(node); return [node]; }
        const result: Node[] = []; let at = 0;
        for (const match of value.matchAll(token)) {
          if (!looksLikeFileReference(match[0])) continue;
          if (match.index > at) result.push({ type: "text", value: value.slice(at, match.index) });
          result.push(link(match[0], { type: "text", value: match[0] })); at = match.index + match[0].length;
        }
        if (!result.length) return [node];
        if (at < value.length) result.push({ type: "text", value: value.slice(at) });
        return result;
      });
    };
    walk(tree);
  };
}
