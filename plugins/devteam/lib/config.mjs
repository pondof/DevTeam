// Effective configuration = plugin roles.json defaults + project .team/config.json overrides.
import path from 'node:path';
import { PLUGIN_ROOT, readJSON, exists, worktreeRoot } from './util.mjs';

export function pluginRegistry() {
  return readJSON(path.join(PLUGIN_ROOT, 'roles.json'));
}

export function projectConfigPath(root) {
  return path.join(root, '.team', 'config.json');
}

export function loadProjectConfig(root) {
  const p = projectConfigPath(root);
  return exists(p) ? readJSON(p) : null;
}

function deepMerge(a, b) {
  if (Array.isArray(b) || typeof b !== 'object' || b === null) return b === undefined ? a : b;
  const out = { ...(typeof a === 'object' && a && !Array.isArray(a) ? a : {}) };
  for (const [k, v] of Object.entries(b)) out[k] = deepMerge(out[k], v);
  return out;
}

/**
 * Build the effective config for a project root (worktree or main checkout).
 * Project roles may override plugin roles field by field, or declare new roles with
 * `"local": true` (agent file in the project's .claude/agents/<name>.md).
 */
export function effectiveConfig(root = worktreeRoot() || process.cwd()) {
  const reg = pluginRegistry();
  const proj = loadProjectConfig(root) || {};
  const { roles: projRoles = {}, ...projRest } = proj;
  const cfg = deepMerge(reg.defaults, projRest);
  cfg.project_configured = !!loadProjectConfig(root);
  cfg.roles = {};
  const names = new Set([...Object.keys(reg.roles), ...Object.keys(projRoles)]);
  for (const name of names) {
    const base = reg.roles[name] || {};
    const over = projRoles[name] || {};
    const role = { enabled: true, owns: [], ...base, ...over };
    role.name = name;
    role.local = !!over.local && !reg.roles[name];
    role.agentType = role.local ? name : `devteam:${name}`;
    if (role.review_when?.tags) {
      role.review_when = {
        ...role.review_when,
        tags: role.review_when.tags.flatMap((t) => (t === '@security_tags' ? cfg.security_tags : [t])),
      };
    }
    cfg.roles[name] = role;
  }
  return cfg;
}

/** Resolve an agent_type from hook input ("devteam:backend-engineer" or a local "mobile-engineer"). */
export function roleFromAgentType(cfg, agentType) {
  if (!agentType) return null;
  const name = agentType.startsWith('devteam:') ? agentType.slice('devteam:'.length) : agentType;
  const role = cfg.roles[name];
  if (!role) return null;
  if (!agentType.startsWith('devteam:') && !role.local) return null;
  return role;
}

/** Compact config passed to workflows (keeps Workflow args small). */
export function workflowConfig(cfg) {
  const roles = {};
  for (const [n, r] of Object.entries(cfg.roles)) {
    if (!r.enabled) continue;
    roles[n] = {
      agentType: r.agentType, kind: r.kind, engine: r.engine, model: r.model, effort: r.effort,
      ...(r.final_model ? { final_model: r.final_model, final_effort: r.final_effort } : {}),
      ...(r.review_when ? { review_when: r.review_when } : {}),
    };
  }
  return {
    parallel: cfg.parallel,
    fix_loop_max: cfg.fix_loop_max,
    security_tags: cfg.security_tags,
    gemini: { enabled: !!cfg.gemini?.enabled, review_tasks: cfg.gemini?.review_tasks || 'risky' },
    roles,
  };
}
