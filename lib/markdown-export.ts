import JSZip from "jszip";

const localImage = /\/api\/companion\/library\/image\?id=([a-zA-Z0-9_%.-]+)(?:&(?:amp;)?v=\d+)?/g;
const extensions: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };

/** Bundle only explicitly referenced local images. A missing attachment fails
 * the export visibly instead of producing a silently broken document. */
export async function exportMarkdown(title: string, markdown: string, readImage: (url: string) => Promise<Response> = fetch) {
  const filename = (title.trim() || "未命名文档").replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/[. ]+$/, "") || "未命名文档";
  const references = [...markdown.matchAll(localImage)];
  if (!references.length) return { filename: `${filename}.md`, blob: new Blob([markdown], { type: "text/markdown;charset=utf-8" }) };
  const zip = new JSZip();
  const paths = new Map<string, string>();
  for (const match of references) {
    const id = match[1];
    if (paths.has(id)) continue;
    const response = await readImage(`/api/companion/library/image?id=${id}`);
    if (!response.ok) throw new Error("有图片读取失败，请确认图片仍在中转站中，再重试导出。");
    const blob = await response.blob();
    const extension = extensions[blob.type];
    if (!extension || blob.size > 8 * 1024 * 1024) throw new Error("图片格式或大小不受支持，未导出不完整文档。");
    const name = `images/image-${paths.size + 1}.${extension}`;
    paths.set(id, name); zip.file(name, await blob.arrayBuffer());
  }
  zip.file(`${filename}.md`, markdown.replace(localImage, (_url, id: string) => paths.get(id)!));
  return { filename: `${filename}.zip`, blob: await zip.generateAsync({ type: "blob" }) };
}
