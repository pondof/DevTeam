// Plan validation and wave scheduling. The workflow consumes precomputed waves, so all
// scheduling logic lives here where it can be tested.
import path from 'node:path';
import { readJSON, writeJSON, matchAny, samplePath, patternsOverlap, globToRegExp } from './util.mjs';

const IMPLEMENTER_KINDS = new Set(['implementer', 'support']);

export function validatePlan(plan, cfg) {
  const errors = [];
  const warnings = [];
  if (!plan || !Array.isArray(plan.tasks) || plan.tasks.length === 0) {
    return { errors: ['plan.tasks must be a non-empty array'], warnings };
  }
  const ids = new Set();
  for (const t of plan.tasks) {
    const where = `task ${t.id || '?'}`;
    if (!t.id || !/^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(t.id)) errors.push(`${where}: id must match [A-Za-z][A-Za-z0-9_-]*`);
    if (ids.has(t.id)) errors.push(`${where}: duplicate id`);
    ids.add(t.id);
    if (!t.title) errors.push(`${where}: missing title`);
    const role = cfg.roles[t.role];
    if (!role) errors.push(`${where}: unknown role "${t.role}"`);
    else {
      if (!role.enabled) errors.push(`${where}: role "${t.role}" is disabled in .team/config.json`);
      if (!IMPLEMENTER_KINDS.has(role.kind)) errors.push(`${where}: role "${t.role}" (kind ${role.kind}) cannot own a task`);
    }
    if (!Array.isArray(t.files) || t.files.length === 0) errors.push(`${where}: files must list the paths the task may change`);
    else if (role) {
      for (const f of t.files) {
        if (f.startsWith('/') || f.includes('..')) errors.push(`${where}: file "${f}" must be repo-relative`);
        else if (!matchAny(samplePath(f), role.owns)) errors.push(`${where}: "${f}" is outside ${t.role} ownership (${role.owns.join(', ') || 'none'})`);
        if (cfg.hot_files?.some((h) => globToRegExp(h).test(f))) errors.push(`${where}: "${f}" is a hot file owned by the integrator; request it via deps instead`);
      }
      if (t.files.length > (cfg.max_task_files || 12)) warnings.push(`${where}: ${t.files.length} files; split tasks above ${cfg.max_task_files || 12} files`);
    }
    if (!Array.isArray(t.acceptance) || t.acceptance.length === 0) warnings.push(`${where}: no acceptance criteria`);
    for (const k of ['depends_on', 'risk', 'deps', 'contract_refs']) {
      if (t[k] !== undefined && !Array.isArray(t[k])) errors.push(`${where}: ${k} must be an array`);
    }
  }
  for (const t of plan.tasks) {
    for (const d of t.depends_on || []) if (!ids.has(d)) errors.push(`task ${t.id}: depends_on unknown task "${d}"`);
  }
  if (!errors.length) {
    const cycle = findCycle(plan.tasks);
    if (cycle) errors.push(`dependency cycle: ${cycle.join(' -> ')}`);
  }
  return { errors, warnings };
}

function findCycle(tasks) {
  const deps = new Map(tasks.map((t) => [t.id, t.depends_on || []]));
  const state = new Map();
  const stack = [];
  const visit = (id) => {
    if (state.get(id) === 2) return null;
    if (state.get(id) === 1) return [...stack.slice(stack.indexOf(id)), id];
    state.set(id, 1); stack.push(id);
    for (const d of deps.get(id) || []) { const c = visit(d); if (c) return c; }
    stack.pop(); state.set(id, 2);
    return null;
  };
  for (const t of tasks) { const c = visit(t.id); if (c) return c; }
  return null;
}

export function tasksConflict(a, b) {
  return (a.files || []).some((fa) => (b.files || []).some((fb) => patternsOverlap(fa, fb)));
}

/**
 * Waves: topological levels, then each level split so no two tasks in a wave touch an
 * overlapping file. Tasks pushed out of a level go into a following sub-wave of the same level,
 * which keeps every dependency in an earlier wave.
 */
export function computeWaves(tasks) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const level = new Map();
  const lvl = (id) => {
    if (level.has(id)) return level.get(id);
    const deps = byId.get(id).depends_on || [];
    const v = deps.length ? 1 + Math.max(...deps.map(lvl)) : 0;
    level.set(id, v);
    return v;
  };
  tasks.forEach((t) => lvl(t.id));
  const maxLevel = Math.max(...level.values());
  const waves = [];
  for (let L = 0; L <= maxLevel; L++) {
    let pending = tasks.filter((t) => level.get(t.id) === L);
    while (pending.length) {
      const wave = [];
      const deferred = [];
      for (const t of pending) {
        if (wave.some((w) => tasksConflict(w, t))) deferred.push(t);
        else wave.push(t);
      }
      waves.push(wave.map((t) => t.id));
      pending = deferred;
    }
  }
  return waves;
}

export function checkPlanFile(runDir, cfg, { write = true } = {}) {
  const planPath = path.join(runDir, 'plan.json');
  const plan = readJSON(planPath);
  const { errors, warnings } = validatePlan(plan, cfg);
  if (errors.length) return { ok: false, errors, warnings, plan };
  plan.waves = computeWaves(plan.tasks);
  plan.deps_prep = [...new Set(plan.tasks.flatMap((t) => t.deps || []))];
  if (write) writeJSON(planPath, plan);
  return { ok: true, errors, warnings, plan };
}
