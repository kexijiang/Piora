import { app, dialog, ipcMain, safeStorage, type BrowserWindow, type IpcMainInvokeEvent } from "electron";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CredentialVault } from "./credential-vault.js";
import type { VaultRequest } from "./credential-vault-types.js";

let vault: CredentialVault | undefined;
export function getCredentialVault() { return vault ??= new CredentialVault(join(app.getPath("userData"), "credential-vault.enc"), safeStorage); }
export function registerVaultHandlers(options: {
  owner(event: IpcMainInvokeEvent): BrowserWindow | null | undefined;
  fill(id: string): Promise<void>;
  release(): Promise<void>;
  changed?(): void;
}) {
  ipcMain.removeHandler("pi:credential-vault");
  ipcMain.handle("pi:credential-vault", async (event, input: VaultRequest) => {
    const owner = options.owner(event);
    if (!owner || owner.isDestroyed()) throw new Error("Untrusted credential request");
    try {
      if (!input || typeof input !== "object") throw new Error();
      const store = getCredentialVault();
      switch (input.action) {
        case "status": break;
        case "initialize": store.initialize(input.password ?? ""); break;
        case "unlock": store.unlock(input.password ?? ""); break;
        case "lock": store.lock(); break;
        case "save": if (!input.entry) throw new Error(); store.save(input.entry); break;
        case "remove": store.remove(input.id ?? ""); break;
        case "configure": store.configure(input.enabled === true); break;
        case "fill": await options.fill(input.id ?? ""); break;
        case "release": await options.release(); break;
        case "export": {
          // Verification precedes the native save dialog. Only encrypted bytes leave the process.
          const bytes = store.export(input.password ?? "");
          const result = await dialog.showSaveDialog(owner, { title: "导出加密凭据备份", defaultPath: "piora-credentials.vault", filters: [{ name: "Encrypted credentials", extensions: ["vault"] }] });
          if (!result.canceled && result.filePath) writeFileSync(result.filePath, bytes, { mode: 0o600 });
          break;
        }
        case "import": {
          if (!store.status().unlocked) throw new Error();
          const result = await dialog.showOpenDialog(owner, { title: "导入加密凭据备份", properties: ["openFile"], filters: [{ name: "Encrypted credentials", extensions: ["vault"] }] });
          if (!result.canceled && result.filePaths[0]) store.import(readFileSync(result.filePaths[0]), input.password ?? "");
          break;
        }
        default: throw new Error();
      }
      if (input.action !== "status") options.changed?.();
      return store.status();
    } catch { throw new Error("凭据库操作未完成。请检查解锁密码、备份或当前登录页；不会自动填写支付、验证码和安全设置页面。"); }
  });
}
