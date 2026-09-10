import type Vditor from "vditor";

/** GFM has no image dimensions. Represent sized images as standard HTML in
 * Markdown, while keeping a normal editable image in the WYSIWYG surface. */
function preserveDimensions(html: string) {
  if (!/<img\b[^>]*\bwidth=/i.test(html)) return html;
  const container = document.createElement("div"); container.innerHTML = html;
  container.querySelectorAll<HTMLImageElement>("img[width]").forEach((image) => {
    const width = Number(image.getAttribute("width"));
    if (!Number.isFinite(width) || width <= 0) return;
    const clean = document.createElement("img");
    for (const name of ["src", "alt", "title"]) { const value = image.getAttribute(name); if (value !== null) clean.setAttribute(name, value); }
    clean.setAttribute("width", String(width));
    const code = document.createElement("code"); code.dataset.type = "html-inline"; code.textContent = `\u200b${clean.outerHTML}`;
    image.replaceWith(code);
  });
  return container.innerHTML;
}

function editableImages(html: string) {
  if (!html.includes("html-inline") && !html.includes("html-block")) return html;
  const container = document.createElement("div"); container.innerHTML = html;
  container.querySelectorAll<HTMLElement>('code[data-type="html-inline"], div[data-type="html-block"]').forEach((element) => {
    const code = element.tagName === "CODE" ? element : element.querySelector("pre > code");
    const text = code?.textContent?.replace(/^\u200b/, "").trim() ?? "";
    // Only an isolated, sized image is promoted. Scripts / arbitrary raw HTML
    // stay under the editor's normal sanitizer and source rendering.
    if (!/^<img\s[^<>]+\/?\s*>$/i.test(text)) return;
    const template = document.createElement("template"); template.innerHTML = text;
    const image = template.content.firstElementChild;
    if (!(image instanceof HTMLImageElement) || !image.hasAttribute("width")) return;
    const safe = document.createElement("img");
    const src = image.getAttribute("src") ?? "";
    if (!/^(https?:\/\/|\/api\/companion\/library\/image\?|data:image\/(?:png|jpeg|webp|gif);base64,)/i.test(src)) return;
    for (const attr of ["src", "alt", "title"]) { const value = image.getAttribute(attr); if (value !== null) safe.setAttribute(attr, value); }
    const width = Number(image.getAttribute("width"));
    if (!Number.isFinite(width) || width <= 0) return;
    safe.width = Math.min(2400, width);
    if (element.tagName === "DIV") { const paragraph = document.createElement("p"); paragraph.dataset.block = "0"; paragraph.appendChild(safe); element.replaceWith(paragraph); }
    else element.replaceWith(safe);
  });
  return container.innerHTML;
}

/** Adapter for the pinned Vditor 4 / Lute DOM contract, tested by roundtrips. */
export function preserveMarkdownImageSizes(lute: NonNullable<Vditor["vditor"]["lute"]>) {
  const toMarkdown = lute.VditorDOM2Md.bind(lute);
  const toHTML = lute.VditorDOM2HTML.bind(lute);
  const toDOM = lute.Md2VditorDOM.bind(lute);
  const spin = lute.SpinVditorDOM.bind(lute);
  lute.VditorDOM2Md = (html) => toMarkdown(preserveDimensions(html));
  lute.VditorDOM2HTML = (html) => toHTML(preserveDimensions(html));
  lute.Md2VditorDOM = (markdown) => editableImages(toDOM(markdown));
  lute.SpinVditorDOM = (html) => editableImages(spin(preserveDimensions(html)));
}
