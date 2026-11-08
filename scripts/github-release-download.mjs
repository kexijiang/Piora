// Restrict API fallback to canonical public GitHub release URLs. The caller
// must verify the downloaded bytes against its pinned checksum.
export function releaseAssetParts(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.hostname !== "github.com" || url.port || url.username || url.password || url.search || url.hash) return null;
  const match = url.pathname.match(/^\/([^/]+)\/([^/]+)\/releases\/download\/([^/]+)\/([^/]+)$/);
  return match ? match.slice(1).map(decodeURIComponent) : null;
}

export async function fetchReleaseAsset(url, options = {}) {
  const parts = releaseAssetParts(url);
  try {
    const direct = await fetch(url, options);
    if (direct.ok || !parts || direct.status < 500) return direct;
    await direct.body?.cancel();
  } catch (error) {
    if (!parts || options.signal?.aborted) throw error;
  }
  const [owner, repo, tag, name] = parts;
  const headers = { "user-agent": "Piora-release-builder", accept: "application/vnd.github+json" };
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const release = await fetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases/tags/${encodeURIComponent(tag)}`, { ...options, headers });
  if (!release.ok) throw new Error(`GitHub release API failed: HTTP ${release.status}`);
  const metadata = await release.json();
  const asset = metadata.assets?.find(item => item.name === name);
  if (!Number.isSafeInteger(asset?.id)) throw new Error(`GitHub release asset missing: ${name}`);
  return fetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases/assets/${asset.id}`, { ...options, headers: { ...headers, accept: "application/octet-stream" } });
}
