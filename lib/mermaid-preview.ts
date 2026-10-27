export interface DiagramSize { width: number; height: number }
export interface Diagram extends DiagramSize { svg: string }

/** Bound retained source/SVG memory; concurrent mounts share one render. */
export function createDiagramCache(render: (key: string) => Promise<Diagram>, maxEntries = 32, maxCharacters = 4_000_000) {
  const ready = new Map<string, Diagram>();
  const pending = new Map<string, Promise<Diagram>>();
  let characters = 0;
  return {
    peek: (key: string) => ready.get(key),
    load(key: string): Promise<Diagram> {
      const cached = ready.get(key);
      if (cached) {
        ready.delete(key);
        ready.set(key, cached);
        return Promise.resolve(cached);
      }
      const existing = pending.get(key);
      if (existing) return existing;
      const request = Promise.resolve().then(() => render(key)).then(result => {
        const size = key.length + result.svg.length;
        if (size <= maxCharacters) {
          ready.set(key, result);
          characters += size;
          while (ready.size > maxEntries || characters > maxCharacters) {
            const oldest = ready.keys().next().value!;
            characters -= oldest.length + ready.get(oldest)!.svg.length;
            ready.delete(oldest);
          }
        }
        return result;
      }).finally(() => pending.delete(key));
      pending.set(key, request);
      return request;
    },
  };
}

export function fitDiagram(size: DiagramSize, viewport: DiagramSize): number {
  return Math.min(1, viewport.width / size.width, viewport.height / size.height);
}

/** Cached SVGs may coexist in several rows and in a dialog. Scope every ID,
 * including Mermaid's node/marker IDs, CSS selectors and accessible references. */
export function scopeDiagramSvg(markup: string, prefix: string): string {
  const doc = new DOMParser().parseFromString(markup, "image/svg+xml");
  const ids = new Map(Array.from(doc.querySelectorAll("[id]"), node => [node.id, `${prefix}-${node.id}`]));
  const replaceReferences = (value: string) => value.replace(/#([\w:-]+)/g, (match, id: string) => ids.has(id) ? `#${ids.get(id)}` : match);
  for (const node of doc.querySelectorAll("*")) {
    for (const attribute of Array.from(node.attributes)) {
      if (attribute.name === "id") attribute.value = ids.get(attribute.value)!;
      else if (attribute.name === "aria-labelledby" || attribute.name === "aria-describedby") {
        attribute.value = attribute.value.split(/\s+/).map(id => ids.get(id) ?? id).join(" ");
      } else attribute.value = replaceReferences(attribute.value);
    }
    if (node.localName === "style") node.textContent = replaceReferences(node.textContent ?? "");
  }
  return new XMLSerializer().serializeToString(doc.documentElement);
}
