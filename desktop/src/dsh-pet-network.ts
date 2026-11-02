import { readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { getCACertificates } from "node:tls";
import { homedir } from "node:os";
import { join } from "node:path";
import { EnvHttpProxyAgent } from "undici";

export interface PetProxySettings { mode: "system" | "manual" | "direct"; proxyUrl: string; bypass: string }
export interface PetNetwork { registry: string; environment: Partial<NodeJS.ProcessEnv> }

/** Read only network settings: never copy npm credentials, scripts or arbitrary runtime options. */
export function petNetwork(environment: NodeJS.ProcessEnv = process.env, proxy?: PetProxySettings): PetNetwork {
  const env = Object.fromEntries(Object.entries(environment).map(([key, value]) => [key.toLowerCase(), value]));
  const config: Record<string, string> = {};
  try {
    const source = readFileSync(env.npm_config_userconfig || join(env.userprofile || env.home || homedir(), ".npmrc"), "utf8");
    for (const line of source.split(/\r?\n/)) {
      const match = /^\s*(registry|proxy|https-proxy|noproxy|cafile|electron_mirror)\s*=\s*(.*?)\s*$/i.exec(line);
      if (match) config[match[1]!.toLowerCase()] = match[2]!.replace(/^(["'])(.*)\1$/, "$2").replace(/\$\{([^}]+)\}/g, (_, key: string) => environment[key] || "");
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Cannot read npm network configuration"); }
  const registry = new URL(env.piora_dsh_pet_registry || env.npm_config_registry || config.registry || "https://registry.npmjs.org/");
  if (!["https:", "http:"].includes(registry.protocol) || registry.username || registry.password || registry.search || registry.hash) throw new Error("Invalid DSH Pet registry URL");
  if (!registry.pathname.endsWith("/")) registry.pathname += "/";
  let http = env.http_proxy || env.all_proxy || env.npm_config_proxy || config.proxy || "";
  let https = env.https_proxy || env.all_proxy || env.npm_config_https_proxy || config["https-proxy"] || http;
  let bypass = env.no_proxy || env.npm_config_noproxy || config.noproxy || "";
  if (proxy?.mode === "manual") { http = https = proxy.proxyUrl; bypass = proxy.bypass; }
  if (proxy?.mode === "direct") { http = https = ""; bypass = "*"; }
  for (const value of [http, https]) {
    if (value && !["http:", "https:"].includes(new URL(value).protocol)) throw new Error("DSH Pet requires an HTTP or HTTPS proxy");
  }
  const network: Partial<NodeJS.ProcessEnv> = {
    HTTP_PROXY: http, HTTPS_PROXY: https, NO_PROXY: ["localhost", "127.0.0.1", "::1", bypass].filter(Boolean).join(","),
    NPM_CONFIG_REGISTRY: registry.href, NODE_USE_ENV_PROXY: "1",
  };
  const mirror = env.electron_mirror || env.npm_config_electron_mirror || config.electron_mirror;
  if (mirror) { network.ELECTRON_MIRROR = mirror; network.DSH_PET_ELECTRON_MIRROR = mirror; }
  if (env.node_extra_ca_certs) network.NODE_EXTRA_CA_CERTS = env.node_extra_ca_certs;
  const ca = env.npm_config_cafile || config.cafile;
  if (ca) network.NPM_CONFIG_CAFILE = ca;
  if (http || https) {
    network.ELECTRON_GET_USE_PROXY = "1";
    // @electron/get 2/3 uses global-agent; newer releases use undici.
    network.GLOBAL_AGENT_HTTP_PROXY = http || https;
    network.GLOBAL_AGENT_HTTPS_PROXY = https || http;
    network.GLOBAL_AGENT_NO_PROXY = network.NO_PROXY;
  }
  return { registry: registry.href, environment: network };
}

/** Explicit CA options replace Node defaults, so always retain the default and system roots. */
export function petCertificates(network: PetNetwork, certificates = getCACertificates): string[] {
  const roots = [...certificates("default"), ...certificates("system")];
  for (const file of new Set([network.environment.NODE_EXTRA_CA_CERTS, network.environment.NPM_CONFIG_CAFILE])) {
    if (file) roots.push(readFileSync(file, "utf8"));
  }
  return [...new Set(roots)];
}

/** Electron's Node mode need not honor --use-system-ca. Give npm and Electron downloads the same explicit bundle. */
export async function preparePetNetwork(root: string, network: PetNetwork, certificates = getCACertificates): Promise<PetNetwork> {
  const ca = petCertificates(network, certificates);
  await mkdir(root, { recursive: true });
  const file = join(root, "trusted-ca.pem");
  await writeFile(`${file}.tmp`, ca.join("\n"), { mode: 0o600 });
  await rename(`${file}.tmp`, file);
  return { ...network, environment: { ...network.environment, NODE_EXTRA_CA_CERTS: file, NPM_CONFIG_CAFILE: file } };
}

export function petDispatcher(network: PetNetwork): EnvHttpProxyAgent {
  const ca = petCertificates(network);
  return new EnvHttpProxyAgent({
    httpProxy: network.environment.HTTP_PROXY || "", httpsProxy: network.environment.HTTPS_PROXY || "",
    noProxy: network.environment.NO_PROXY || "",
    requestTls: { ca }, proxyTls: { ca }, connect: { ca },
  });
}
