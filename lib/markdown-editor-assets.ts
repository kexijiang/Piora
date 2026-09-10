export const MARKDOWN_EDITOR_CDN = "/vendor/vditor/4.0.0";
const scripts = new Map<string, Promise<void>>();
function script(file: string, id: string) {
  const existing = scripts.get(id);
  if (existing) return existing;
  const pending = new Promise<void>((resolve, reject) => {
    if (document.getElementById(id)) { resolve(); return; }
    const element = document.createElement("script");
    element.src = `${MARKDOWN_EDITOR_CDN}/dist/js/${file}`;
    element.onload = () => { element.id = id; resolve(); };
    element.onerror = () => { element.remove(); scripts.delete(id); reject(new Error("编辑器资源加载失败，请重试。")); };
    document.head.appendChild(element);
  });
  scripts.set(id, pending);
  return pending;
}
/** Preload so failures and StrictMode cleanup are safe before construction. */
export async function loadMarkdownEditorAssets() {
  await Promise.all([
    script("lute/lute.min.js", "vditorLuteScript"),
    script("i18n/zh_CN.js", "vditorI18nScriptzh_CN"),
    script("icons/ant.js", "vditorIconScript"),
  ]);
}
