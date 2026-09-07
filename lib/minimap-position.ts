export function minimapPreviewTop(anchor: number, panelHeight: number, containerHeight: number): number {
  return Math.max(8, Math.min(anchor - 22, containerHeight - panelHeight - 8));
}
