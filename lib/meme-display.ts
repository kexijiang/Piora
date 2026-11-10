interface MemeHit { path?: string; caption: string; markdown?: string; error?: string }
interface MemeResult { message?: string; hits?: MemeHit[]; displayMarkdown?: string }
interface CatalogImage { path: string; url: string }

function normalizedPath(value: string): string {
  const normalized = value.replaceAll("\\", "/");
  return /^[a-z]:\//i.test(normalized) ? normalized.toLowerCase() : normalized;
}

/** Only emit display markup after the immutable receipt has been saved. */
export async function prepareMemeDisplay<T extends MemeResult>(
  value: T,
  catalog: CatalogImage[],
  capture: (url: string, caption: string) => Promise<string>,
): Promise<T> {
  const markdown: string[] = [];
  for (const hit of value.hits ?? []) {
    delete hit.markdown;
    delete hit.error;
    const hitPath = normalizedPath(hit.path ?? "");
    const exact = catalog.filter(row => normalizedPath(row.path) === hitPath && hitPath);
    const candidates = exact.length ? exact : catalog.filter(row => {
      if (!hitPath || !row.url.startsWith("/dsh-memes/")) return false;
      try {
        const relative = decodeURIComponent(row.url.slice("/dsh-memes/".length));
        return hitPath.endsWith(`/${relative}`) || hitPath === relative;
      } catch { return false; }
    });
    if (candidates.length !== 1) {
      hit.error = "表情图片未能唯一匹配图库，请重新选择。";
      continue;
    }
    try {
      hit.markdown = await capture(candidates[0].url, hit.caption);
      markdown.push(hit.markdown);
    } catch {
      hit.error = "表情图片保存失败，请重试。";
    }
  }
  if (value.hits?.length) {
    value.displayMarkdown = markdown.join("\n\n");
    value.message = value.displayMarkdown || "没有可发送的表情图片，请重试或更换表情。";
  }
  return value;
}
