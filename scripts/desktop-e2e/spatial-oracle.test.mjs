import assert from 'node:assert/strict';
import test from 'node:test';
import { transformPoint, worldPoint, projectPoint, checkSpatialExpectations } from './spatial-oracle.mjs';
const node = (id, values = {}) => ({ id, position: [0,0,0], rotation: [0,0,0], scale: [1,1,1], ...values });
const near = (actual, expected) => assert.ok(Math.hypot(...actual.map((n,i)=>n-expected[i])) < 1e-10, `${actual} != ${expected}`);

test('compound XYZ differs from extrinsic XYZ, and scale/translation follow the contract', () => {
  near(transformPoint([0,0,-1],node('v',{rotation:[Math.PI/2,Math.PI/2,0]})),[-1,0,0]);
  near(transformPoint([1,1,0],node('v',{rotation:[0,0,Math.PI/2],scale:[2,3,1],position:[10,20,30]})),[7,22,30]);
});
test('nested joint pivots produce known world points and missing/cyclic identities fail', () => {
  const scene={groups:[node('body',{rotation:[0,0,Math.PI/2]}),node('joint',{parent:'body',position:[1.5,0,0],rotation:[0,0,Math.PI/2]})],meshes:[node('tip',{parent:'joint',position:[2,0,0]})]};
  near(worldPoint(scene,'tip'),[-2,1.5,0]);
  assert.throws(()=>worldPoint(scene,'unknown'),/Missing/);
  scene.groups[0].parent='joint';assert.throws(()=>worldPoint(scene,'tip'),/Cyclic/);
});
test('signed axes detect both swapped directions and reversed arrowheads', () => {
  const scene={meshes:[node('axis',{rotation:[Math.PI/2,0,0]})]};
  assert.equal(checkSpatialExpectations(scene,{directions:[{object:'axis',local:[0,1,0],expected:[0,0,1]}]})[0].passed,true);
  for(const expected of [[0,1,0],[0,0,-1]])assert.equal(checkSpatialExpectations(scene,{directions:[{object:'axis',local:[0,1,0],expected}]})[0].passed,false);
});
test('perspective projection uses camera basis and rejects hidden/outside points', () => {
  const camera={position:[0,0,10],target:[0,0,0],fov:90};
  assert.deepEqual(projectPoint(camera,[0,0,0],200,100),{x:100,y:50});
  const p=projectPoint(camera,[5,5,0],200,100);near([p.x,p.y],[125,25]);
  assert.throws(()=>projectPoint(camera,[0,0,11],200,100),/front/);
  assert.throws(()=>projectPoint(camera,[50,0,0],200,100),/inside/);
});
