// ═══════════════════════════════════════════════════════════════════════════
//  Strategy Lab persistence — saved strategies, immutable versions, run log
//  and an audit trail, all scoped to the owning user.
// ═══════════════════════════════════════════════════════════════════════════
'use strict';

const { stmt, now } = require('../db');
const schema = require('./schema');

const parseSpec = (s) => { try { return JSON.parse(s); } catch { return null; } };

function audit(userId, strategyId, action, detail) {
  try { stmt.insertStrategyAudit.run(userId || null, strategyId || null, action, detail ? JSON.stringify(detail).slice(0, 2000) : null, now()); } catch { /* audit best-effort */ }
}

function owned(userId, id) {
  const row = stmt.strategyById.get(id);
  if (!row) return { error: 'not_found' };
  if (row.user_id !== userId) return { error: 'forbidden' };
  return { row };
}

function saveStrategy(userId, { id = null, name, description = null, spec, label = null } = {}) {
  const check = schema.validate(spec);
  if (!check.ok) return { ok: false, error: 'Invalid strategy spec', details: check.errors };
  const specJson = JSON.stringify(check.spec);
  const nameSafe = String(name || check.spec.name || 'Untitled strategy').slice(0, 120);
  const ts = now();

  if (id) {
    const o = owned(userId, id);
    if (o.error) return { ok: false, error: o.error };
    const ver = (o.row.current_ver || 1) + 1;
    stmt.updateStrategy.run(nameSafe, description, specJson, ver, ts, id);
    stmt.insertStrategyVersion.run(id, ver, specJson, label, ts);
    audit(userId, id, 'update', { version: ver });
    return { ok: true, id, version: ver };
  }
  const r = stmt.insertStrategy.run(userId, nameSafe, description, specJson, 1, ts, ts, null);
  const newId = Number(r.lastInsertRowid);
  stmt.insertStrategyVersion.run(newId, 1, specJson, label || 'created', ts);
  audit(userId, newId, 'create', { name: nameSafe });
  return { ok: true, id: newId, version: 1 };
}

function listStrategies(userId) {
  return stmt.strategiesForUser.all(userId).map((s) => ({ ...s, spec: undefined }));
}

function getStrategy(userId, id) {
  const o = owned(userId, id);
  if (o.error) return { ok: false, error: o.error };
  const versions = stmt.strategyVersions.all(id);
  return { ok: true, strategy: { ...o.row, spec: parseSpec(o.row.spec) }, versions };
}

function getVersion(userId, id, version) {
  const o = owned(userId, id);
  if (o.error) return { ok: false, error: o.error };
  const v = stmt.strategyVersion.get(id, version);
  if (!v) return { ok: false, error: 'not_found' };
  return { ok: true, version: { ...v, spec: parseSpec(v.spec) } };
}

function deleteStrategy(userId, id) {
  const o = owned(userId, id);
  if (o.error) return { ok: false, error: o.error };
  stmt.deleteStrategy.run(id);
  audit(userId, null, 'delete', { id });
  return { ok: true };
}

function duplicateStrategy(userId, id, newName) {
  const g = getStrategy(userId, id);
  if (!g.ok) return g;
  const r = saveStrategy(userId, { name: newName || `${g.strategy.name} (copy)`, description: g.strategy.description, spec: g.strategy.spec, label: 'duplicated' });
  if (r.ok) audit(userId, r.id, 'duplicate', { from: id });
  return r;
}

// Persist a compact, factual run summary (metrics only — never raw fabricated data).
function recordRun(userId, { strategyId = null, symbol, timeframe, fromTs, toTs, spec, summary } = {}) {
  const r = stmt.insertLabRun.run(userId, strategyId, symbol || null, timeframe || null, fromTs || null, toTs || null, spec ? JSON.stringify(spec).slice(0, 20000) : null, summary ? JSON.stringify(summary).slice(0, 20000) : null, now());
  return { ok: true, id: Number(r.lastInsertRowid) };
}

function listRuns(userId, limit = 50) {
  return stmt.labRunsForUser.all(userId, limit).map((r) => ({ ...r, summary: r.summary ? parseSpec(r.summary) : null }));
}

function deleteRun(userId, id) {
  stmt.deleteLabRun.run(id);
  return { ok: true };
}

module.exports = { saveStrategy, listStrategies, getStrategy, getVersion, deleteStrategy, duplicateStrategy, recordRun, listRuns, deleteRun, audit, parseSpec };
