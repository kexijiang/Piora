import { parseFragment, type DefaultTreeAdapterMap } from "parse5";
import postcss from "postcss";
import valueParser from "postcss-value-parser";
import { MINI_APP_LIMITS, miniAppError } from "./limits";
import { MINI_APP_ID, readId } from "./json";
import { MINI_APP_HTML_TAGS, MINI_APP_CSS_PROPERTIES } from "./document-capabilities";
import { compileMiniAppRepeatField, type MiniAppRepeat } from "./repeat";
import { MINI_APP_CSS_MEDIA_CONTRACT } from "./authoring-contract";

export type MiniAppDocumentNode = { type: "text"; text: string } | {
  type: "element"; tag: string; svg: boolean; attrs: Record<string, string>; children: MiniAppDocumentNode[];
};
export interface MiniAppDocument {
  nodes: MiniAppDocumentNode[];
  css: string;
  bindings: Array<{ id: string; attribute?: string }>;
  inputs: string[];
  events: string[];
  viewports: string[];
  repeats?: MiniAppRepeat[];
  modernStyles?: boolean;
  presets?: string[];
}

const htmlTags = new Set(MINI_APP_HTML_TAGS);
const svgTags = new Set("svg g path circle ellipse rect line polyline polygon text title desc".split(" "));
const commonAttrs = new Set(["id", "class", "role", "title", "aria-label", "aria-describedby", "aria-hidden", "tabindex", "style", "data-input", "data-text", "data-event", "data-viewport", "data-bind", "data-repeat", "data-field", "data-preset"]);
const svgAttrs = new Set("viewBox x y x1 x2 y1 y2 cx cy r rx ry width height d points fill stroke stroke-width opacity transform text-anchor font-size".split(" "));
const htmlAttrs = new Set("type value min max step maxlength checked selected disabled for colspan rowspan scope width height".split(" "));
const colors = /^(?:#[0-9a-fA-F]{3,8}|transparent|currentColor|none|black|white|red|green|blue|orange|purple|gray|yellow)$/;
const numeric = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
// Only bounded binding-attribute presence/equality selectors are supported.
// No attribute substring matching, arbitrary attributes, pseudo-elements or scripts.
const selectorAtom = /^(?:[a-zA-Z][A-Za-z0-9-]*)?(?:(?:[.#][A-Za-z][A-Za-z0-9_-]*)|(?:\[data-(?:input|event|viewport|text|repeat|field|preset)(?:=(?:[A-Za-z][A-Za-z0-9_-]*|"[A-Za-z][A-Za-z0-9_-]*"|'[A-Za-z][A-Za-z0-9_-]*'))?\]))*(?::(?:hover|focus|focus-visible|disabled))?$/;
const themeTokens = new Set(["--bg", "--bg-panel", "--bg-hover", "--bg-selected", "--border", "--text", "--text-muted", "--text-dim", "--accent", "--font-mono"]);
const properties = new Set(MINI_APP_CSS_PROPERTIES);
// Native control types are static, finite metadata. Arbitrary attribute/value
// selectors remain unsupported; normalization is only for validation, not CSS output.
const validSelectorAtom = (atom: string) => selectorAtom.test(atom.replace(/\[type=(["']?)(text|number|range|checkbox|button)\1\]/g, "[data-field]"));
function modernStyles(css: string): boolean {
  let modern = false;
  postcss.parse(css).walk(node => {
    if (node.type === "decl" && ["list-style", "list-style-type", "list-style-position"].includes(node.prop)) modern = true;
    if (node.type === "rule" && /\[type=/.test(node.selector)) modern = true;
  });
  return modern;
}

function cssValue(property: string, value: string, path: string): void {
  if (value.length > 256 || /[\\\u0000-\u001f]/.test(value)) miniAppError("SCHEMA", path, "Unsupported CSS value");
  if (property === "font" && value.trim() !== "inherit") miniAppError("SCHEMA", path, "Only font:inherit is supported; use font-size and font-weight for typography");
  if (property === "list-style" && !/^(?:(?:none|disc|circle|square|decimal)(?:\s+(?:inside|outside))?|inside|outside)$/.test(value.trim()))
    miniAppError("SCHEMA", path, "Use a supported literal list marker and optional inside/outside position");
  if (property === "list-style-type" && !/^(?:none|disc|circle|square|decimal)$/.test(value.trim())) miniAppError("SCHEMA", path, "Unsupported list marker");
  if (property === "list-style-position" && !/^(?:inside|outside)$/.test(value.trim())) miniAppError("SCHEMA", path, "Unsupported list marker position");
  let tokens = 0;
  valueParser(value).walk(node => {
    if (++tokens > 80) miniAppError("LIMIT", path, "CSS value is too complex");
    if (node.type === "string" || node.type === "comment") miniAppError("SCHEMA", path, "CSS strings and comments are not supported in values");
    if (node.type === "function") {
      if (!["var", "rgb", "rgba", "hsl", "hsla", "minmax", "repeat"].includes(node.value) || node.unclosed) miniAppError("SCHEMA", path, "Unsupported CSS function");
      if (node.value === "var" && (node.nodes.length !== 1 || node.nodes[0].type !== "word" || !themeTokens.has(node.nodes[0].value))) miniAppError("SCHEMA", path, "Only Piora theme variables are supported");
      if (node.value === "var" && (!/^(?:color|background(?:-color)?|border(?:-(?:color|top|bottom|left|right))?|outline|fill|stroke)$/.test(property)
        || node.nodes[0].value === "--font-mono")) miniAppError("SCHEMA", path, "Theme colors require a color-bearing property");
      if (node.value === "repeat") {
        if (node.nodes[0]?.type !== "word" || !/^\d+$/.test(node.nodes[0].value)) miniAppError("SCHEMA", path, "Use repeat with an integer from 1 to 8, for example repeat(2,1fr). auto-fit and auto-fill are unsupported; use an explicit bounded layout without removing task data");
        if (!/^[1-8]$/.test(node.nodes[0].value)) miniAppError("LIMIT", path, "Grid repetition is limited to eight tracks");
      }
    }
    if (node.type === "word") {
      const unit = valueParser.unit(node.value);
      if (unit && numeric.test(unit.number)) {
        const number = Number(unit.number);
        const maximum = ["letter-spacing", "word-spacing"].includes(property) ? (unit.unit === "rem" || unit.unit === "em" ? 1 : 16)
          : property === "font-size" ? (unit.unit === "rem" || unit.unit === "em" ? 4 : 64)
          : unit.unit === "rem" || unit.unit === "em" ? 64 : unit.unit === "%" ? 100 : 4096;
        if (!["", "px", "rem", "em", "%", "fr", "deg"].includes(unit.unit) || !Number.isFinite(number) || Math.abs(number) > maximum) miniAppError("LIMIT", path, "CSS size exceeds the renderer budget");
        if (property === "opacity" && (number < 0 || number > 1) || property === "line-height" && !unit.unit && (number < 0.8 || number > 4)) miniAppError("SCHEMA", path, "Invalid CSS range");
      } else if (!/^(?:[a-zA-Z-][a-zA-Z0-9-]*|#[0-9a-fA-F]{3,8})$/.test(node.value)) miniAppError("SCHEMA", path, "Unsupported CSS token");
    }
  });
}

export function compileMiniAppCss(css: string): string {
  if (typeof css !== "string" || css.length > 24_000) miniAppError("LIMIT", "document/css", "Stylesheet exceeds the renderer budget");
  let sheet;
  try { sheet = postcss.parse(css); } catch { miniAppError("SYNTAX", "document/css", "Invalid CSS stylesheet"); }
  let rules = 0, declarations = 0;
  sheet.walk(node => {
    if (node.type === "comment") { node.remove(); return; }
    if (node.type === "atrule") {
      if (node.name !== "media" || !/^\(max-width:\s*(?:[2-9]\d{2}|1\d{3})px\)$/.test(node.params)
        || node.parent?.type !== "root") miniAppError("SCHEMA", "document/css", "Only top-level bounded max-width media rules are supported. " + MINI_APP_CSS_MEDIA_CONTRACT);
    } else if (node.type === "rule") {
      if (++rules > 128 || node.selector.length > 256) miniAppError("LIMIT", "document/css", "Too many CSS rules");
      if (node.parent?.type !== "root" && node.parent?.type !== "atrule") miniAppError("SCHEMA", "document/css", "Nested selectors are not supported");
      for (const selector of node.selector.split(",")) {
        const atoms = selector.trim().split(/\s+/);
        if (atoms.length > 8 || atoms.length === 0 || atoms[0] === ">" || atoms.at(-1) === ">"
          || atoms.some((atom, i) => atom === ">" ? atoms[i-1] === ">" : !validSelectorAtom(atom) || !atom)) miniAppError("SCHEMA", "document/css", "Use element/class/id selectors, declared data binding selectors or supported native input[type=...] selectors");
      }
    } else if (node.type === "decl") {
      if (++declarations > 512) miniAppError("LIMIT", "document/css", "Too many CSS declarations");
      if (node.important) miniAppError("SCHEMA", `document/css/${node.prop}`, "CSS !important is unsupported; remove the priority suffix and use ordinary rule order or a supported selector");
      if (node.parent?.type !== "rule" || !properties.has(node.prop)) miniAppError("SCHEMA", `document/css/${node.prop}`, "Unsupported CSS property");
      cssValue(node.prop, node.value, `document/css/${node.prop}`);
      // Typography uses the host's user-selected base size; geometry stays in px.
      if (node.prop === "font-size" && /^[+]?(?:\d+(?:\.\d*)?|\.\d+)px$/.test(node.value.trim())) {
        node.value = `${Number.parseFloat(node.value) / 16}rem`;
      }
    }
  });
  return sheet.toString();
}

/** Used for initial SVG attributes and again for every computed attribute update. */
export function validateMiniAppAttribute(name: string, value: string): void {
  const path = `document/attributes/${name}`;
  if (value.length > 16_000) miniAppError("LIMIT", path, "Attribute exceeds the renderer budget");
  if (["fill", "stroke"].includes(name)) {
    if (!colors.test(value)) miniAppError("SCHEMA", path, "Use a literal color or currentColor");
  } else if (["d", "points"].includes(name)) {
    const tokens = value.match(/[a-zA-Z]|[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/g) ?? [];
    if (tokens.length > 2000 || value.replace(/[a-zA-Z]|[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|[\s,]/g, "")) miniAppError("SCHEMA", path, "Invalid vector path");
    if (tokens.some(token => numeric.test(token) ? !Number.isFinite(Number(token)) || Math.abs(Number(token)) > 10_000 : name === "points" || !/^[MmLlHhVvCcSsQqTtAaZz]$/.test(token))) miniAppError("LIMIT", path, "Vector path exceeds supported coordinates");
    if (name === "points") {
      if (tokens.length < 4 || tokens.length % 2) miniAppError("SCHEMA", path, "Vector points require complete coordinate pairs");
    } else {
      const arity: Record<string, number> = { M:2, L:2, H:1, V:1, C:6, S:4, Q:4, T:2, A:7, Z:0 };
      if (!/^[Mm]$/.test(tokens[0] ?? "")) miniAppError("SCHEMA", path, "A vector path must begin with move-to");
      let index = 0;
      while (index < tokens.length) {
        const command = tokens[index++].toUpperCase(), count = arity[command];
        if (count === undefined) miniAppError("SCHEMA", path, "Expected a vector path command");
        const start = index;
        while (index < tokens.length && numeric.test(tokens[index])) index++;
        const length = index - start;
        if (count === 0 ? length !== 0 : length === 0 || length % count !== 0) miniAppError("SCHEMA", path, "Incomplete vector path command");
        if (command === "A") for (let at = start; at < index; at += 7) {
          if (Number(tokens[at]) < 0 || Number(tokens[at+1]) < 0 || !/^[01]$/.test(tokens[at+3]) || !/^[01]$/.test(tokens[at+4])) miniAppError("SCHEMA", path, "Invalid arc radius or flag");
        }
      }
    }
  } else if (name === "transform") {
    if (value.length > 160 || !/^(?:(?:translate|rotate|scale)\([\d+.,\s-]+\)\s*){1,4}$/.test(value)) miniAppError("SCHEMA", path, "Unsupported SVG transform");
    for (const item of value.matchAll(/(translate|rotate|scale)\(([^)]+)\)/g)) {
      const numbers = item[2].trim().split(/[\s,]+/).map(Number);
      if (!(item[1] === "rotate" ? [1,3] : [1,2]).includes(numbers.length) || numbers.some(n => !Number.isFinite(n) || Math.abs(n) > (item[1] === "scale" ? 16 : 4096))) miniAppError("LIMIT", path, "SVG transform exceeds the renderer budget");
    }
  } else if (name === "viewBox") {
    const numbers = value.trim().split(/[\s,]+/).map(Number);
    if (numbers.length !== 4 || numbers.some(n => !Number.isFinite(n) || Math.abs(n) > 10_000) || numbers[2] <= 0 || numbers[3] <= 0) miniAppError("SCHEMA", path, "Invalid SVG viewBox");
  } else if (name === "text-anchor") {
    if (!["start", "middle", "end"].includes(value)) miniAppError("SCHEMA", path, "Invalid text anchor");
  } else if (!numeric.test(value) || !Number.isFinite(Number(value)) || Math.abs(Number(value)) > 10_000
    || ["r", "rx", "ry", "width", "height", "stroke-width", "font-size"].includes(name) && Number(value) < 0
    || name === "opacity" && (Number(value) < 0 || Number(value) > 1)) miniAppError("SCHEMA", path, "Invalid numeric attribute");
}

export function compileMiniAppDocument(document: { html: string; css: string }, options: { inputs: readonly string[]; viewports: readonly string[]; presets?: readonly string[] }): MiniAppDocument {
  if (typeof document.html !== "string" || document.html.length > 64_000) miniAppError("LIMIT", "document/html", "Document exceeds the renderer budget");
  let parseError = false;
  const fragment = parseFragment(document.html, { onParseError: () => { parseError = true; } });
  if (parseError) miniAppError("SYNTAX", "document/html", "Invalid HTML fragment");
  const result: MiniAppDocument = { nodes: [], css: compileMiniAppCss(document.css), bindings: [], inputs: [], events: [], viewports: [] };
  if (modernStyles(result.css)) result.modernStyles = true;
  const ids = new Set<string>(); let nodes = 0;
  const walk = (node: DefaultTreeAdapterMap["node"], depth: number, scope?: MiniAppRepeat): MiniAppDocumentNode | undefined => {
    if (++nodes > MINI_APP_LIMITS.documentNodes || depth > 16) miniAppError("LIMIT", "document/html", "Document is too complex");
    if (node.nodeName === "#comment") return;
    if (node.nodeName === "#text") return { type: "text", text: (node as DefaultTreeAdapterMap["textNode"]).value };
    if (!("tagName" in node)) miniAppError("SCHEMA", "document/html", "Unsupported document node");
    const svg = node.namespaceURI === "http://www.w3.org/2000/svg";
    if (!(svg ? svgTags : htmlTags).has(node.tagName)) miniAppError("SCHEMA", `document/${node.tagName}`, "Unsupported document element");
    const repeatId = node.attrs.find(attr => attr.name === "data-repeat")?.value;
    let repeat: MiniAppRepeat | undefined;
    if (repeatId !== undefined) {
      const id = readId(repeatId, "document/data-repeat");
      if (scope || svg || !["div", "section", "ul", "ol", "tbody"].includes(node.tagName) || (result.repeats?.length ?? 0) >= 8 || result.repeats?.some(item => item.id === id)) miniAppError("BINDING", "document/data-repeat", "Repeat requires a unique, non-nested HTML container");
      repeat = { id, template: [], bindings: [], events: [], fields: [] };
      (result.repeats ??= []).push(repeat);
    }
    const bindings = scope?.bindings ?? result.bindings;
    const attrs: Record<string, string> = {};
    for (const attr of node.attrs) {
      const { name, value } = attr;
      if (attr.namespace || !commonAttrs.has(name) && !(svg ? svgAttrs : htmlAttrs).has(name)) miniAppError("SCHEMA", `document/${name}`, "Unsupported attribute");
      if (scope && ["id", "for", "aria-describedby", "data-input", "data-viewport", "data-preset"].includes(name)) miniAppError("BINDING", `document/${name}`, "Row templates use scoped bindings and implicit labels, not global identities");
      if (repeat && ["data-event", "data-text", "data-bind", "data-field"].includes(name)) miniAppError("BINDING", `document/${name}`, "Repeat containers cannot also be bound interaction targets");
      if (name === "data-field" && (!scope || svg)) miniAppError("BINDING", "document/data-field", "Row fields require a repeat template");
      if (value.length > 16_000) miniAppError("LIMIT", `document/${name}`, "Attribute is too large");
      if (name === "id") { readId(value, "document/id"); if (ids.has(value)) miniAppError("SCHEMA", "document/id", "Duplicate element id"); ids.add(value); }
      else if (name === "class" && (value.length > 200 || value.split(/\s+/).some(v => !MINI_APP_ID.test(v)))) miniAppError("SCHEMA", "document/class", "Invalid class list");
      else if (name === "style") {
        const sheet = compileMiniAppCss(`div {${value}}`);
        if (modernStyles(sheet)) result.modernStyles = true;
        const parsed = postcss.parse(sheet);
        if (parsed.nodes.length !== 1 || parsed.nodes[0].type !== "rule" || parsed.nodes[0].selector !== "div") miniAppError("SCHEMA", "document/style", "Invalid inline style");
      } else if (name === "data-bind") {
        const mappings = value.split(";").filter(Boolean);
        if (!svg || mappings.length > 12) miniAppError("SCHEMA", "document/data-bind", "Attribute bindings require SVG");
        for (const mapping of mappings) {
          const [attribute, id, extra] = mapping.trim().split(":");
          if (extra || !svgAttrs.has(attribute) || attribute === "viewBox") miniAppError("BINDING", "document/data-bind", "Unsupported attribute binding");
          bindings.push({ id: readId(id, "document/data-bind"), attribute });
        }
      } else if (name === "data-input") {
        if (!["input", "select"].includes(node.tagName) || !options.inputs.includes(value) || result.inputs.includes(value)) miniAppError("BINDING", "document/data-input", "Input must reference a unique declared control");
        result.inputs.push(value);
      } else if (name === "data-viewport") {
        if (svg || !["div", "canvas"].includes(node.tagName) || !options.viewports.includes(value) || result.viewports.includes(value)) miniAppError("BINDING", "document/data-viewport", "Viewport must reference a unique declared view");
        result.viewports.push(value);
      } else if (name === "data-preset") {
        if (svg || node.tagName !== "button" || !options.presets?.includes(value) || result.presets?.includes(value)) miniAppError("BINDING", "document/data-preset", "Preset buttons must uniquely reference a declared input preset");
        (result.presets ??= []).push(readId(value, "document/data-preset"));
      } else if (name === "data-event") (scope?.events ?? result.events).push(readId(value, "document/data-event"));
      else if (name === "data-text") bindings.push({ id: readId(value, "document/data-text") });
      else if (svgAttrs.has(name)) validateMiniAppAttribute(name, value);
      else if (name === "type" && !["number", "range", "checkbox", "text", "button"].includes(value)) miniAppError("SCHEMA", "document/type", "Unsupported control type");
      else if (name === "tabindex" && !["0", "-1"].includes(value)) miniAppError("SCHEMA", "document/tabindex", "Unsupported tab order");
      attrs[name] = value;
    }
    if (node.tagName === "button") attrs.type = "button";
    if (["input", "select"].includes(node.tagName) && !attrs[scope ? "data-field" : "data-input"]) miniAppError("BINDING", "document/data-input", "Every input must bind to its declared control or row field");
    let children = node.childNodes.map(child => walk(child, depth + 1, repeat ?? scope)).filter((child): child is MiniAppDocumentNode => !!child);
    if (repeat) {
      const template = children.filter(child => child.type !== "text" || child.text.trim());
      if (template.length !== 1 || template[0].type !== "element") miniAppError("BINDING", "document/data-repeat", "Each repeat template requires one root element");
      repeat.template = template; children = [];
    }
    if (attrs["data-text"] && children.some(child => child.type !== "text")) miniAppError("BINDING", "document/data-text", "Text bindings cannot replace nested elements");
    if (attrs["data-viewport"] && children.some(child => child.type !== "text" || child.text.trim())) miniAppError("BINDING", "document/data-viewport", "Viewport content belongs to its renderer");
    if (attrs["data-preset"] && (children.some(child => child.type !== "text") || ["data-event", "data-text", "data-bind", "data-field", "data-input", "data-repeat", "data-viewport"].some(key => attrs[key] !== undefined))) miniAppError("BINDING", "document/data-preset", "Preset buttons have one host-owned action and a plain text label");
    const compiled: Extract<MiniAppDocumentNode, { type: "element" }> = { type: "element", tag: node.tagName, svg, attrs, children };
    if (attrs["data-field"]) {
      const field = compileMiniAppRepeatField(compiled);
      if (scope!.fields.some(item => item.id === field.id)) miniAppError("BINDING", "document/data-field", "Field ids must be unique within a row");
      scope!.fields.push(field);
    }
    return compiled;
  };
  result.nodes = fragment.childNodes.map(node => walk(node, 0)).filter((node): node is MiniAppDocumentNode => !!node);
  if (!result.nodes.length || options.inputs.some(id => !result.inputs.includes(id)) || options.viewports.some(id => !result.viewports.includes(id))) miniAppError("BINDING", "document", "The document must include every input and viewport");
  if (options.presets?.some(id => !result.presets?.includes(id))) miniAppError("BINDING", "document", "The document must include a button for every input preset");
  return result;
}
