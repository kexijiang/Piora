import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { shell } from "electron";

export interface SystemLauncherEntry { id: string; name: string; kind: "app" | "setting"; keywords: string; description: string }
type Entry = SystemLauncherEntry & { target: string; source: "shortcut" | "uwp" | "setting" };
// Documented Windows settings URIs; opening a result never changes a setting.
const SETTINGS = [
  ["系统设置", "", "设置 shezhi sz settings"],
  ["显示与亮度", "display", "显示 屏幕 亮度 分辨率 缩放 display xianshi"],
  ["声音", "sound", "声音 音量 扬声器 麦克风 sound shengyin"],
  ["蓝牙和设备", "bluetooth", "蓝牙 设备 bluetooth lanya"],
  ["Wi-Fi", "network-wifi", "网络 无线 wifi wlan wangluo"],
  ["网络和 Internet", "network-status", "网络 以太网 ip network"],
  ["网络代理", "network-proxy", "代理 proxy daili"],
  ["VPN", "network-vpn", "vpn 虚拟专用网络"],
  ["已安装的应用", "appsfeatures", "应用 软件 卸载 apps yingyong ruanjian"],
  ["默认应用", "defaultapps", "默认 浏览器 文件关联 default apps"],
  ["启动应用", "startupapps", "启动 开机 自启动 startup"],
  ["通知", "notifications", "通知 免打扰 notifications tongzhi"],
  ["电源和电池", "powersleep", "电源 电池 休眠 睡眠 power battery"],
  ["存储", "storagesense", "磁盘 存储 清理 空间 storage"],
  ["个性化", "personalization", "主题 背景 壁纸 颜色 personalization"],
  ["任务栏", "taskbar", "任务栏 taskbar"],
  ["日期和时间", "dateandtime", "日期 时间 时区 date time"],
  ["语言和区域", "regionlanguage", "语言 输入法 键盘 language"],
  ["鼠标", "mousetouchpad", "鼠标 光标 mouse shubiao"],
  ["剪贴板", "clipboard", "剪贴板 粘贴 clipboard jiantieban"],
  ["辅助功能", "easeofaccess", "辅助 无障碍 accessibility"],
  ["Windows 更新", "windowsupdate", "更新 升级 update gengxin"],
  ["系统信息", "about", "关于 版本 系统信息 about system"],
] as const;

export const systemSettings: Entry[] = SETTINGS.map(([name, uri, keywords]) => ({ id: `setting:${uri || "home"}`, name, keywords, kind: "setting", description: "Windows 设置", target: `ms-settings:${uri}`, source: "setting" }));

function appEntry(name: string, target: string, source: "shortcut" | "uwp"): Entry {
  return { id: `app:${createHash("sha256").update(target.toLowerCase()).digest("hex").slice(0, 24)}`, name, target, source, kind: "app", keywords: name, description: source === "uwp" ? "Windows 应用" : "本机应用" };
}

async function shortcuts(root: string, depth = 0): Promise<Entry[]> {
  if (depth > 8) return [];
  const files = await readdir(root, { withFileTypes: true }).catch(() => []);
  const groups = await Promise.all(files.map(async (file) => {
    const path = join(root, file.name);
    if (file.isSymbolicLink()) return [];
    if (file.isDirectory()) return shortcuts(path, depth + 1);
    if (!file.isFile() || !file.name.toLowerCase().endsWith(".lnk")) return [];
    return [appEntry(basename(file.name, ".lnk"), path, "shortcut")];
  }));
  return groups.flat();
}

async function packagedApps(): Promise<Entry[]> {
  const script = "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); @(Get-StartApps | Where-Object { $_.AppID -like '*!*' } | Select-Object Name, AppID) | ConvertTo-Json -Compress";
  const executable = join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const output = await new Promise<string>((resolve, reject) => execFile(executable, ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { windowsHide: true, timeout: 20_000, maxBuffer: 2 * 1024 * 1024, encoding: "utf8" }, (error, stdout) => error ? reject(error) : resolve(stdout)));
  const raw: unknown = JSON.parse(output.replace(/^\uFEFF/, "") || "[]");
  return (Array.isArray(raw) ? raw : [raw]).flatMap((entry) => {
    if (!entry || typeof entry.Name !== "string" || typeof entry.AppID !== "string" || !/^[\w.\-]+![\w.\-]+$/.test(entry.AppID)) return [];
    return [appEntry(entry.Name, entry.AppID, "uwp")];
  });
}

export class SystemLauncher {
  private entries = new Map<string, Entry>();
  private updatedAt = 0;
  private loading: Promise<void> | null = null;
  private warning = "";
  async list(refresh = false): Promise<{ supported: boolean; items: SystemLauncherEntry[]; warning: string }> {
    if (process.platform !== "win32") return { supported: false, items: [], warning: "本机应用搜索目前支持 Windows 桌面版。" };
    if (refresh || !this.updatedAt || Date.now() - this.updatedAt > 300_000) {
      if (!this.loading) this.loading = this.scan().finally(() => { this.loading = null; });
      await this.loading;
    }
    return { supported: true, items: [...this.entries.values()].map(({ id, name, kind, keywords, description }) => ({ id, name, kind, keywords, description })), warning: this.warning };
  }
  private async scan() {
    const roots = [process.env.APPDATA, process.env.ProgramData].filter((root): root is string => Boolean(root)).map((root) => join(root, "Microsoft", "Windows", "Start Menu", "Programs"));
    const [links, modern] = await Promise.all([Promise.all(roots.map((root) => shortcuts(root))), packagedApps().then((items) => ({ items, warning: "" })).catch(() => ({ items: [] as Entry[], warning: "部分 Windows 应用暂未索引，可点击刷新重试。" }))]);
    const entries = [...links.flat(), ...modern.items];
    const names = new Set<string>();
    this.entries = new Map(systemSettings.map((entry) => [entry.id, entry]));
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, "zh-CN"))) {
      const name = entry.name.toLowerCase();
      if (names.has(name)) continue;
      names.add(name); this.entries.set(entry.id, entry);
    }
    this.warning = modern.warning;
    this.updatedAt = Date.now();
  }
  async open(id: unknown): Promise<void> {
    if (typeof id !== "string" || id.length > 100) throw new Error("无效的启动项。");
    await this.list();
    const entry = this.entries.get(id);
    if (!entry) throw new Error("启动项已不存在，请刷新搜索结果。");
    if (entry.source === "setting") await shell.openExternal(entry.target);
    else if (entry.source === "shortcut") {
      const error = await shell.openPath(entry.target);
      if (error) throw new Error("无法打开此应用，请刷新后重试。");
    } else {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(join(process.env.SystemRoot || "C:\\Windows", "explorer.exe"), [`shell:AppsFolder\\${entry.target}`], { windowsHide: true, detached: true, stdio: "ignore" });
        child.once("error", reject); child.once("spawn", () => { child.unref(); resolve(); });
      });
    }
  }
}
