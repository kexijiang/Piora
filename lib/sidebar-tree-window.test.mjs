import assert from 'node:assert/strict';
import test from 'node:test';
import { indexTaskTree, flattenTaskWindow, taskAncestorIds, getProjectSessionPreview } from './sidebar-tree-window.ts';
const node=(id,children=[])=>({session:{id},children});

test('five-session previews apply pin timestamps and manual order before truncating, and include forks', () => {
  const sessions = ['recent','fork','third','fourth','fifth','pin-old','pin-new','archived'].map(id => ({id, ...(id === 'fork' ? {parentSessionId:'pin-old'} : {})}));
  const flags = {'pin-old':{pinned:true,pinnedAt:'2026-01-01'},'pin-new':{pinned:true,pinnedAt:'2026-02-01'},archived:{archived:true}};
  const ids = order => getProjectSessionPreview(sessions, flags, order).map(row => row.session.id);
  assert.deepEqual(ids([]), ['pin-new','pin-old','recent','fork','third']);
  assert.deepEqual(ids(['pin-old','fourth','fork']), ['pin-old','pin-new','fourth','fork','recent']);
  assert.ok(getProjectSessionPreview(sessions, flags, []).every(row => row.children.length === 0));
  assert.deepEqual(getProjectSessionPreview([], {}, []), []);
  assert.equal(getProjectSessionPreview(sessions.slice(0, 2), {}, []).length, 2);
});

test('promotes unarchived descendants, preserves sibling order and only expands requested branches', () => {
  const nodes=[node('a',[node('archived',[node('child')])]),node('b'),node('pinned')];
  const index=indexTaskTree(nodes,{archived:{archived:true},pinned:{pinned:true}},['b','a']);
  assert.deepEqual(flattenTaskWindow(index,new Set()).map(row=>row.session.id),['pinned','b','a']);
  const expanded=flattenTaskWindow(index,new Set(['a']));
  assert.equal(expanded.at(-1).session.id,'child');
  assert.equal(expanded.at(-1).depth,1);
  assert.deepEqual(taskAncestorIds(index.parents,'child'),['a']);
});

test('deep and cyclic trees do not recurse or duplicate tasks', () => {
  const root=node('0'); let cursor=root;
  for(let i=1;i<10000;i++) { const next=node(String(i)); cursor.children.push(next); cursor=next; }
  cursor.children.push(root);
  const index=indexTaskTree([root],{},[]);
  assert.equal(index.parents.size,10000);
  assert.equal(flattenTaskWindow(index,new Set()).length,1);
  const ancestors=taskAncestorIds(index.parents,'9999');
  assert.equal(ancestors.length,9999);
  assert.equal(flattenTaskWindow(index,new Set(ancestors)).length,10000);
});
