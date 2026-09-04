import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { collectRuntimeDependencyAssets, isNodeModulesBinPath } from "../scripts/stage-standalone.mjs";
import {
  findForbiddenPackagedDependencies,
  forbiddenPackagedDependencies,
  packagedPiAiRuntimeCopies,
  verifyPackagedBackgroundAssets,
  verifyPackagedCompanionAssets,
  verifyPackagedPiAiModuleSurface,
  verifyPackagedPiAiRuntime,
} from "../scripts/verify-packaged-web.mjs";

test("standalone staging collects opaque provider dependency closures", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "piora-provider-dependencies-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceRoot = join(root, "source");
  const destinationRoot = join(root, "standalone");
  const providerRoot = join(sourceRoot, "node_modules", "provider-runtime");
  const directDependencyRoot = join(sourceRoot, "node_modules", "direct-runtime");
  const nestedDependencyRoot = join(directDependencyRoot, "node_modules", "nested-runtime");
  const peerDependencyRoot = join(sourceRoot, "node_modules", "peer-runtime");
  await Promise.all([
    mkdir(providerRoot, { recursive: true }),
    mkdir(nestedDependencyRoot, { recursive: true }),
    mkdir(peerDependencyRoot, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(providerRoot, "package.json"), JSON.stringify({
      name: "provider-runtime",
      dependencies: { "direct-runtime": "1.0.0" },
      optionalDependencies: { "missing-optional-runtime": "1.0.0" },
      peerDependencies: { "peer-runtime": "1.0.0" },
    })),
    writeFile(join(directDependencyRoot, "package.json"), JSON.stringify({
      name: "direct-runtime",
      dependencies: { "nested-runtime": "1.0.0" },
    })),
    writeFile(join(nestedDependencyRoot, "package.json"), JSON.stringify({
      name: "nested-runtime",
    })),
    writeFile(join(peerDependencyRoot, "package.json"), JSON.stringify({
      name: "peer-runtime",
    })),
  ]);

  const assets = await collectRuntimeDependencyAssets(
    [providerRoot],
    sourceRoot,
    destinationRoot,
  );
  assert.deepEqual(
    assets.map((asset) => asset.name).sort(),
    [
      "dynamic runtime dependency direct-runtime",
      "dynamic runtime dependency nested-runtime",
      "dynamic runtime dependency peer-runtime",
      "dynamic runtime dependency provider-runtime",
    ],
  );
  assert.ok(assets.every((asset) => asset.destination.startsWith(destinationRoot)));
  assert.ok(assets.every((asset) => asset.omitNodeModuleBins === true));
  assert.equal(isNodeModulesBinPath(providerRoot, join(providerRoot, "node_modules", ".bin", "runtime-cli")), true);
  assert.equal(isNodeModulesBinPath(providerRoot, join(providerRoot, "node_modules", "runtime-cli", "index.js")), false);
  assert.equal(isNodeModulesBinPath(providerRoot, join(providerRoot, "dist", ".bin", "fixture.js")), false);
});

test("packaged dependency audit finds scoped and nested unused peer packages", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "piora-package-audit-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const scopedDependency = join(root, "node_modules", "@splinetool", "runtime");
  const nestedDependency = join(root, "node_modules", "safe-package", "node_modules", "@lobehub", "ui");
  const harmlessLookalike = join(root, "src", "@giscus", "react");
  await Promise.all([
    mkdir(scopedDependency, { recursive: true }),
    mkdir(nestedDependency, { recursive: true }),
    mkdir(harmlessLookalike, { recursive: true }),
  ]);
  await writeFile(join(harmlessLookalike, "package.json"), "{}\n", "utf8");

  const matches = await findForbiddenPackagedDependencies(root);
  assert.deepEqual(
    matches.map(({ dependency }) => dependency).sort(),
    ["@lobehub/ui", "@splinetool/runtime"],
  );
});

test("packaged background manifest and all 37 assets match source byte-for-byte", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "piora-background-package-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const webRoot = join(root, "web");
  const sourcePublicRoot = fileURLToPath(new URL("../public/", import.meta.url));
  const sourceBackgroundRoot = join(sourcePublicRoot, "themes", "dream-backgrounds");
  const packagedBackgroundRoot = join(webRoot, "public", "themes", "dream-backgrounds");
  await mkdir(join(webRoot, "public", "themes"), { recursive: true });
  await cp(sourceBackgroundRoot, packagedBackgroundRoot, { recursive: true });

  const verified = await verifyPackagedBackgroundAssets(webRoot, sourcePublicRoot);
  assert.equal(verified.backgroundCount, 37);

  const manifest = JSON.parse(
    await readFile(join(sourceBackgroundRoot, "manifest.json"), "utf8"),
  );
  const firstAssetName = manifest.presets[0].asset.split("/").at(-1);
  const packagedAssetPath = join(packagedBackgroundRoot, firstAssetName);
  const tamperedBytes = await readFile(packagedAssetPath);
  tamperedBytes[0] ^= 0xff;
  await writeFile(packagedAssetPath, tamperedBytes);
  await assert.rejects(
    verifyPackagedBackgroundAssets(webRoot, sourcePublicRoot),
    /differs from source/,
  );
});

