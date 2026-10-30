import { evaluateExpression, initialState, isUiId, validateState, validateSurface, type UiExpression, type UiNode, type UiState, type UiSurface, type UiValue } from "./protocol";

/** Surface and answer-output envelope versions are separate protocol spaces. */
export const UI_RICH_SURFACE_VERSION = 2 as const;
export const UI_RICH_LIMITS = Object.freeze({
  characters: 64_000, jsonValues: 20_000, jsonDepth: 32,
  nodes: 64, blocks: 16, cards: 16, cardsPerComparison: 8, totalElements: 96,
  rows: 200, filters: 32, filtersPerTable: 8, layoutReferences: 128,
  expressionNodes: 4096, expressionDepth: 12, snapshotCharacters: 128_000,
  textParts: 12,
});

export interface RichFilter {
  /** Zero-based index into the referenced table's columns. */
  column: number;
  controlId: string;
  operator: "equals" | "contains" | "gte" | "lte";
  /** An explicit selectable value that disables this predicate (for example All). */
  inactiveValue?: UiValue;
}
export type RichBlock =
  | { id: string; type: "group"; title: string; columns: 1 | 2 | 3; nodeIds: string[] }
  | { id: string; type: "comparison"; title: string; cards: Array<{ id: string; title: string; nodeIds: string[] }> }
  | { id: string; type: "filteredTable"; title: string; tableId: string; filters: RichFilter[] };
