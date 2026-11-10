import assert from "node:assert/strict";
import test from "node:test";
import { fetchReleaseAsset, releaseAssetParts } from "../scripts/github-release-download.mjs";

test("release API fallback accepts only canonical GitHub release assets", () => {
  assert.deepEqual(releaseAssetParts("https://github.com/ip7z/7zip/releases/download/26.04/7z2604-extra.7z"), ["ip7z", "7zip", "26.04", "7z2604-extra.7z"]);
  for (const url of ["https://github.com.evil.test/a/b/releases/download/v/x", "http://github.com/a/b/releases/download/v/x", "https://github.com/a/b/releases/download/v/x?token=x", "https://raw.githubusercontent.com/a/b/x"]) assert.equal(releaseAssetParts(url), null);
});

test("a release server error falls back to the exact API asset", async () => {
  const calls = [];
  const client = async (url, options) => {
    calls.push([url, options]);
    if (calls.length === 1) return new Response("unavailable", { status: 504 });
    if (calls.length === 2) return Response.json({ assets: [{ id: 42, name: "asset.zip" }] });
    return new Response("archive");
  };
  {
    const dispatcher = { marker: "proxy" };
    const response = await fetchReleaseAsset("https://github.com/owner/repo/releases/download/v1/asset.zip", { dispatcher }, client);
    assert.equal(await response.text(), "archive");
    assert.equal(calls[1][0], "https://api.github.com/repos/owner/repo/releases/tags/v1");
    assert.equal(calls[2][0], "https://api.github.com/repos/owner/repo/releases/assets/42");
    assert.equal(calls[2][1].headers.accept, "application/octet-stream");
    assert.ok(calls.every(([, options]) => options.dispatcher === dispatcher));
  }
});
