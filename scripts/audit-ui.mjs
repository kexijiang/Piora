import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import postcss from "postcss";
import ts from "typescript";

async function files(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map((entry) => entry.isDirectory() ? files(join(directory, entry.name)) : join(directory, entry.name)))).flat();
}
const componentFiles = await files("components");
const componentInventory = [];
for (const path of componentFiles.filter((path) => path.endsWith(".tsx"))) {
  let source = await readFile(path, "utf8");
  const syntax = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const edits = [];
  function radiusToken(number) { return `var(--radius-${number <= 10 ? "control" : number <= 12 ? "surface" : "panel"})`; }
  function visit(node) {
    if (ts.isPropertyAssignment(node) && node.name.getText(syntax) === "borderRadius") {
      const value = node.initializer;
      if (ts.isNumericLiteral(value) && Number(value.text) >= 5 && Number(value.text) <= 24) {
        edits.push({ start: value.getStart(syntax), end: value.end, text: JSON.stringify(radiusToken(Number(value.text))) });
      } else if (ts.isStringLiteral(value) && /\b(?:[5-9]|1\d|2[0-4])px\b/.test(value.text)) {
        edits.push({ start: value.getStart(syntax), end: value.end, text: JSON.stringify(value.text.replace(/\b([5-9]|1\d|2[0-4])px\b/g, (_, number) => radiusToken(Number(number)))) });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(syntax);
  if (process.argv.includes("--fix-inline-radii") && edits.length) {
    for (const edit of edits.sort((a, b) => b.start - a.start)) source = source.slice(0, edit.start) + edit.text + source.slice(edit.end);
    await writeFile(path, source);
  }
  componentInventory.push({ file: path.replaceAll("\\", "/"),
    fixedInlineRadii: edits.length,
    buttons: (source.match(/<button\b/g) ?? []).length,
    inputs: (source.match(/<(?:input|textarea|select)\b/g) ?? []).length,
    dialogs: (source.match(/role=["'](?:alert)?dialog["']/g) ?? []).length,
    inlineStyles: (source.match(/style=\{/g) ?? []).length,
  });
}
const paths = ["app/globals.css", ...componentFiles.filter((path) => path.endsWith(".css"))];
const summary = [];
for (const path of paths) {
  const source = await readFile(path, "utf8");
  const css = postcss.parse(source, { from: path });
  let changed = 0;
  const counts = { radius: 0, fixedFont: 0, shadow: 0, scrollbar: 0 };
  css.walkDecls((decl) => {
    const selector = decl.parent.type === "rule" ? decl.parent.selector : "";
    if (decl.prop === "border-radius" && /\b(?:[6-9]|1\d|2[0-4])px\b/.test(decl.value)) {
      counts.radius++;
      // Preserve pill/circle geometry and tiny decorative corners.
      if (process.argv.includes("--fix-radii")) {
        const control = /button|\binput\b|\bselect\b|\btextarea\b/i.test(selector);
        const dialog = /\.dialog\b/.test(selector);
        decl.value = decl.value.replace(/\b([6-9]|1\d|2[0-4])px\b/g, (_, number) => {
          changed++;
          return `var(--radius-${dialog ? "panel" : control || Number(number) <= 10 ? "control" : Number(number) <= 12 ? "surface" : "panel"})`;
        });
      }
    }
    if (decl.prop === "font-size" && /^\d+px$/.test(decl.value)) counts.fixedFont++;
    if (decl.prop === "box-shadow" && !decl.value.includes("var(--shadow") && decl.value !== "none") counts.shadow++;
    if (decl.prop.startsWith("scrollbar") || selector.includes("scrollbar")) counts.scrollbar++;
    if (process.argv.includes("--fix-surfaces")) {
      if (/\.primary(?:Button|Action)?\b|\.buttonPrimary\b/.test(selector) && !/danger|destructive/.test(selector)) {
        if (decl.prop === "background" && !/gradient|transparent|none/.test(decl.value)) {
          decl.value = /:hover|:focus/.test(selector) ? "var(--btn-primary-bg-hover)" : "var(--btn-primary-bg)"; changed++;
        }
        if (decl.prop === "color") { decl.value = "var(--btn-primary-fg)"; changed++; }
      }
      if (/button|btn|actions/i.test(selector) && decl.prop === "min-height" && /^(2[8-9]|3\d|4[0-4])px$/.test(decl.value)) {
        const height = parseInt(decl.value);
        decl.value = height <= 30 ? "var(--control-height-compact)" : height <= 36 ? "var(--control-height)" : "var(--control-height-large)";
        changed++;
      }
      if (decl.prop === "outline" && /accent/.test(decl.value) && /^2px solid/.test(decl.value)) {
        decl.value = "2px solid var(--focus-ring)"; changed++;
      }
      const fullScreen = path.endsWith("SettingsDialog.module.css") && !/RoomSettings|CompanionSettings/.test(path);
      if (selector === ".dialog" && !fullScreen) {
        if (decl.prop === "background") decl.value = "var(--dialog-background)";
        if (decl.prop === "box-shadow") decl.value = "var(--shadow-float)";
        if (decl.prop === "border") decl.value = "1px solid var(--border-soft)";
        changed++;
      }
      if (selector === ".backdrop" && !fullScreen) {
        if (decl.prop === "background") decl.value = "var(--overlay-scrim)";
        if (decl.prop === "backdrop-filter") decl.value = "blur(var(--overlay-blur))";
        changed++;
      }
      if (/menu|popover/i.test(selector) && decl.prop === "box-shadow" && !/inset|none/.test(decl.value)) {
        decl.value = "var(--shadow-popover)"; changed++;
      }
    }
  });
  if (changed) await writeFile(path, css.toString());
  summary.push({ file: path.replaceAll("\\", "/"), ...counts, migratedRadii: changed });
}
console.log(JSON.stringify({ files: paths.length, components: componentInventory.length, totals: summary.reduce((total, item) => {
  for (const key of ["radius", "fixedFont", "shadow", "scrollbar", "migratedRadii"]) total[key] = (total[key] ?? 0) + item[key];
  return total;
}, {}), details: summary, componentInventory }, null, 2));
