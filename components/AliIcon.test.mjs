import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  interopDefault: true,
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});

const { AliIcon, getAdaptiveIconStrokeWidth } = await jiti.import("./AliIcon.tsx");
const { getFileIconStrokeWidth } = await jiti.import("./FileIcons.tsx");

test("uses optical stroke widths across icon sizes", () => {
  assert.equal(getAdaptiveIconStrokeWidth(10), 2);
  assert.equal(getAdaptiveIconStrokeWidth(14), 2);
  assert.equal(getAdaptiveIconStrokeWidth(15), 1.75);
  assert.equal(getAdaptiveIconStrokeWidth(18), 1.75);
  assert.equal(getAdaptiveIconStrokeWidth(19), 1.6);
  assert.equal(getAdaptiveIconStrokeWidth(24), 1.6);
});

test("supports pixel strings and keeps relative units crisp", () => {
  assert.equal(getAdaptiveIconStrokeWidth("16px"), 1.75);
  assert.equal(getAdaptiveIconStrokeWidth("20px"), 1.6);
  assert.equal(getAdaptiveIconStrokeWidth("1em"), 2);
  assert.equal(getAdaptiveIconStrokeWidth("1.2em"), 2);
});

test("allows an explicit stroke width to override optical sizing", () => {
  const adaptive = renderToStaticMarkup(React.createElement(AliIcon, { name: "check", size: 20 }));
  const overridden = renderToStaticMarkup(React.createElement(AliIcon, { name: "check", size: 20, strokeWidth: 2.25 }));

  assert.match(adaptive, /stroke-width="1\.6"/);
  assert.match(overridden, /stroke-width="2\.25"/);
});

test("renders the settings icon as a gear rather than sliders", () => {
  const settings = renderToStaticMarkup(React.createElement(AliIcon, { name: "setting", size: 15 }));

  assert.match(settings, /M12\.22 2h-\.44/);
  assert.match(settings, /M12 15a3 3 0 1 0 0-6/);
  assert.doesNotMatch(settings, /M20 7h-9|M14 17H5/);
});

test("renders team activity as a pulse instead of a layout toggle", () => {
  const activity = renderToStaticMarkup(React.createElement(AliIcon, { name: "activity", size: 16 }));

  assert.match(activity, /M22 12h-4l-3 9L9 3l-3 9H2/);
  assert.doesNotMatch(activity, /M9 3v18/);
});

test("scales custom file icon strokes to the same optical weight", () => {
  assert.equal(getFileIconStrokeWidth(14), 2 * (14 / 24));
  assert.equal(getFileIconStrokeWidth(16), 1.75 * (14 / 24));
  assert.equal(getFileIconStrokeWidth(20), 1.6 * (14 / 24));
});

test("Git branch, fork and commit nodes fit inside the shared viewBox", () => {
  for (const [name, count] of [["branches", 2], ["fork", 3], ["git-commit", 1]]) {
    const markup = renderToStaticMarkup(React.createElement(AliIcon, { name, size: 15 }));
    const nodes = [...markup.matchAll(/<circle cx="(\d+)" cy="(\d+)" r="(\d+)"/g)];
    assert.equal(nodes.length, count, `${name} uses canonical circular Git nodes`);
    for (const [, x, y, radius] of nodes) {
      assert.ok(+x - +radius >= 3 && +y - +radius >= 3);
      assert.ok(+x + +radius <= 21 && +y + +radius <= 21, `${name} leaves room for strokes without clipping`);
    }
  }
});
