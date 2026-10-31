import { readFileSync } from "node:fs";
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
  const ca = env.node_extra_ca_certs || env.npm_config_cafile || config.cafile;
  if (ca) { network.NODE_EXTRA_CA_CERTS = ca; network.NPM_CONFIG_CAFILE = ca; }
  if (http || https) {
    network.ELECTRON_GET_USE_PROXY = "1";
    // @electron/get 2/3 uses global-agent; newer releases use undici.
    network.GLOBAL_AGENT_HTTP_PROXY = http || https;
    network.GLOBAL_AGENT_HTTPS_PROXY = https || http;
    network.GLOBAL_AGENT_NO_PROXY = network.NO_PROXY;
  }
  return { registry: registry.href, environment: network };
}

export function petDispatcher(network: PetNetwork): EnvHttpProxyAgent {
  const ca = network.environment.NODE_EXTRA_CA_CERTS;
  return new EnvHttpProxyAgent({
    httpProxy: network.environment.HTTP_PROXY || "", httpsProxy: network.environment.HTTPS_PROXY || "",
    noProxy: network.environment.NO_PROXY || "",
    ...(ca ? { requestTls: { ca: readFileSync(ca) }, proxyTls: { ca: readFileSync(ca) }, connect: { ca: readFileSync(ca) } } : {}),
  });
}
