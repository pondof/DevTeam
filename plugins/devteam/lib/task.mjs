// Task lifecycle inside an isolated worktree: start (brief + ownership marker), commit (trailers).
import fs from 'node:fs';
import path from 'node:path';
import { PLUGIN_ROOT, git, tryGit, sh, worktreeRoot, mainRoot, isLinkedWorktree, readJSON, writeJSON, readText, exists, nowIso, appendLedger } from './util.mjs';
import { effectiveConfig } from './config.mjs';
import { loadPlan, readState, updateState, taskDir } from './run.mjs';

export function markerPath(wt) {
  return path.join(wt, '.devteam', 'task.json');
}

export function readTaskMarker(cwd = process.cwd()) {
  const wt = worktreeRoot(cwd);
  return wt ? readJSON(markerPath(wt), null) : null;
}

function ensureExcluded(wt) {
  const common = tryGit(['rev-parse', '--path-format=absolute', '--git-common-dir'], wt);
  if (!common) return;
  const ex = path.join(common, 'info', 'exclude');
  const cur = readText(ex);
  if (!cur.split('\n').includes('.devteam/')) {
    fs.mkdirSync(path.dirname(ex), { recursive: true });
    fs.appendFileSync(ex, (cur.endsWith('\n') || !cur ? '' : '\n') + '.devteam/\n');
  }
}

function safeState(runDir, taskId, patch) {
  try { return updateState(runDir, taskId, patch); } catch { return null; }
}

export function startTask(runDir, taskId, { role: roleOverride, allowMain = false, engine = 'claude' } = {}) {
  const wt = worktreeRoot();
  if (!wt) throw new Error('not inside a git worktree');
  const plan = loadPlan(runDir);
  if (!plan) throw new Error(`no plan.json in ${runDir}`);
  const task = plan.tasks.find((t) => t.id === taskId);
  if (!task) throw new Error(`task ${taskId} not in plan`);
  const cfg = effectiveConfig(wt);
  const roleName = roleOverride || task.role;
  const role = cfg.roles[roleName];
  if (!role) throw new Error(`unknown role ${roleName}`);
  if (!isLinkedWorktree() && !allowMain) {
    throw new Error('implementers must run in an isolated worktree (dispatch with isolation: worktree), or pass --allow-main for a deliberate serial run');
  }
  const dirty = git(['status', '--porcelain'], wt).split('\n').filter((l) => l && !l.includes('.devteam/'));
  const prev = readState(runDir, taskId);
  const startHead = git(['rev-parse', 'HEAD'], wt);
  // Resume from the owner's last attempt, or from a support role's commit (e.g. the debugger's failing test).
  const resumeHead = roleName === task.role ? (prev.head || prev.support_head) : prev.support_head;
  let resumedFrom = null;
  if (resumeHead && resumeHead !== startHead && isLinkedWorktree()) {
    if (dirty.length) throw new Error(`worktree has uncommitted changes; cannot resume ${taskId} from ${resumeHead.slice(0, 10)}`);
    git(['reset', '--hard', resumeHead], wt);
    resumedFrom = resumeHead;
  }
  const run = readJSON(path.join(runDir, 'run.json'), {});
  const slug = run.slug || 'run';
  let branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], wt);
  if (isLinkedWorktree() && !branch.startsWith(`task/${slug}/`)) {
    let name = `task/${slug}/${taskId}`;
    for (let n = 2; tryGit(['rev-parse', '--verify', '--quiet', `refs/heads/${name}`], wt); n++) name = `task/${slug}/${taskId}-${n}`;
    git(['branch', '-m', name], wt);
    branch = name;
  }
  const baseSha = prev.base_sha || startHead;
  const allowed = roleName === task.role
    ? [...task.files, ...(cfg.regenerable || [])]
    : [...(role.owns || []), ...(cfg.regenerable || [])];
  const marker = {
    runDir, taskId, role: roleName, task_role: task.role, epic: run.epic_branch, slug, run_id: run.id,
    base_sha: baseSha, allowed, branch, worktree: wt, engine, started_at: nowIso(),
    gate_required: role.kind === 'implementer',
  };
  fs.mkdirSync(path.join(wt, '.devteam'), { recursive: true });
  ensureExcluded(wt);
  writeJSON(markerPath(wt), marker);
  fs.rmSync(path.join(wt, '.devteam', 'stop-blocks'), { force: true });
  safeState(runDir, taskId, {
    status: 'in_progress', role: roleName, branch, worktree: wt, base_sha: baseSha, engine,
    attempts: (prev.attempts || 0) + (roleName === task.role ? 1 : 0),
  });
  appendLedger(runDir, 'task', `${taskId} started by ${roleName} (${engine}) in ${branch}${resumedFrom ? ` resumed from ${resumedFrom.slice(0, 10)}` : ''}`);
  return { marker, brief: renderBrief(runDir, task, roleName, marker, cfg, plan, resumedFrom) };
}

