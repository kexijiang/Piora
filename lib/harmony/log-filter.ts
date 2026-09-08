export function createLogMatcher(query: string, regex: boolean): { matches: (text: string) => boolean; error: string | null } {
  if (!query) return { matches: () => true, error: null };
  if (!regex) { const needle = query.toLocaleLowerCase(); return { matches: (text) => text.toLocaleLowerCase().includes(needle), error: null }; }
  try {
    const pattern = new RegExp(query, "i");
    return { matches: (text) => pattern.test(text), error: null };
  } catch (error) { return { matches: () => false, error: error instanceof Error ? error.message : String(error) }; }
}