test("packaged companion verification requires all 10 offline pet choices byte-for-byte", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "piora-packaged-pet-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourcePublicRoot = fileURLToPath(new URL("../public/", import.meta.url));
  const webRoot = join(root, "web");
  const sourceCompanionRoot = join(sourcePublicRoot, "companion-pets");
  const packagedCompanionRoot = join(webRoot, "public", "companion-pets");
  await mkdir(join(webRoot, "public"), { recursive: true });
  await cp(sourceCompanionRoot, packagedCompanionRoot, { recursive: true });

  const verified = await verifyPackagedCompanionAssets(webRoot, sourcePublicRoot);
  assert.equal(verified.petCount, 10);
  assert.equal(verified.ids.length, 9);
  assert.ok(verified.spritesheetBytes > 0);
  assert.ok(verified.builtInArtBytes > 0);

  await writeFile(
    join(packagedCompanionRoot, "bundled", "pekka-pal.codex-pet", "spritesheet.webp"),
    Buffer.from("tampered-pet"),
  );
  await assert.rejects(
    verifyPackagedCompanionAssets(webRoot, sourcePublicRoot),
    /differs from source/,
  );
});

test("packaged Pi AI copies are complete and every login module resolves", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "piora-packaged-pi-ai-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceProjectRoot = join(root, "source");
  const webRoot = join(root, "web");
  const fixtureRoot = join(root, "fixture-pi-ai");
  await Promise.all([
    mkdir(join(fixtureRoot, "dist", "api"), { recursive: true }),
    mkdir(join(fixtureRoot, "dist", "auth", "oauth"), { recursive: true }),
    mkdir(join(fixtureRoot, "dist", "providers"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(fixtureRoot, "package.json"), '{"name":"fixture-pi-ai","type":"module"}\n'),
    writeFile(join(fixtureRoot, "dist", "api", "fixture.js"), "export const api = true;\n"),
    writeFile(join(fixtureRoot, "dist", "auth", "oauth", "fixture.js"), "export const oauth = true;\n"),
    writeFile(
      join(fixtureRoot, "dist", "auth", "oauth", "load.js"),
      "export async function loadFixtureOAuth() { return { login() {}, refresh() {}, toAuth() {} }; }\n",
    ),
    writeFile(
      join(fixtureRoot, "dist", "providers", "all.js"),
      "export function builtinProviders() { return [{ id: 'fixture-subscription', auth: { oauth: { isSubscription: true } } }]; }\n",
    ),
  ]);

  for (const copy of packagedPiAiRuntimeCopies) {
    const segments = copy.relativePath.split("/");
    await cp(fixtureRoot, join(sourceProjectRoot, ...segments), { recursive: true });
    await cp(fixtureRoot, join(webRoot, ...segments), { recursive: true });
  }

  const runtime = await verifyPackagedPiAiRuntime(webRoot, sourceProjectRoot);
  assert.equal(runtime.copyCount, 2);
  assert.equal(runtime.fileCount, 10);
  const modules = await verifyPackagedPiAiModuleSurface(webRoot);
  assert.equal(modules.copyCount, 1);
  assert.ok(modules.copies.every((copy) => (
    copy.oauthProviderIds.includes("fixture-subscription")
    && copy.subscriptionProviderIds.includes("fixture-subscription")
    && copy.oauthLoaders.includes("loadFixtureOAuth")
  )));

  const nestedCopy = packagedPiAiRuntimeCopies.find((copy) => copy.id === "coding-agent-nested");
  assert.ok(nestedCopy);
  await rm(join(
    webRoot,
    ...nestedCopy.relativePath.split("/"),
    "dist",
    "auth",
    "oauth",
    "fixture.js",
  ));
  await assert.rejects(
    verifyPackagedPiAiRuntime(webRoot, sourceProjectRoot),
    /file set differs from source/,
  );
});