export interface UiRichSurface {
  version: 2; id: string; revision: number; title: string;
  nodes: UiRichNode[];
  /** Every node is placed exactly once. Groups and cards never nest. */
  layout: RichBlock[];
}
export type UiRichNode = UiNode | { id: string; type: "dynamicText"; parts: UiExpression[] };
export type RichProtocolErrorCode = "RICH_SHAPE" | "RICH_VERSION" | "RICH_LIMIT" | "RICH_ID" | "RICH_REFERENCE" | "RICH_TYPE" | "RICH_LAYOUT" | "RICH_FILTER";
export class RichProtocolError extends Error {
  readonly diagnostic: { code: RichProtocolErrorCode; path: string; expected: string; repairable: boolean };
  constructor(code: RichProtocolErrorCode, path: string, expected: string) {
    super(`${code} at ${path}: ${expected}`); this.name = "RichProtocolError";
    this.diagnostic = Object.freeze({ code, path, expected, repairable: code !== "RICH_LIMIT" && code !== "RICH_VERSION" });
  }
}
function check(condition: unknown, code: RichProtocolErrorCode, path: string, expected: string): asserts condition {
  if (!condition) throw new RichProtocolError(code, path, expected);
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
function keys(value: Record<string, unknown>, allowed: readonly string[], path: string) {
  check(Object.keys(value).every(key => allowed.includes(key)), "RICH_SHAPE", path, "Only documented properties are allowed");
}
function title(value: unknown, path: string): asserts value is string {
  check(typeof value === "string" && value.length <= 160 && value.trim().length > 0, "RICH_SHAPE", path, "A nonempty title of at most 160 characters");
}

/** Check data and serialization cost before cloning or invoking the v1 validator. */
function jsonBudget(input: unknown): void {
  const stack: Array<{ value: unknown; depth: number; leave?: boolean }> = [{ value: input, depth: 0 }];
  const ancestors = new WeakSet<object>();
  let count = 0, characters = 0;
  while (stack.length) {
    const { value, depth, leave } = stack.pop()!;
    if (leave) { ancestors.delete(value as object); continue; }
    check(++count <= UI_RICH_LIMITS.jsonValues && depth <= UI_RICH_LIMITS.jsonDepth, "RICH_LIMIT", "$", "Bounded JSON nesting and value count");
    if (typeof value === "string") characters += JSON.stringify(value).length;
    else if (typeof value === "number") {
      check(Number.isFinite(value), "RICH_SHAPE", "$", "Finite JSON numbers"); characters += String(value).length;
    } else if (typeof value === "boolean") characters += value ? 4 : 5;
    else {
      check(value !== null && typeof value === "object", "RICH_SHAPE", "$", "Plain JSON objects, arrays and scalar values");
      check(!ancestors.has(value), "RICH_SHAPE", "$", "Acyclic JSON data");
      const array = Array.isArray(value), descriptors = Object.getOwnPropertyDescriptors(value);
      check(array || Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null, "RICH_SHAPE", "$", "Plain JSON objects");
      check(Object.getOwnPropertySymbols(value).length === 0 && Object.values(descriptors).every(item => "value" in item), "RICH_SHAPE", "$", "JSON data properties without accessors");
      const names = Object.keys(descriptors).filter(name => !array || name !== "length");
      check(names.every(name => descriptors[name].enumerable), "RICH_SHAPE", "$", "Enumerable JSON properties");
      if (array) check(names.length === value.length && names.every((name, index) => name === String(index)), "RICH_SHAPE", "$", "Dense JSON arrays without extra properties");
      characters += 2 + Math.max(0, names.length - 1);
      if (!array) characters += names.reduce((sum, name) => sum + JSON.stringify(name).length + 1, 0);
      ancestors.add(value); stack.push({ value, depth, leave: true });
      for (const name of names) stack.push({ value: descriptors[name].value, depth: depth + 1 });
    }
    check(characters <= UI_RICH_LIMITS.characters, "RICH_LIMIT", "$", "At most 64000 serialized JSON characters");
  }
}

/** A computation adapter, never a downgrade of the persisted Surface2 document. */
export function richLegacyProjection(surface: UiRichSurface): UiSurface {
  return validateSurface({ version: 1, id: surface.id, revision: surface.revision, title: surface.title, nodes: projectRichNodes(surface.nodes) });
}

/** Validate bound prose with the same shared expression budget as all other
 * outputs. This adapter exists only for computation, not rendering or storage. */
function projectRichNodes(nodes: unknown[]): unknown[] {
  return nodes.map((node, index) => {
    if (!object(node) || node.type !== "dynamicText") return node;
    const path = `$.nodes[${index}]`;
    keys(node, ["id", "type", "parts"], path);
    check(Array.isArray(node.parts) && node.parts.length >= 1 && node.parts.length <= UI_RICH_LIMITS.textParts,
      "RICH_LIMIT", `${path}.parts`, "Dynamic text has 1 to 12 bounded expressions");
    return { id: node.id, type: "table", columns: node.parts.map(() => ""), rows: [node.parts] };
  });
}
type Control = Extract<UiNode, { type: "number" | "slider" | "select" | "checkbox" }>;
const isControl = (node: UiRichNode): node is Control => ["number", "slider", "select", "checkbox"].includes(node.type);
const calculationUnavailable = "[calculation unavailable]";
/** Binary64's shortest decimal form fits 32 characters, including sign/exponent. */
const numericCharacters = 32;

/** Conservative complete snapshot length for every permitted control state.
 * Structural validation must run first; this does not execute expressions. */
export function richSnapshotUpperBound(surface: UiRichSurface): number {
  const nodes = new Map(surface.nodes.map(node => [node.id, node]));
  const controls = new Map(surface.nodes.filter(isControl).map(node => [node.id, node]));
  const controlLength = (node: Control): number => node.type === "select" ? Math.max(...node.options.map(value => value.length)) : node.type === "checkbox" ? 5 : numericCharacters;
  const expressionLength = (expression: UiExpression): number => {
    let length: number;
    if (typeof expression !== "object") length = typeof expression === "string" ? expression.length : typeof expression === "boolean" ? 5 : numericCharacters;
    else if ("ref" in expression) length = controlLength(controls.get(expression.ref)!);
    else if (expression.op === "if") length = Math.max(expressionLength(expression.args[1]), expressionLength(expression.args[2]));
    else length = expression.op === "equals" ? 5 : numericCharacters;
    return Math.max(length, calculationUnavailable.length);
  };
  const nodeLength = (id: string, filtered = false): number => {
    const node = nodes.get(id)!;
    if (isControl(node)) return node.label.length + 2 + controlLength(node);
    if (node.type === "text") return node.text.length;
    if (node.type === "dynamicText") return node.parts.reduce<number>((sum, part) => sum + expressionLength(part), 0);
    if (node.type === "metric") return node.label.length + 2 + expressionLength(node.value);
    if (node.type === "barChart") return node.labels.reduce((sum, label, index) => sum + label.length + 2 + expressionLength(node.values[index]), 0) + Math.max(0, node.labels.length - 1);
    return node.columns.reduce((sum, column) => sum + column.length, 0) + 3 * Math.max(0, node.columns.length - 1)
      + node.rows.reduce<number>((sum, row) => sum + row.reduce<number>((total, cell) => total + expressionLength(cell), 0) + 3 * Math.max(0, row.length - 1) + (filtered ? "[filtered] ".length : 0) + 1, 0);
  };
  const lengths = [surface.title.length];
  for (const block of surface.layout) {
    lengths.push(block.title.length);
    if (block.type === "group") lengths.push(...block.nodeIds.map(id => nodeLength(id)));
    else if (block.type === "comparison") for (const card of block.cards) lengths.push(card.title.length, ...card.nodeIds.map(id => nodeLength(id)));
    else {
      const table = nodes.get(block.tableId) as Extract<UiNode, { type: "table" }>;
      lengths.push(`Rows shown: ${table.rows.length}/${table.rows.length}; active filters: ${block.filters.length}; unknown rows: ${table.rows.length}`.length, nodeLength(block.tableId, true));
    }
  }
  return lengths.reduce((sum, length) => sum + length, 0) + Math.max(0, lengths.length - 1);
}
type ValueType = "number" | "string" | "boolean" | "mixed" | "invalid";
function expressionType(expression: UiExpression, controls: Map<string, Control>): ValueType {
  if (typeof expression !== "object") return typeof expression as ValueType;
  if ("ref" in expression) {
    const control = controls.get(expression.ref);
    return control?.type === "select" ? "string" : control?.type === "checkbox" ? "boolean" : control ? "number" : "invalid";
  }
  const types = expression.args.map(arg => expressionType(arg, controls));
  if (expression.op === "equals") return types.some(type => type === "invalid") ? "invalid" : "boolean";
  if (expression.op === "if") return types[0] !== "boolean" || types.includes("invalid") ? "invalid" : types[1] === types[2] ? types[1] : "mixed";
  return types.every(type => type === "number") ? "number" : "invalid";
}

export function validateRichSurface(input: unknown): UiRichSurface {
  jsonBudget(input);
  check(object(input), "RICH_SHAPE", "$", "A Surface2 object");
  keys(input, ["version", "id", "revision", "title", "nodes", "layout"], "$");
  check(input.version === 2, "RICH_VERSION", "$.version", "Surface version 2");
  check(isUiId(input.id), "RICH_ID", "$.id", "A stable surface ID");
  check(Number.isSafeInteger(input.revision) && Number(input.revision) > 0, "RICH_SHAPE", "$.revision", "A positive integer revision"); title(input.title, "$.title");
  check(Array.isArray(input.nodes) && input.nodes.length > 0, "RICH_SHAPE", "$.nodes", "A nonempty node list");
  check(input.nodes.length <= UI_RICH_LIMITS.nodes, "RICH_LIMIT", "$.nodes", "At most 64 nodes");
  let base: UiSurface;
  try { base = validateSurface({ version: 1, id: input.id, revision: input.revision, title: input.title, nodes: projectRichNodes(input.nodes) }); }
  catch (error) {
    if (error instanceof RichProtocolError) throw error;
    const limited = error instanceof Error && ["UI expression budget exceeded", "UI surface too large", "Too many table rows"].includes(error.message);
    throw new RichProtocolError(limited ? "RICH_LIMIT" : "RICH_SHAPE", "$.nodes", "Bounded controls, outputs and dynamic text expressions");
  }
  check(Array.isArray(input.layout) && input.layout.length > 0, "RICH_LAYOUT", "$.layout", "A nonempty layout block list");
  check(input.layout.length <= UI_RICH_LIMITS.blocks, "RICH_LIMIT", "$.layout", "At most 16 layout blocks");
  const richNodes = input.nodes as UiRichNode[];
  const nodes = new Map(richNodes.map(node => [node.id, node])), controls = new Map(base.nodes.filter(isControl).map(node => [node.id, node]));
  const ids = new Set(nodes.keys()), placed = new Set<string>();
  const defaults = initialState(base);
  let cards = 0, filters = 0, references = 0;
  check(richNodes.reduce((sum, node) => sum + (node.type === "table" ? node.rows.length : 0), 0) <= UI_RICH_LIMITS.rows, "RICH_LIMIT", "$.nodes", "At most 200 table rows across the surface");
  const addId = (id: unknown, path: string) => {
    check(isUiId(id) && !ids.has(id), "RICH_ID", path, "A unique stable ID across nodes, blocks and cards"); ids.add(id);
  };
  const place = (id: unknown, path: string) => {
    check(typeof id === "string" && nodes.has(id), "RICH_REFERENCE", path, "An existing node ID");
    check(!placed.has(id), "RICH_LAYOUT", path, "Each node must be placed exactly once"); placed.add(id); references++;
  };
  const placeList = (list: unknown, path: string) => {
    check(Array.isArray(list) && list.length > 0, "RICH_LAYOUT", path, "A nonempty list of node IDs");
    check(list.length <= UI_RICH_LIMITS.nodes, "RICH_LIMIT", path, "At most 64 node references");
    list.forEach((id, index) => place(id, `${path}[${index}]`));
  };
  input.layout.forEach((block: unknown, index: number) => {
    const path = `$.layout[${index}]`;
    check(object(block), "RICH_SHAPE", path, "A layout block"); addId(block.id, `${path}.id`); title(block.title, `${path}.title`);
    if (block.type === "group") {
      keys(block, ["id", "type", "title", "columns", "nodeIds"], path);
      check(block.columns === 1 || block.columns === 2 || block.columns === 3, "RICH_LAYOUT", `${path}.columns`, "One, two or three columns");
      placeList(block.nodeIds, `${path}.nodeIds`);
    } else if (block.type === "comparison") {
      keys(block, ["id", "type", "title", "cards"], path);
      check(Array.isArray(block.cards) && block.cards.length >= 2, "RICH_LAYOUT", `${path}.cards`, "At least two comparison cards");
      check(block.cards.length <= UI_RICH_LIMITS.cardsPerComparison, "RICH_LIMIT", `${path}.cards`, "At most eight comparison cards");
      cards += block.cards.length;
      block.cards.forEach((card: unknown, cardIndex: number) => {
        const cardPath = `${path}.cards[${cardIndex}]`;
        check(object(card), "RICH_SHAPE", cardPath, "A comparison card"); keys(card, ["id", "title", "nodeIds"], cardPath);
        addId(card.id, `${cardPath}.id`); title(card.title, `${cardPath}.title`); placeList(card.nodeIds, `${cardPath}.nodeIds`);
      });
    } else if (block.type === "filteredTable") {
      keys(block, ["id", "type", "title", "tableId", "filters"], path); place(block.tableId, `${path}.tableId`);
      const table = nodes.get(block.tableId as string);
      check(table?.type === "table", "RICH_REFERENCE", `${path}.tableId`, "A table node");
      check(Array.isArray(block.filters) && block.filters.length > 0, "RICH_FILTER", `${path}.filters`, "At least one explicit predicate");
      check(block.filters.length <= UI_RICH_LIMITS.filtersPerTable, "RICH_LIMIT", `${path}.filters`, "At most eight predicates per table");
      filters += block.filters.length; references += block.filters.length;
      const predicates = new Set<string>();
      block.filters.forEach((filter: unknown, filterIndex: number) => {
        const filterPath = `${path}.filters[${filterIndex}]`;
        check(object(filter), "RICH_SHAPE", filterPath, "A table predicate"); keys(filter, ["column", "controlId", "operator", "inactiveValue"], filterPath);
        check(Number.isInteger(filter.column) && Number(filter.column) >= 0 && Number(filter.column) < table.columns.length, "RICH_REFERENCE", `${filterPath}.column`, "An existing zero-based table column");
        const control = typeof filter.controlId === "string" ? controls.get(filter.controlId) : undefined;
        check(control, "RICH_REFERENCE", `${filterPath}.controlId`, "An existing input control");
        check(typeof filter.operator === "string" && ["equals", "contains", "gte", "lte"].includes(filter.operator), "RICH_FILTER", `${filterPath}.operator`, "equals, contains, gte or lte");
        const expected = control.type === "select" ? "string" : control.type === "checkbox" ? "boolean" : "number";
        check(filter.operator === "equals" || filter.operator === "contains" && expected === "string" || ["gte", "lte"].includes(filter.operator) && expected === "number", "RICH_TYPE", filterPath, "An operator compatible with the control type");
        table.rows.forEach((row, rowIndex) => check(expressionType(row[Number(filter.column)], controls) === expected, "RICH_TYPE", `${filterPath}.column`, `All referenced cells must have the control's value type (row ${rowIndex})`));
        if (Object.hasOwn(filter, "inactiveValue")) {
          try { validateState(base, { ...defaults, [control.id]: filter.inactiveValue }); }
          catch { throw new RichProtocolError("RICH_FILTER", `${filterPath}.inactiveValue`, "A valid value of the referenced control"); }
        }
        const key = `${filter.column}:${control.id}:${filter.operator}`;
        check(!predicates.has(key), "RICH_FILTER", filterPath, "Distinct table predicates"); predicates.add(key);
      });
    } else throw new RichProtocolError("RICH_LAYOUT", `${path}.type`, "group, comparison or filteredTable");
  });
  check(cards <= UI_RICH_LIMITS.cards && base.nodes.length + input.layout.length + cards <= UI_RICH_LIMITS.totalElements, "RICH_LIMIT", "$.layout", "At most 16 cards and 96 total nodes and containers");
  check(filters <= UI_RICH_LIMITS.filters && references <= UI_RICH_LIMITS.layoutReferences, "RICH_LIMIT", "$.layout", "At most 32 predicates and 128 layout references");
  check(placed.size === nodes.size, "RICH_LAYOUT", "$.layout", "Every node must be placed; no output or input may be omitted");
  check(richSnapshotUpperBound({ ...base, version: 2, nodes: richNodes, layout: input.layout as RichBlock[] }) <= UI_RICH_LIMITS.snapshotCharacters,
    "RICH_LIMIT", "$", "The complete snapshot must fit 128000 characters for every allowed input value");
  return JSON.parse(JSON.stringify(input)) as UiRichSurface;
}

export function richInitialState(surface: UiRichSurface): UiState { return initialState(richLegacyProjection(surface)); }
export function validateRichState(surface: UiRichSurface, input: unknown): UiState {
  try { return validateState(richLegacyProjection(surface), input); }
  catch { throw new RichProtocolError("RICH_TYPE", "$.state", "Exactly the known controls with valid values and bounds"); }
}
export type RichCell = { value: UiValue; error?: never } | { error: "CALCULATION_UNAVAILABLE"; value?: never };
export type EvaluatedRichNode =
  | Exclude<UiNode, { type: "metric" | "table" | "barChart" }>
  | { id: string; type: "dynamicText"; parts: RichCell[] }
  | { id: string; type: "metric"; label: string; value: RichCell }
  | { id: string; type: "table"; columns: string[]; rows: RichCell[][] }
  | { id: string; type: "barChart"; labels: string[]; values: RichCell[] };
export interface RichTableView {
  visibleRowIndices: number[]; unknownRowIndices: number[]; totalRows: number; activeFilterCount: number;
  excludedRowIndices: number[];
}
export interface EvaluatedRichSurface { state: UiState; nodes: EvaluatedRichNode[]; tableViews: Record<string, RichTableView> }

/** No row is discarded. Unknown calculations remain visible rather than matching false. */
export function evaluateRichSurface(surface: UiRichSurface, input?: UiState): EvaluatedRichSurface {
  const validated = validateRichSurface(surface), state = validateRichState(validated, input ?? richInitialState(validated));
  const cell = (expression: UiExpression): RichCell => {
    try { return { value: evaluateExpression(expression, state) }; }
    catch { return { error: "CALCULATION_UNAVAILABLE" }; }
  };
  const nodes: EvaluatedRichNode[] = validated.nodes.map(node => {
    if (isControl(node)) return { ...node, value: state[node.id] } as Control;
    if (node.type === "metric") return { ...node, value: cell(node.value) };
    if (node.type === "dynamicText") return { ...node, parts: node.parts.map(cell) };
    if (node.type === "table") return { ...node, rows: node.rows.map(row => row.map(cell)) };
    if (node.type === "barChart") return { ...node, values: node.values.map(cell) };
    return node;
  });
  const byId = new Map(nodes.map(node => [node.id, node])), tableViews: Record<string, RichTableView> = {};
  for (const block of validated.layout) {
    if (block.type !== "filteredTable") continue;
    const table = byId.get(block.tableId) as Extract<EvaluatedRichNode, { type: "table" }>;
    const active = block.filters.filter(filter => !Object.hasOwn(filter, "inactiveValue") || state[filter.controlId] !== filter.inactiveValue);
    const view: RichTableView = { visibleRowIndices: [], unknownRowIndices: [], excludedRowIndices: [], totalRows: table.rows.length, activeFilterCount: active.length };
    table.rows.forEach((row, index) => {
      if (row.some(value => value.error)) { view.visibleRowIndices.push(index); view.unknownRowIndices.push(index); return; }
      const matches = active.every(filter => {
        const value = row[filter.column].value!, criterion = state[filter.controlId];
        if (filter.operator === "equals") return value === criterion;
        if (filter.operator === "contains") return (value as string).includes(criterion as string);
        return filter.operator === "gte" ? (value as number) >= (criterion as number) : (value as number) <= (criterion as number);
      });
      (matches ? view.visibleRowIndices : view.excludedRowIndices).push(index);
    });
    tableViews[block.id] = view;
  }
  return { state, nodes, tableViews };
}

/** Include all rows with visibility markers, so filtering never erases context. */
export function formatRichSnapshot(surface: UiRichSurface, input?: UiState): string {
  const evaluated = evaluateRichSurface(surface, input), nodes = new Map(evaluated.nodes.map(node => [node.id, node]));
  const value = (cell: RichCell) => cell.error ? calculationUnavailable : String(cell.value);
  const render = (id: string, view?: RichTableView): string => {
    const node = nodes.get(id)!;
    if (node.type === "text") return node.text;
    if (node.type === "dynamicText") return node.parts.map(value).join("");
    if (node.type === "metric") return `${node.label}: ${value(node.value)}`;
    if (node.type === "table") return [node.columns.join(" | "), ...node.rows.map((row, index) => `${view ? view.unknownRowIndices.includes(index) ? "[unknown] " : view.visibleRowIndices.includes(index) ? "[shown] " : "[filtered] " : ""}${row.map(value).join(" | ")}`)].join("\n");
    if (node.type === "barChart") return node.labels.map((label, index) => `${label}: ${value(node.values[index])}`).join("\n");
    return `${node.label}: ${evaluated.state[node.id]}`;
  };
  const output = [surface.title];
  for (const block of surface.layout) {
    output.push(block.title);
    if (block.type === "group") output.push(...block.nodeIds.map(id => render(id)));
    else if (block.type === "comparison") for (const card of block.cards) output.push(card.title, ...card.nodeIds.map(id => render(id)));
    else {
      const view = evaluated.tableViews[block.id];
      output.push(`Rows shown: ${view.visibleRowIndices.length}/${view.totalRows}; active filters: ${view.activeFilterCount}; unknown rows: ${view.unknownRowIndices.length}`);
      output.push(render(block.tableId, view));
    }
  }
  const snapshot = output.join("\n");
  check(snapshot.length <= UI_RICH_LIMITS.snapshotCharacters, "RICH_LIMIT", "$", "Bounded complete text snapshot");
  return snapshot;
}
