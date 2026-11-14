import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const bashFile = 'core/tools/bash.js';
export const originalBashSha = 'afc4f829b3da2e7d8cc31296ccceb26bbc8e35018eb3f352791b651866cc2040';
const hash = text => createHash('sha256').update(text).digest('hex');
const marker = '// Piora #243: Windows ancestry';
const additions = await readFile(new URL('./patches/pi-windows-bash.js', import.meta.url), 'utf8');
const replacements = [
  ['            const commandFromStdin = shellConfig.commandTransport === "stdin";',
   '            const pioraCancellation = await pioraPrepareBashCancellation(shellName, shellConfig, command, killProcessTree);\n            if (pioraCancellation) command = pioraCancellation.command;\n            const commandFromStdin = shellConfig.commandTransport === "stdin";'],
  ['            const onAbort = () => {\n                if (child.pid)\n                    killProcessTree(child.pid);\n            };',
   '            let pioraCancelling;\n            const onAbort = () => {\n                if (child.pid) pioraCancelling ??= pioraCancellation\n                    ? pioraCancellation.kill(child.pid)\n                    : Promise.resolve(killProcessTree(child.pid));\n            };'],
  ['                        timedOut = true;\n                        exitedBeforeDeadlineAfterMs = shellExitedAfterMs;\n                        // Also when the shell already exited: on Unix the group kill still reaches background\n                        // processes holding the pipes. Windows cannot find them once the shell pid is gone.\n                        if (child.pid)\n                            killProcessTree(child.pid);',
   '                        timedOut = true;\n                        exitedBeforeDeadlineAfterMs = shellExitedAfterMs;\n                        // Also when the shell already exited: on Unix the group kill still reaches background\n                        // processes holding the pipes. Windows cannot find them once the shell pid is gone.\n                        onAbort();'],
  ['                const exitCode = await waitForChildProcess(child);', '                const exitCode = await waitForChildProcess(child);\n                await pioraCancelling;'],
  ['                if (child.pid)\n                    untrackDetachedChildPid(child.pid);', '                await pioraCancelling;\n                await pioraCancellation?.dispose();\n                if (child.pid)\n                    untrackDetachedChildPid(child.pid);'],
];

export function originalBashSource(source) {
  if (source.includes(marker)) {
    if (!source.endsWith('\n' + additions)) throw new Error('Unexpected Piora Bash cleanup helper');
    source = source.slice(0, -additions.length - 1);
    for (const [before, after] of replacements.toReversed()) {
      if (source.split(after).length !== 2) throw new Error('Unexpected Piora Bash cleanup patch');
      source = source.replace(after, () => before);
    }
  }
  if (hash(source) !== originalBashSha) throw new Error('Unexpected Pi Bash source; review cancellation patch after SDK upgrade');
  return source;
}

export async function patchWindowsBash(sdk) {
  const file = join(sdk, 'dist', bashFile);
  const source = await readFile(file, 'utf8');
  let patched = originalBashSource(source);
  for (const [before, after] of replacements) {
    if (patched.split(before).length !== 2) throw new Error('Pi Bash patch target is not unique');
    patched = patched.replace(before, () => after);
  }
  patched += '\n' + additions;
  if (patched !== source) await writeFile(file, patched);
  return patched !== source;
}
