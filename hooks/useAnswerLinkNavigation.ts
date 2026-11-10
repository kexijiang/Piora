"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { normalizeAnswerLink, type BrowserNavigationRequest } from "@/lib/answer-links";

/** Retain quick successive clicks while the lazily mounted browser starts. */
export function useAnswerLinkNavigation(workspaceKey: string, showBrowser: () => void) {
  const [requests, setRequests] = useState<Array<BrowserNavigationRequest & { workspaceKey: string }>>([]);
  const nextId = useRef(0);
  useEffect(() => {
    setRequests(current => current.filter(request => request.workspaceKey === workspaceKey));
  }, [workspaceKey]);
  const openLink = useCallback((href: string) => {
    const url = normalizeAnswerLink(href);
    if (!url) return;
    // These IDs only deduplicate this mounted UI queue; HTTP installations do
    // not necessarily expose the secure-context-only crypto.randomUUID API.
    const id = `answer-link-${++nextId.current}`;
    setRequests(current => [...current.filter(request => request.workspaceKey === workspaceKey), {
      id, url, newTab: true, workspaceKey,
    }]);
    showBrowser();
  }, [showBrowser, workspaceKey]);
  const consume = useCallback((id: string) => {
    setRequests(current => current.filter(request => request.id !== id));
  }, []);
  return { openLink, request: requests.find(request => request.workspaceKey === workspaceKey), consume };
}
