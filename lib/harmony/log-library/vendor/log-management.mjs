// Adapted from Alentaoker/dsh-harmoneydev-tools @ 8b178a755d33cee9899160a7be283af2b23eb85d.
// SPDX-License-Identifier: Apache-2.0; see third_party/harmony-log-workbench/SOURCE.md.
import { readdir, readFile, lstat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

const fileId = /^[0-9a-f-]{36}$/, bucketId = /^[0-9a-f]{64}$/;
const digest = id => createHash('sha256').update(id).digest('hex');
const bytes = file => Math.max(0, Number(file.storedBytes ?? file.size + (file.normalizedBytes || 0)) || 0);
const identity = file => JSON.stringify([file.id, file.batchId, file.sha256, file.createdAt, file.availableAt, file.renamedAt, file.parsingContext]);

// Current DSH stores titles in projections, not on Session.header. Include cold
// sessions through the query service and cached projections without resuming an
// Agent or reading message bodies. Older hosts can still supply header names.
export async function listLogSessionLabels(ctx) {
  const optional = name => typeof ctx.reflect?.get === 'function' ? ctx.reflect.get(name) : ctx[name];
  const live = ctx.sessions?.list?.() || [], query = optional('sessionQuery'), projections = optional('sessionProjections'), cache = optional('sessionProjectionCache');
  let persisted = [];
  try { persisted = await query?.listSessions?.() || []; } catch { /* Live labels still work if the cold catalog is unavailable. */ }
  const records = new Map();
  for (const record of [...persisted, ...live]) {
    const id = record.id || record.header?.id;
    if (id) records.set(id, record);
  }
  return [...records].map(([id, record]) => {
    const header = record.header || record, session = ctx.sessions?.get?.(id) || live.find(row => row.id === id);
    let block;
    try { block = session ? projections?.cachedSnapshot?.(session) : cache?.cachedSnapshot?.(header) ?? cache?.cachedPredecessorTitle?.(header); } catch { /* Keep the identity even when one cached title is unavailable. */ }
    const name = typeof block?.values?.title === 'string' ? block.values.title : header.name || record.name;
    return { id, name };
  });
}

// A separate, explicit management surface. Normal list/read/search/delete APIs
// keep their current-session contract; management never returns log contents.
export function createLogManagement({ base, checked, owner, library, reserve, listSessions = () => [] }) {
  const plans = new Map();
  async function directory(path) {
    const info = await lstat(path).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
    if (!info?.isDirectory() || info.isSymbolicLink()) return false;
    await checked(path); return true;
  }
  async function entries(path) { return await directory(path) ? readdir(path) : []; }
  async function record(path, id, bucket, batchId) {
    for (let ancestor = path; ancestor !== base; ancestor = dirname(ancestor)) if (!await directory(ancestor)) return;
    const metadata = join(path, 'library.json'), info = await lstat(metadata);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) return;
    const value = JSON.parse(await readFile(await checked(metadata), 'utf8'));
    if (value.id !== id || value.status !== 'ready' || typeof value.sessionId !== 'string' || !value.sessionId || value.sessionId.length > 256 || digest(value.sessionId) !== bucket) return;
    return { ...value, ...(batchId ? { batchId } : {}) };
  }
  async function catalog() {
    const sessions = new Map();
    const add = (file, trash) => {
      if (!file) return;
      let value = sessions.get(file.sessionId);
      if (!value) sessions.set(file.sessionId, value = { sessionId: file.sessionId, ready: [], trash: [] });
      value[trash ? 'trash' : 'ready'].push(file);
    };
    for (const category of ['sessions', 'trash']) {
      const parent = join(base, category);
      for (const bucket of (await entries(parent)).filter(id => bucketId.test(id))) {
        const path = join(parent, bucket);
        for (const id of (await entries(path)).filter(id => fileId.test(id))) {
          if (category === 'sessions') {
            try { add(await record(join(path, id), id, bucket), false); } catch { /* Corrupt records stay untouched. */ }
          } else {
            for (const child of (await entries(join(path, id))).filter(id => fileId.test(id))) {
              try { add(await record(join(path, id, child), child, bucket, id), true); } catch { /* Not an owned log. */ }
            }
          }
        }
      }
    }
    return sessions;
  }
  const labelFor = session => {
    const header = session?.header || session;
    return typeof header?.name === 'string' && header.name.trim() ? header.name.slice(0, 256) : undefined;
  };
  async function titles() {
    try { return new Map((await listSessions()).map(session => [session.id || session.header?.id, labelFor(session)])); }
    catch { return new Map(); }
  }
  const summary = (value, names) => ({
    sessionId: value.sessionId, name: names.get(value.sessionId) || `会话 ${value.sessionId}`,
    nameAvailable: !!names.get(value.sessionId), files: value.ready.length, bytes: value.ready.reduce((n, file) => n + bytes(file), 0),
    trashFiles: value.trash.length, trashBytes: value.trash.reduce((n, file) => n + bytes(file), 0),
    updatedAt: [...value.ready, ...value.trash].reduce((last, file) => String(file.availableAt || file.createdAt || '') > last ? String(file.availableAt || file.createdAt) : last, ''),
  });
  return {
    async sessions({ query = '', offset = 0, limit = 50 } = {}, scope) {
      owner(scope); offset = Number(offset); limit = Number(limit); query = String(query).trim().toLocaleLowerCase();
      if (query.length > 256 || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw Error('会话管理查询参数无效');
      const names = await titles();
      const rows = [...(await catalog()).values()].map(value => summary(value, names)).filter(row => !query || `${row.name} ${row.sessionId}`.toLocaleLowerCase().includes(query)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.sessionId.localeCompare(b.sessionId));
      return { sessions: rows.slice(offset, offset + limit), total: rows.length, offset, nextOffset: offset + limit < rows.length ? offset + limit : null, totals: rows.reduce((sum, row) => ({ files: sum.files + row.files, bytes: sum.bytes + row.bytes, trashFiles: sum.trashFiles + row.trashFiles, trashBytes: sum.trashBytes + row.trashBytes }), { files: 0, bytes: 0, trashFiles: 0, trashBytes: 0 }), instruction: '仅统计离线会话日志；空间为原包和正文估算，不含索引、临时文件及文件系统开销。删除会直接移除插件日志副本，包含所选会话的旧版本删除残留。' };
    },
    async prepare({ sessionIds, action }, scope) {
      const requester = owner(scope);
      if (!['delete', 'restore', 'purge'].includes(action) || !Array.isArray(sessionIds) || !sessionIds.length || sessionIds.length > 200) throw Error('请选择 1～200 个会话及有效操作');
      for (const sessionId of sessionIds) owner({ sessionId });
      const values = await catalog(), targets = [], names = await titles(); let count = 0, totalBytes = 0;
      for (const sessionId of new Set(sessionIds)) {
        const session = values.get(sessionId); if (!session) throw Error('所选会话已没有可管理的日志，请刷新列表');
        const records = action === 'delete' ? [...session.ready, ...session.trash] : session.trash;
        if (!records.length) continue;
        count += records.length; if (count > 10000) throw Error('单次最多处理 10000 份日志，请缩小选择范围');
        totalBytes += records.reduce((sum, file) => sum + bytes(file), 0);
        targets.push({ sessionId, name: names.get(sessionId) || `会话 ${sessionId}`, records: records.map(file => ({ id: file.id, batchId: file.batchId, identity: identity(file) })) });
      }
      if (!count) throw Error(action === 'delete' ? '所选会话没有可删除的日志' : '所选会话没有旧版本残留');
      const now = Date.now(); for (const [id, plan] of plans) if (plan.expiresAt <= now) plans.delete(id);
      while (plans.size >= 20) plans.delete(plans.keys().next().value);
      const token = randomUUID(), expiresAt = now + 10 * 60000, before = new Date(now).toISOString();
      plans.set(token, { requester, action, targets, before, expiresAt });
      return { token, action, count, bytes: totalBytes, sessionCount: targets.length, sessions: targets.map(target => ({ sessionId: target.sessionId, name: target.name, count: target.records.length })), expiresAt };
    },
    async execute({ token, confirm }, scope) {
      const requester = owner(scope), plan = plans.get(token);
      if (confirm !== true) throw Error('请先确认本次会话日志清理范围');
      if (!plan || plan.requester !== requester || plan.expiresAt <= Date.now()) throw Error('操作范围已过期或不属于当前入口，请重新选择');
      plans.delete(token); // One use, including partial failures and concurrent clicks.
      const results = [], errors = []; let removed = 0, restored = 0;
      for (const target of plan.targets) {
        const targetScope = { sessionId: target.sessionId }; let release;
        try {
          release = reserve(targetScope);
          const valid = [];
          for (const item of target.records) {
            const bucket = digest(target.sessionId), path = item.batchId ? join(base, 'trash', bucket, item.batchId, item.id) : join(base, 'sessions', bucket, item.id);
            const value = await record(path, item.id, bucket, item.batchId).catch(() => undefined);
            if (!value || identity(value) !== item.identity) { errors.push({ sessionId: target.sessionId, id: item.id, error: '日志已变化或已被其他操作移走，已跳过' }); continue; }
            valid.push(item);
          }
          if (!valid.length) continue;
          if (plan.action === 'restore') {
            for (const batchId of new Set(valid.map(file => file.batchId))) {
              const ids = valid.filter(file => file.batchId === batchId).map(file => file.id);
              for (let at = 0; at < ids.length; at += 1000) {
                const result = await library.restore(batchId, targetScope, ids.slice(at, at + 1000));
                restored += result.restored; results.push({ sessionId: target.sessionId, ...result }); errors.push(...result.errors.map(error => ({ sessionId: target.sessionId, ...error })));
              }
            }
          } else {
            const live = valid.filter(file => !file.batchId), legacy = valid.filter(file => file.batchId);
            const operations = [];
            if (plan.action === 'delete' && live.length) operations.push(() => library.remove({ ids: live.map(file => file.id) }, targetScope));
            if (legacy.length) operations.push(() => library.purge(targetScope, plan.before, legacy));
            for (const operation of operations) {
              const result = await operation();
              removed += result.removed; results.push({ sessionId: target.sessionId, ...result }); errors.push(...result.errors.map(error => ({ sessionId: target.sessionId, ...error })));
            }
          }
        } catch (error) { errors.push({ sessionId: target.sessionId, error: error.message }); }
        finally { release?.(); }
      }
      return { action: plan.action, removed, restored, results, errors };
    },
    dispose() { plans.clear(); },
  };
}
