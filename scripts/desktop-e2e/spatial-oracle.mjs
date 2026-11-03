import assert from 'node:assert/strict';

// Independent test math: no Three.js, runtime transform or raycasting imports.
// XYZ intrinsic Euler is Rx * Ry * Rz on column vectors, after local scaling.
export function transformPoint(point, node) {
  let [x, y, z] = point.map((n, i) => n * node.scale[i]);
  const [rx, ry, rz] = node.rotation;
  [x, y] = [x * Math.cos(rz) - y * Math.sin(rz), x * Math.sin(rz) + y * Math.cos(rz)];
  [x, z] = [x * Math.cos(ry) + z * Math.sin(ry), -x * Math.sin(ry) + z * Math.cos(ry)];
  [y, z] = [y * Math.cos(rx) - z * Math.sin(rx), y * Math.sin(rx) + z * Math.cos(rx)];
  return [x, y, z].map((n, i) => n + node.position[i]);
}

export function worldPoint(scene, id, local = [0, 0, 0]) {
  const nodes = new Map([...(scene.groups ?? []), ...scene.meshes].map(node => [node.id, node]));
  const seen = new Set(); let node = nodes.get(id), point = local;
  assert.ok(node, `Missing bound object ${id}`);
  while (node) {
    assert.ok(!seen.has(node.id), 'Cyclic oracle input'); seen.add(node.id);
    point = transformPoint(point, node);
    if (!node.parent) break;
    const parent = nodes.get(node.parent); assert.ok(parent, `Missing parent ${node.parent}`); node = parent;
  }
  return point;
}

const dot = (a, b) => a.reduce((sum, n, i) => sum + n * b[i], 0);
const normalized = vector => { const n = Math.hypot(...vector); assert.ok(n > 1e-12, 'Nonzero vector required'); return vector.map(v => v / n); };
const difference = (a, b) => a.map((n, i) => n - b[i]);
const cross = (a, b) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];

export function projectPoint(camera, world, width, height) {
  const forward = normalized(difference(camera.target, camera.position));
  const right = normalized(cross(forward, [0, 1, 0])), up = cross(right, forward);
  const delta = difference(world, camera.position), depth = dot(delta, forward);
  assert.ok(depth > 0, 'Pick point must be in front of the camera');
  const tangent = Math.tan(camera.fov * Math.PI / 360);
  const point = { x: (1 + dot(delta, right) / depth / tangent / (width / height)) * width / 2,
    y: (1 - dot(delta, up) / depth / tangent) * height / 2 };
  assert.ok(point.x > 0 && point.x < width && point.y > 0 && point.y < height, 'Pick point must be inside the viewport');
  return point;
}

export function checkSpatialExpectations(scene, expectations) {
  const results = [];
  for (const [kind, entries] of [['point', expectations.points ?? []], ['direction', expectations.directions ?? []]]) {
    for (const item of entries) {
      const world = worldPoint(scene, item.object, item.local);
      const actual = kind === 'direction' ? normalized(difference(world, worldPoint(scene, item.object))) : world;
      const expected = kind === 'direction' ? normalized(item.expected) : item.expected;
      const error = Math.hypot(...difference(actual, expected)), tolerance = item.tolerance ?? 1e-7;
      assert.ok(Number.isFinite(tolerance) && tolerance > 0 && tolerance <= .01, 'Use an explicit bounded geometric tolerance');
      results.push({ kind, object: item.object, local: item.local, actual, expected, error, tolerance, passed: error <= tolerance });
    }
  }
  assert.ok(results.length, 'Every audited pose must have independent geometric expectations');
  return results;
}
