import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { TerminalSession } = await jiti.import("./terminal-session.ts");

function waitForOutput(read, marker, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = () => {
      if (read().includes(marker)) return resolve();
      if (Date.now() - started >= timeoutMs) return reject(new Error(`Timed out waiting for ${marker}`));
      setTimeout(poll, 25);
    };
    poll();
  });
}

test("terminal session keeps shell state and streams output across commands", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "piora-terminal-"));
  const child = path.join(root, "child");
  fs.mkdirSync(child);
  const terminal = new TerminalSession(root);
  t.after(async () => {
    await terminal.dispose();
    // Keep bounded filesystem retries for antivirus/indexer interference after
    // the shell has emitted close and released its working-directory handle.
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  });

  terminal.start();
  terminal.run(`cd ${process.platform === "win32" ? '"child"' : "child"}`);
  terminal.run(process.platform === "win32" ? "echo PIORA_TERMINAL_OK & cd" : "printf 'PIORA_TERMINAL_OK\\n'; pwd");
  await waitForOutput(
    () => terminal.snapshot().output.replace(/\\/g, "/").toLocaleLowerCase(),
    child.replace(/\\/g, "/").toLocaleLowerCase(),
  );

  const output = terminal.snapshot().output.replace(/\\/g, "/").toLocaleLowerCase();
  assert.equal(terminal.snapshot().connected, true);
  assert.match(output, /piora_terminal_ok/);
  assert.ok(output.includes(child.replace(/\\/g, "/").toLocaleLowerCase()), output);
  // A piped child process would report false here. Exercise actual PTY input
  // and terminal dimensions through a real interactive program.
  fs.writeFileSync(path.join(child, "tty-check.cjs"), `
    console.log('TTY_RESULT:'+Boolean(process.stdin.isTTY && process.stdout.isTTY)+':'+process.stdout.columns);
    const readline=require('node:readline').createInterface({input:process.stdin,output:process.stdout});
    readline.question('TTY_PROMPT:',value=>{console.log('INPUT_RESULT:'+value.toUpperCase());readline.close();});
  `);
  terminal.resize(112, 28);
  terminal.run('node tty-check.cjs');
  await waitForOutput(() => terminal.snapshot().output, "TTY_PROMPT:", 10_000);
  terminal.input("hello terminal\r");
  await waitForOutput(() => terminal.snapshot().output, "INPUT_RESULT:HELLO TERMINAL", 10_000);
  assert.match(terminal.snapshot().output, /TTY_RESULT:true:112/);
});
