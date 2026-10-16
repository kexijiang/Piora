/** Clicking the tab the agent is using resumes following. Any other tab stops it. */
export function nextFollowState(clickedTabId: string, agentTabId: string | null | undefined): boolean {
  return typeof agentTabId === "string" && agentTabId.length > 0 && clickedTabId === agentTabId;
}
