// Run directories: .team/runs/<id>/ in the main checkout (git-ignored). Everything a run
// produces lands here: spec, design, plan, ledger, per-task state, reports, reviews, gates.
import fs from 'node:fs';
import path from 'node:path';
import { mainRoot, readJSON, writeJSON, exists, readText, nowIso, appendLedger, git, tryGit, sh } from './util.mjs';
import { effectiveConfig, workflowConfig } from './config.mjs';

export function runsDir(root) {
  return path.join(root, '.team', 'runs');
}

export function newRun(slug, cwd = process.cwd()) {
  const root = mainRoot(cwd);
  if (!root) throw new Error('not inside a git repository');
  const clean = String(slug || 'run').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'run';
  const stamp = nowIso().replace(/[-:]/g, '').replace('T', '-').slice(0, 13); // YYYYMMDD-HHMM
  let id = `${stamp}-${clean}`;
  let n = 2;
  while (exists(path.join(runsDir(root), id))) id = `${stamp}-${clean}-${n++}`;
  const dir = path.join(runsDir(root), id);
  fs.mkdirSync(path.join(dir, 'tasks'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'ledger.md'), `# devteam ledger — run ${id}\n\n`);
  writeJSON(path.join(dir, 'run.json'), { id, slug: clean, epic_branch: `team/${clean}`, created_at: nowIso(), root });
  fs.writeFileSync(path.join(root, '.team', 'current'), id + '\n');
  appendLedger(dir, 'run', `created run ${id}`);
  return dir;
}

export function currentRun(cwd = process.cwd()) {
  const root = mainRoot(cwd);
  if (!root) return null;
  const id = readText(path.join(root, '.team', 'current')).trim();
  if (!id) return null;
  const dir = path.join(runsDir(root), id);
  return exists(dir) ? dir : null;
}

export function resolveRunDir(arg, cwd = process.cwd()) {
  if (arg && arg !== 'current') {
    const p = path.resolve(cwd, arg);
    if (exists(path.join(p, 'ledger.md'))) return p;
    const root = mainRoot(cwd);
    if (root && exists(path.join(runsDir(root), arg, 'ledger.md'))) return path.join(runsDir(root), arg);
    throw new Error(`no run directory at ${arg}`);
  }
  const cur = currentRun(cwd);
  if (!cur) throw new Error('no current run (start one with `devteam run new <slug>`)');
  return cur;
}

export function taskDir(runDir, taskId) {
  return path.join(runDir, 'tasks', taskId);
}

export function readState(runDir, taskId) {
  return readJSON(path.join(taskDir(runDir, taskId), 'state.json'), {});
}

export function updateState(runDir, taskId, patch) {
  const p = path.join(taskDir(runDir, taskId), 'state.json');
  const next = { ...readJSON(p, {}), ...patch, updated_at: nowIso() };
  writeJSON(p, next);
  return next;
}

export function loadPlan(runDir) {
  return readJSON(path.join(runDir, 'plan.json'), null);
}

export function runStatus(runDir, { brief = false } = {}) {
  const run = readJSON(path.join(runDir, 'run.json'), {});
  const plan = loadPlan(runDir);
  const lines = [];
  lines.push(`run ${run.id || path.basename(runDir)}  epic=${run.epic_branch || '?'}  dir=${runDir}`);
  const has = (f) => exists(path.join(runDir, f));
  lines.push(`artifacts: spec=${has('spec.md') ? 'yes' : 'no'} design=${has('design.md') ? 'yes' : 'no'} plan=${plan ? `${plan.tasks.length} tasks / ${(plan.waves || []).length} waves` : 'no'}`);
  if (plan) {
    const counts = {};
    const rows = [];
    plan.tasks.forEach((t) => {
      const s = readState(runDir, t.id);
      const status = s.status || 'pending';
      counts[status] = (counts[status] || 0) + 1;
      const wave = (plan.waves || []).findIndex((w) => w.includes(t.id));
      rows.push(`  ${t.id.padEnd(6)} w${wave + 1} ${t.role.padEnd(18)} ${status.padEnd(14)} gates=${s.gates || '-'} attempts=${s.attempts || 0} engine=${s.engine || t.engine || '-'}  ${t.title}`);
    });
    lines.push('tasks: ' + Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(' '));
    if (!brief) lines.push(...rows);
  }
  const ledger = readText(path.join(runDir, 'ledger.md')).trim().split('\n').filter((l) => l.startsWith('- '));
  lines.push(`ledger (last ${brief ? 5 : 15}):`);
  lines.push(...ledger.slice(brief ? -5 : -15).map((l) => '  ' + l));
  return lines.join('\n');
}

