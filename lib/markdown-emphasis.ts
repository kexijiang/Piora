import type { Element, Root, RootContent } from "hast";

function emphasisText(node: Element): string {
  const text: string[] = [];
  const pending: RootContent[] = [...node.children].reverse();
  while (pending.length) {
    const child = pending.pop()!;
    if (child.type === "text") text.push(child.value);
    else if (child.type === "element") pending.push(...[...child.children].reverse());
  }
  return text.join("").replace(/\s+/g, " ").trim();
}

/** Assign colors within a reply, after sanitization, without render-time state.
 * Repeated labels reuse their color; appending streamed text leaves earlier colors stable.
 */
export function rehypeAssistantEmphasis() {
  return (tree: Root) => {
    const colors = new Map<string, number>();
    const pending: RootContent[] = [...tree.children].reverse();
    while (pending.length) {
      const node = pending.pop()!;
      if (node.type !== "element") continue;
      // These elements already have their own visual meaning.
      if (/^(?:pre|code|mark|em|h[1-6])$/.test(node.tagName)) continue;
      if (node.tagName === "strong" || node.tagName === "b") {
        const text = emphasisText(node);
        if (text) {
          const color = colors.get(text) ?? colors.size % 3;
          colors.set(text, color);
          node.properties.dataEmphasisColor = color;
        }
        // Nested bold belongs to the same emphasis, not a new conclusion.
        continue;
      }
      pending.push(...[...node.children].reverse());
    }
  };
}
