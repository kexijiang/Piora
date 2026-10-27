/* eslint-disable @typescript-eslint/no-require-imports */
// Compile shared desktop sources as virtual ESM for the Next server. The
// desktop package itself keeps its Node16/CommonJS build unchanged.
const ts = require("typescript");

module.exports = function desktopSource(source) {
  this.cacheable?.();
  return ts.transpileModule(source, {
    fileName: this.resourcePath,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      esModuleInterop: true,
    },
  }).outputText;
};