export function renderBrief(runDir, task, roleName, marker, cfg, plan, resumedFrom) {
  const root = mainRoot(runDir) || marker?.worktree;
  const L = [];
  L.push(`# Brief — ${task.id}: ${task.title}`);
  L.push(`run: ${runDir}`);
  L.push(`role: ${roleName}${roleName !== task.role ? ` (support for ${task.role})` : ''}   branch: ${marker?.branch || '?'}   worktree: ${marker?.worktree || '?'}`);
  L.push(`epic base: ${marker?.base_sha?.slice(0, 12) || '?'}   contracts at: ${plan.contract_sha ? plan.contract_sha.slice(0, 12) : 'n/a'}`);
  if (resumedFrom) L.push(`NOTE: this worktree was reset to the previous attempt's commit ${resumedFrom.slice(0, 12)}; continue from it.`);
  L.push('', '## Goal', task.notes || task.title);
  if (task.acceptance?.length) { L.push('', '## Acceptance criteria'); task.acceptance.forEach((a) => L.push(`- ${a}`)); }
  L.push('', '## Files you may change (enforced by hook and gate)');
  (marker?.allowed || task.files).forEach((f) => L.push(`- ${f}`));
  if (task.deps?.length) L.push('', '## Planned dependencies (installed by the integrator before this wave)', ...task.deps.map((d) => `- ${d}`));
  L.push('', '## Context (read only what your task needs)');
  if (exists(path.join(runDir, 'spec.md'))) L.push(`- spec: ${path.join(runDir, 'spec.md')}`);
  if (exists(path.join(runDir, 'design.md'))) L.push(`- design: ${path.join(runDir, 'design.md')}`);
  const map = root && path.join(root, '.team', 'context', 'map.md');
  if (map && exists(map)) L.push(`- repo map: ${map} (use it instead of exploring the repo)`);
  if (task.contract_refs?.length) L.push(`- contract refs: ${task.contract_refs.join(', ')} (packages/contracts/)`);
  for (const dep of task.depends_on || []) {
    const rep = readJSON(path.join(taskDir(runDir, dep), 'report.json'), null);
    const st = readState(runDir, dep);
    L.push(`- dependency ${dep} [${st.status || 'unknown'}]: ${rep?.summary ? rep.summary.slice(0, 300) : '(no report)'}`);
  }
  const feedback = path.join(taskDir(runDir, task.id), 'feedback.md');
  if (exists(feedback) && roleName === task.role) {
    L.push('', '## Review feedback to address (from the previous round)', readText(feedback).trim());
  }
  const g = cfg.gates || {};
  const fast = [...(g.contracts || []), ...(g.fast || [])];
  L.push('', '## Gate', `\`devteam gate\` runs: ${fast.length ? fast.map((c) => `\`${c}\``).join(', ') : '(no commands configured — ownership and clean-tree checks only)'}`);
  const protocol = readText(path.join(PLUGIN_ROOT, 'templates', roleName === task.role ? 'protocol-implementer.md' : 'protocol-support.md'));
  L.push('', protocol.trim());
  return L.join('\n') + '\n';
}

/** Forget previous attempts so the next start begins from the epic branch again. */
export function resetTask(runDir, taskId) {
  const p = path.join(taskDir(runDir, taskId), 'state.json');
  const prev = readJSON(p, {});
  writeJSON(p, { attempts: prev.attempts || 0, status: 'pending', reset_at: nowIso(), previous_head: prev.head || null });
  fs.rmSync(path.join(taskDir(runDir, taskId), 'feedback.md'), { force: true });
  appendLedger(runDir, 'task', `${taskId} reset (previous head ${prev.head ? prev.head.slice(0, 10) : 'none'})`);
}

export function commitTask(message, cwd = process.cwd()) {
  const wt = worktreeRoot(cwd);
  const m = readJSON(markerPath(wt), null);
  if (!message) throw new Error('commit message required');
  git(['add', '-A'], wt);
  const staged = git(['diff', '--cached', '--name-only'], wt);
  if (!staged) return { committed: false, head: git(['rev-parse', 'HEAD'], wt) };
  const args = ['commit', '-q', '-m', message];
  if (m) {
    args.push('--trailer', `Run: ${m.run_id || path.basename(m.runDir)}`, '--trailer', `Task: ${m.taskId}`, '--trailer', `Role: ${m.role}`, '--trailer', `Engine: ${m.engine || 'claude'}`);
  }
  const r = sh('git', args, { cwd: wt });
  if (r.code !== 0) throw new Error(`git commit failed: ${(r.err || r.out).trim()}`);
  return { committed: true, head: git(['rev-parse', 'HEAD'], wt), files: staged.split('\n') };
}
