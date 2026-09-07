import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function extractVersionNotes(changelog, requestedTag) {
  const version = requestedTag.trim().replace(/^v/i, "");
  const isPreview = /-beta\.\d+$/.test(version);
  if (!/^\d+\.\d+\.\d+(?:-beta\.\d+)?$/.test(version)) {
    throw new Error(`Invalid release tag: ${requestedTag}`);
  }
  const escapedVersion = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const heading = new RegExp(`^## \\[${escapedVersion}\\][^\\r\\n]*\\r?\\n`, "m");
  const match = heading.exec(changelog);
  const remainder = match ? changelog.slice(match.index + match[0].length) : "";
  const nextHeadingIndex = remainder.search(/^## \[/m);
  const notes = (nextHeadingIndex >= 0 ? remainder.slice(0, nextHeadingIndex) : remainder).trim();
  if (!notes) throw new Error(`CHANGELOG.md does not contain release notes for ${version}`);
  const downloads = isPreview
    ? "- Windows x64 安装版（推荐）：可选择安装位置，并支持后续 beta 更新。\n- Windows x64 便携版 EXE：可直接运行单个可执行文件。"
    : "- Windows x64 安装版（推荐）：可选择安装位置，并支持后续应用内更新。\n- Windows x64 ZIP：解压后运行 Piora.exe。\n- Windows x64 便携版 EXE：可直接运行单个可执行文件；建议安装推荐版本以获得自动更新。\n- Linux x64 AppImage：添加可执行权限后运行。";
  return `${notes}\n\n### 下载说明\n\n${downloads}\n\n安装包尚未进行代码签名；运行前请使用 SHA256SUMS.txt 校验所下载的文件。\n`;
}

async function main() {
  const [, , requestedTag, outputPath] = process.argv;
  if (!requestedTag || !outputPath) {
    throw new Error("Usage: node scripts/create-release-notes.mjs <tag> <output-path>");
  }
  const changelog = await readFile(resolve("CHANGELOG.md"), "utf8");
  await writeFile(resolve(outputPath), extractVersionNotes(changelog, requestedTag), "utf8");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
