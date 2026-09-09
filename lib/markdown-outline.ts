import { markdownLanguage } from "@codemirror/lang-markdown";

/** Parse the Markdown tree so headings inside fenced code never enter the outline. */
export function markdownOutline(content: string): Array<{ offset: number; level: number; title: string }> {
  const result: Array<{ offset: number; level: number; title: string }> = [];
  markdownLanguage.parser.parse(content).iterate({ enter(node) {
    const match = /^(?:ATX|Setext)Heading([1-6])$/.exec(node.name);
    if (!match) return;
    const title = content.slice(node.from, node.to).split(/\r?\n/)[0].replace(/^#{1,6}\s+/, "").replace(/\s+#+\s*$/, "").trim();
    result.push({ offset: node.from, level: Number(match[1]), title });
  } });
  return result;
}
