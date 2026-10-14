import { useMemo } from "react";
import { resolveLocalFileHref } from "@/lib/file-links";
import { createLocalFileLinkClickHandler } from "@/lib/file-link-click";
import { detectUserMessageLinks } from "@/lib/user-message-links";

export function UserMessageText({ text, cwd, onOpenFile }: { text: string; cwd?: string; onOpenFile?: (filePath: string) => void }) {
  const segments = useMemo(() => detectUserMessageLinks(text), [text]);
  return (
    <div className="user-message-text">
      {segments.map((segment, index) => {
        if (segment.type === "url") {
          return <a key={index} className="user-message-link" href={segment.href} target="_blank" rel="noopener noreferrer">{segment.text}</a>;
        }
        if (segment.type === "path" && onOpenFile && segment.kind !== "home") {
          // Same resolution + open behavior as Markdown links in assistant messages.
          const filePath = resolveLocalFileHref(segment.path, cwd);
          if (filePath) {
            return <a key={index} className="user-message-link" href={segment.path} onClick={createLocalFileLinkClickHandler(filePath, onOpenFile)}>{segment.text}</a>;
          }
        }
        return segment.text;
      })}
    </div>
  );
}