/** JSON args for a workflow call. Kept compact: workflows read briefs and specs from disk. */
export function workflowArgs(runDir, workflow, flags = {}) {
  const run = readJSON(path.join(runDir, 'run.json'), {});
  const root = run.root || mainRoot(runDir);
  const cfg = effectiveConfig(root);
  const out = { runDir, epicBranch: run.epic_branch, baseBranch: cfg.base_branch, mode: flags.mode || (workflow === 'build' ? 'feature' : workflow), cfg: workflowConfig(cfg) };
  if (workflow === 'design') {
    out.specPath = path.join(runDir, 'spec.md');
    out.mapPath = path.join(root, '.team', 'context', 'map.md');
    if (flags.feedback) out.feedback = String(flags.feedback);
    return out;
  }
  if (workflow === 'review') {
    out.base = flags.base || cfg.base_branch;
    out.head = flags.head || 'HEAD';
    out.mode = flags.mode || 'diff';
    if (flags.focus) out.focus = String(flags.focus);
    return out;
  }
  const plan = loadPlan(runDir);
  if (!plan || !plan.waves) throw new Error('plan.json missing or unchecked; run `devteam plan check` first');
  const only = flags.tasks ? String(flags.tasks).split(',').map((s) => s.trim()).filter(Boolean) : null;
  const done = plan.tasks.filter((t) => readState(runDir, t.id).status === 'merged').map((t) => t.id);
  out.plan = {
    waves: plan.waves,
    tasks: plan.tasks.map((t) => ({
      id: t.id, title: t.title, role: t.role, files: t.files, depends_on: t.depends_on || [],
      risk: t.risk || [], ...(t.engine ? { engine: t.engine } : {}), ...(t.low_risk ? { low_risk: true } : {}),
    })),
  };
  if (only) out.only = only;
  if (done.length && !flags.redo) out.done = done.filter((id) => !only || !only.includes(id));
  if (plan.deps_prep?.length && !done.length) out.deps_prep = plan.deps_prep;
  if (flags.overflow) out.overflow = true;
  if (flags.final === 'false' || out.mode === 'quick') out.final = false;
  return out;
}

/** Copy .devteam/*.json from task worktrees into the run dir; optionally remove merged worktrees. */
export function collect(runDir, { prune = false } = {}) {
  const root = mainRoot(runDir);
  const list = tryGit(['worktree', 'list', '--porcelain'], root) || '';
  const head = tryGit(['rev-parse', 'HEAD'], root);
  const found = [];
  for (const block of list.split('\n\n')) {
    const wt = (block.match(/^worktree (.+)$/m) || [])[1];
    if (!wt || path.resolve(wt) === path.resolve(root)) continue;
    const task = readJSON(path.join(wt, '.devteam', 'task.json'), null);
    if (!task || path.resolve(task.runDir) !== path.resolve(runDir)) continue;
    const dest = taskDir(runDir, task.taskId);
    fs.mkdirSync(dest, { recursive: true });
    for (const f of fs.readdirSync(path.join(wt, '.devteam'))) {
      if (f.endsWith('.json') && f !== 'task.json') fs.copyFileSync(path.join(wt, '.devteam', f), path.join(dest, `wt-${f}`));
    }
    const wtHead = tryGit(['rev-parse', 'HEAD'], wt);
    const merged = !!(wtHead && head && sh('git', ['merge-base', '--is-ancestor', wtHead, head], { cwd: root }).code === 0);
    found.push({ task: task.taskId, worktree: wt, head: wtHead, merged });
    if (prune && merged) {
      sh('git', ['worktree', 'remove', '--force', wt], { cwd: root });
      appendLedger(runDir, 'collect', `removed merged worktree for ${task.taskId}`);
    }
  }
  // Worktrees whose directories were already removed (e.g. by the workflow's own cleanup) leave stale metadata.
  if (prune) sh('git', ['worktree', 'prune'], { cwd: root });
  return found;
}

/**
 * Delete this run's task branches that are fully merged into the epic branch (git branch -d semantics:
 * unmerged branches are kept and reported). Commit trailers keep the audit trail after deletion.
 */
export function cleanupBranches(runDir) {
  const run = readJSON(path.join(runDir, 'run.json'));
  const root = run.root;
  sh('git', ['worktree', 'prune'], { cwd: root });
  const list = (tryGit(['for-each-ref', '--format=%(refname:short)', `refs/heads/task/${run.slug}/`], root) || '').split('\n').filter(Boolean);
  const deleted = [];
  const kept = [];
  for (const b of list) {
    const merged = sh('git', ['merge-base', '--is-ancestor', b, run.epic_branch], { cwd: root }).code === 0;
    if (!merged) { kept.push({ branch: b, reason: `not merged into ${run.epic_branch}` }); continue; }
    const r = sh('git', ['branch', '-D', b], { cwd: root }); // ancestry checked above against the epic, not HEAD
    if (r.code === 0) deleted.push(b); else kept.push({ branch: b, reason: (r.err || r.out).trim() });
  }
  if (deleted.length) appendLedger(runDir, 'cleanup', `deleted merged task branches: ${deleted.join(', ')}`);
  return { deleted, kept };
}

export function ensureEpicBranch(runDir) {
  const run = readJSON(path.join(runDir, 'run.json'));
  const root = run.root;
  const current = git(['rev-parse', '--abbrev-ref', 'HEAD'], root);
  if (current === run.epic_branch) return { branch: current, created: false };
  const existsBranch = tryGit(['rev-parse', '--verify', '--quiet', `refs/heads/${run.epic_branch}`], root);
  const dirty = git(['status', '--porcelain', '--untracked-files=no'], root);
  if (dirty) throw new Error(`main checkout has uncommitted changes; commit or stash before switching to ${run.epic_branch}`);
  git(existsBranch ? ['checkout', run.epic_branch] : ['checkout', '-b', run.epic_branch], root);
  appendLedger(runDir, 'branch', `${existsBranch ? 'switched to' : 'created'} ${run.epic_branch} from ${current}`);
  return { branch: run.epic_branch, created: !existsBranch, from: current };
}