test("standalone staging treats public assets as required release input", async () => {
  const stagingScript = await readFile(
    new URL("../scripts/stage-standalone.mjs", import.meta.url),
    "utf8",
  );
  const packagedVerification = await readFile(
    new URL("../scripts/verify-packaged-web.mjs", import.meta.url),
    "utf8",
  );
  const afterPackHook = await readFile(
    new URL("../scripts/electron-after-pack-licenses.cjs", import.meta.url),
    "utf8",
  );
  assert.match(
    stagingScript,
    /name: "public assets",[\s\S]*?source: join\(projectRoot, "public"\),[\s\S]*?required: true,/,
  );
  assert.match(
    stagingScript,
    /name: "desktop companion client reference manifest",[\s\S]*?page_client-reference-manifest\.js[\s\S]*?required: true,/,
  );
  assert.match(stagingScript, /\["scheduled-task recurrence runtime", "rrule"\]/);
  assert.match(stagingScript, /\["scheduled-task recurrence runtime helpers", "tslib"\]/);
  assert.match(stagingScript, /name: "top-level Pi AI runtime"/);
  assert.match(stagingScript, /name: "Pi coding-agent nested AI runtime"/);
  assert.match(stagingScript, /source: join\(projectRoot, "node_modules", \.\.\.pathSegments\)/);
  assert.match(stagingScript, /destination: join\(standaloneDirectory, "node_modules", \.\.\.pathSegments\)/);
  assert.match(stagingScript, /const piAiProviderRuntimeRoot = join\(/);
  assert.match(stagingScript, /const hypiumRuntimeRoot = join\(projectRoot, "node_modules", "hypium-driver"\)/);
  assert.match(stagingScript, /collectRuntimeDependencyAssets\(\[[\s\S]*piAiProviderRuntimeRoot,[\s\S]*hypiumRuntimeRoot,[\s\S]*\]\)/);
  assert.match(packagedVerification, /node_modules", "xmldom", "package\.json/);
  assert.match(packagedVerification, /packagedXmlDom\.version !== "0\.9\.12"/);
  assert.match(
    afterPackHook,
    /restorePackagedRuntimePackage\(stagedWebRoot, webRoot, "hypium-driver"\)/,
  );
  assert.match(
    stagingScript,
    /tracedDesktopRelease = join\(standaloneDirectory, "desktop", "release"\)/,
  );
  assert.match(stagingScript, /await rm\(tracedDesktopRelease, \{ recursive: true, force: true \}\)/);
  assert.match(stagingScript, /await rm\(tracedGitDirectory, \{ recursive: true, force: true \}\)/);
  assert.match(stagingScript, /entry\.name !== "dev" && !entry\.name\.startsWith\("dev-stale-"\)/);
});

test("packaged extension fixture is an external Pi package, not a Piora SubAgent", async () => {
  const fixtureRoot = new URL("../scripts/fixtures/packaged-pi-extension/", import.meta.url);
  const manifest = JSON.parse(await readFile(new URL("package.json", fixtureRoot), "utf8"));
  const extension = await readFile(
    new URL("extensions/package-probe.js", fixtureRoot),
    "utf8",
  );
  const skill = await readFile(
    new URL("skills/package-probe/SKILL.md", fixtureRoot),
    "utf8",
  );

  assert.equal(manifest.name, "@piora/packaged-extension-verification-fixture");
  assert.deepEqual(manifest.pi.extensions, ["./extensions/package-probe.js"]);
  assert.deepEqual(manifest.pi.skills, ["./skills/package-probe/SKILL.md"]);
  assert.match(extension, /registerCommand\("packaged-extension-probe"/);
  assert.match(extension, /registerTool\(\{/);
  assert.match(extension, /from "@earendil-works\/pi-ai"/);
  assert.doesNotMatch(extension, /sub[-_ ]?agent/i);
  assert.match(skill, /name: packaged-package-probe/);
  assert.ok(forbiddenPackagedDependencies.includes("@splinetool/runtime"));
});

test("packaged runtime verifies every first-party extension and workflow tool state", async () => {
  const verifier = await readFile(
    new URL("../scripts/verify-packaged-web.mjs", import.meta.url),
    "utf8",
  );
  const afterPack = await readFile(
    new URL("../scripts/electron-after-pack-licenses.cjs", import.meta.url),
    "utf8",
  );

  assert.match(verifier, /extensions\/piora-browser\.ts/);
  assert.match(verifier, /extensions\/piora-harmony\.ts/);
  assert.match(verifier, /extensions\/piora-vision-agent\.ts/);
  assert.match(verifier, /extensions\/piora-plan\.ts/);
  assert.match(verifier, /extensions\/piora-room\.ts/);
  assert.match(verifier, /lib\/plan-artifact-registry\.ts/);
  assert.match(verifier, /lib\/team-agent-templates\.ts/);
  assert.match(verifier, /node_modules\/rrule\/package\.json/);
  assert.match(verifier, /node_modules\/tslib\/package\.json/);
  assert.match(verifier, /@aws-sdk\/client-bedrock-runtime\/package\.json/);
  assert.match(verifier, /"piora_plan_execution"/);
  assert.match(verifier, /"piora_room"/);
  assert.match(verifier, /Packaged first-party extensions failed to load/);
  assert.match(verifier, /Packaged first-party tools failed to load/);
  assert.match(verifier, /Fixture extension tool did not activate through project settings/);
  assert.match(verifier, /Optional workflow extensions should be disabled by default/);
  assert.match(verifier, /verifyPackagedPiAiRuntime\(runtimeWebRoot\)/);
  assert.match(verifier, /verifyPackagedPiAiModuleSurface\(runtimeWebRoot\)/);
  assert.match(afterPack, /PIORA_WEB_RUNTIME_ROOT/);
});
