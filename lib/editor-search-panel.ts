import { SearchQuery, closeSearchPanel, findNext, findPrevious, getSearchQuery, replaceAll, replaceNext, setSearchQuery } from "@codemirror/search";
import type { EditorView, Panel, ViewUpdate } from "@codemirror/view";

export const editorSearchChinese = {
  "Find": "查找", "Replace": "替换", "Find and replace": "查找与替换", "Match case": "区分大小写", "Whole word": "全词匹配", "Regular expression": "正则表达式",
  "Previous match": "上一个匹配", "Next match": "下一个匹配", "Close search": "关闭查找", "Replace next": "替换当前", "Replace all": "全部替换",
  "No results": "无匹配", "Invalid regular expression": "正则表达式无效", "Type to search": "输入查找内容", "matches": "处匹配",
};

/** Shared inline panel: search state belongs to the editor and replacements retain undo history. */
export function createEditorSearchPanel(view: EditorView): Panel {
  const dom = document.createElement("div");
  dom.className = "piora-search";
  dom.setAttribute("role", "search");
  const phrase = (value: string) => view.state.phrase(value);
  const labels: Array<{ element: HTMLElement; key: string; text: boolean }> = [];
  function button(key: string, text: string, run: () => void) {
    const element = document.createElement("button"); element.type = "button"; element.textContent = text;
    element.addEventListener("click", run); labels.push({ element, key, text: text === key }); return element;
  }
  function input(key: string, name: string) {
    const element = document.createElement("input"); element.type = "text"; element.name = name;
    element.autocomplete = "off"; element.spellcheck = false;
    labels.push({ element, key, text: false }); return element;
  }
  const row = document.createElement("div"); row.className = "piora-search-row";
  const replaceRow = document.createElement("div"); replaceRow.className = "piora-search-row piora-replace-row";
  const field = input("Find", "search"); field.setAttribute("main-field", "true");
  const replacement = input("Replace", "replace");
  const count = document.createElement("span"); count.className = "piora-search-count"; count.setAttribute("role", "status"); count.setAttribute("aria-live", "polite");
  const opts = document.createElement("div"); opts.className = "piora-search-options";
  const cases = button("Match case", "Aa", () => toggle(cases));
  const words = button("Whole word", "ab", () => toggle(words));
  const regex = button("Regular expression", ".*", () => toggle(regex));
  words.className = "piora-search-word";
  for (const option of [cases, words, regex]) option.setAttribute("aria-pressed", "false");
  const previous = button("Previous match", "↑", () => { findPrevious(view); });
  const next = button("Next match", "↓", () => { findNext(view); });
  const close = button("Close search", "×", () => { closeSearchPanel(view); view.focus(); });
  const replaceOne = button("Replace next", "Replace next", () => { replaceNext(view); field.focus(); });
  const replaceEvery = button("Replace all", "Replace all", () => { replaceAll(view); field.focus(); });
  opts.append(cases, words, regex);
  row.append(field, opts, previous, next, close);
  replaceRow.append(replacement, replaceOne, replaceEvery);
  dom.append(row, replaceRow, count);
  function toggle(element: HTMLButtonElement) { element.setAttribute("aria-pressed", String(element.getAttribute("aria-pressed") !== "true")); commit(); }
  function commit() {
    const query = new SearchQuery({ search: field.value, replace: replacement.value, caseSensitive: cases.getAttribute("aria-pressed") === "true", wholeWord: words.getAttribute("aria-pressed") === "true", regexp: regex.getAttribute("aria-pressed") === "true", literal: true });
    view.dispatch({ effects: setSearchQuery.of(query) });
  }
  field.addEventListener("input", commit); replacement.addEventListener("input", commit);
  dom.addEventListener("keydown", (event) => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeSearchPanel(view); view.focus(); }
    if (event.key === "Enter" && event.target instanceof HTMLInputElement) {
      event.preventDefault(); event.stopPropagation();
      if (event.target === replacement) replaceNext(view);
      else if (event.shiftKey) findPrevious(view); else findNext(view);
    }
  });
  let matches: Array<{ from: number; to: number }> = [];
  let truncated = false;
  function refresh(recount: boolean) {
    const query = getSearchQuery(view.state);
    if (field.value !== query.search) field.value = query.search;
    if (replacement.value !== query.replace) replacement.value = query.replace;
    cases.setAttribute("aria-pressed", String(query.caseSensitive)); words.setAttribute("aria-pressed", String(query.wholeWord)); regex.setAttribute("aria-pressed", String(query.regexp));
    for (const { element, key, text } of labels) { element.setAttribute("aria-label", phrase(key)); element.title = phrase(key); if (text) element.textContent = phrase(key); if (element instanceof HTMLInputElement) element.placeholder = phrase(key); }
    dom.setAttribute("aria-label", phrase("Find and replace"));
    if (recount) {
      matches = []; truncated = false;
      if (query.valid && query.search) {
        const cursor = query.getCursor(view.state.doc);
        for (let found = cursor.next(); !found.done; found = cursor.next()) { if (matches.length === 10_000) { truncated = true; break; } matches.push({ from: found.value.from, to: found.value.to }); }
      }
    }
    const invalid = !!query.search && !query.valid;
    field.setAttribute("aria-invalid", String(invalid));
    const selection = view.state.selection.main;
    const current = matches.findIndex((match) => match.from === selection.from && match.to === selection.to);
    count.textContent = invalid ? phrase("Invalid regular expression") : !query.search ? phrase("Type to search") : !matches.length ? phrase("No results") : `${current < 0 ? "–" : current + 1} / ${matches.length}${truncated ? "+" : ""} ${phrase("matches")}`;
    count.dataset.error = String(invalid);
    for (const command of [previous, next, replaceOne, replaceEvery]) command.disabled = !query.valid || !matches.length;
  }
  refresh(true);
  return { dom, top: true, mount() { field.focus(); field.select(); }, update(update: ViewUpdate) {
    refresh(update.docChanged || !getSearchQuery(update.startState).eq(getSearchQuery(update.state)));
  } };
}
