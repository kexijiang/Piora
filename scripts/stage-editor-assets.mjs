import { cpSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "node_modules/vditor");
const { version } = JSON.parse(readFileSync(path.join(source, "package.json"), "utf8"));
const target = path.join(root, "public/vendor/vditor", version);
mkdirSync(target, { recursive: true });
// Only local engines used by the editor. stage-standalone includes public/.
for (const name of ["js/lute", "js/i18n", "js/icons"]) {
  cpSync(path.join(source, "dist", name), path.join(target, "dist", name), { recursive: true });
}
cpSync(path.join(source, "LICENSE"), path.join(target, "LICENSE"));
// Reuse Piora's maintained KaTeX instead of Vditor's older bundled copy.
const mathSource = path.join(root, "node_modules/katex");
const mathTarget = path.join(target, "dist/js/katex");
mkdirSync(mathTarget, { recursive: true });
for (const file of ["katex.min.js", "katex.min.css", "fonts"]) cpSync(path.join(mathSource, "dist", file), path.join(mathTarget, file), { recursive: true });
cpSync(path.join(mathSource, "dist/contrib/mhchem.min.js"), path.join(mathTarget, "mhchem.min.js"));
cpSync(path.join(mathSource, "LICENSE"), path.join(mathTarget, "LICENSE"));
