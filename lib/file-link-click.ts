import type { MouseEvent } from "react";

/**
 * Shared click handler for in-app local file links. Plain left clicks open the
 * file inside Piora; modified clicks and non-self targets keep browser behavior.
 */
export function createLocalFileLinkClickHandler(filePath: string, openFile: (filePath: string) => void) {
  return (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const target = event.currentTarget.getAttribute("target");
    if (target && target !== "_self") return;
    event.preventDefault();
    openFile(filePath);
  };
}
