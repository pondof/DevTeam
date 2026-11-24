// Serial merge queue step used by the integrator: merge one task branch into the epic branch,
// regenerate lockfiles on lockfile-only conflicts, gate the result, roll back on red.
import path from 'node:path';
import { git, tryGit, sh, shell, worktreeRoot, isLinkedWorktree, readJSON, matchAny, appendLedger, tail } from './util.mjs';
import { effectiveConfig } from './config.mjs';
import { updateState, loadPlan } from './run.mjs';
import { runGate } from './gate.mjs';

/** Find the worktree that has `branch` checked out and check its stamped gate result against the branch head. */
export function gateEvidence(root, branch) {
  const tip = tryGit(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], root);
  if (!tip) return { ok: false, why: `branch ${branch} does not exist` };
  const list = tryGit(['worktree', 'list', '--porcelain'], root) || '';
  for (const block of list.split('\n\n')) {
    const wt = (block.match(/^worktree (.+)$/m) || [])[1];
    const br = (block.match(/^branch refs\/heads\/(.+)$/m) || [])[1];
    if (!wt || br !== branch) continue;
    const g = readJSON(path.join(wt, '.devteam', 'gates.json'), null);
    if (!g) return { ok: false, worktree: wt, why: `no gate result in ${wt}/.devteam/gates.json: the task never ran \`devteam gate\`` };
    if (g.head !== tip) return { ok: false, worktree: wt, why: `gate ran on ${String(g.head).slice(0, 10)} but ${branch} is at ${tip.slice(0, 10)}` };
    if (!g.pass) return { ok: false, worktree: wt, why: `gate is red for ${tip.slice(0, 10)}: ${g.reason || 'see gates.json'}` };
    return { ok: true, worktree: wt, head: tip, level: g.level };
  }
  return { ok: false, why: `no worktree has ${branch} checked out, so there is no gate evidence (merge before \`devteam run collect --prune\`)` };
}

export function mergeBranch(branch, { runDir, taskId, gate = 'fast', allowUngated = false, cwd = process.cwd() } = {}) {
  const root = worktreeRoot(cwd);
  if (!root) throw new Error('not inside a git repository');
  if (isLinkedWorktree(cwd)) throw new Error('run merges from the main checkout, not a task worktree');
  const cfg = effectiveConfig(root);
  const dirty = git(['status', '--porcelain', '--untracked-files=no'], root);
  if (dirty) throw new Error('main checkout has uncommitted changes; refusing to merge');
  const run = runDir ? readJSON(path.join(runDir, 'run.json'), {}) : {};
  const current = git(['rev-parse', '--abbrev-ref', 'HEAD'], root);
  if (run.epic_branch && current !== run.epic_branch) throw new Error(`checked out ${current}, expected epic branch ${run.epic_branch}`);
  if (current === cfg.base_branch) throw new Error(`refusing to merge task branches directly into ${cfg.base_branch}`);
  const before = git(['rev-parse', 'HEAD'], root);
  const task = runDir && taskId ? (loadPlan(runDir)?.tasks || []).find((t) => t.id === taskId) : null;
  const msg = `merge ${taskId || branch}${task ? `: ${task.title}` : ''}`;
  const trailers = taskId ? ['--trailer', `Run: ${run.id || ''}`, '--trailer', `Task: ${taskId}`, '--trailer', 'Role: integrator'] : [];
  const out = { branch, task: taskId || null, before, status: 'merged', regenerated: [] };

  // A task branch merges only with evidence: a passing fast/full gate stamped with the branch's exact head,
  // found in the worktree that has the branch checked out (Claude or Gemini sibling worktree).
  if (runDir && taskId && !allowUngated) {
    const ev = gateEvidence(root, branch);
    out.gate_evidence = ev;
    if (!ev.ok) return record(runDir, taskId, { ...out, status: 'ungated', reason: ev.why });
  }

  const r = sh('git', ['merge', '--no-ff', '--no-edit', '-m', msg, branch], { cwd: root });
  if (r.code !== 0) {
    const conflicted = (git(['diff', '--name-only', '--diff-filter=U'], root) || '').split('\n').filter(Boolean);
    const regen = cfg.regenerable || [];
    if (conflicted.length && conflicted.every((f) => matchAny(f, regen))) {
      for (const f of conflicted) git(['checkout', '--theirs', '--', f], root);
      const rg = shell(cfg.regenerate_cmd || 'pnpm install --lockfile-only', { cwd: root, timeout: 600000 });
      if (rg.code !== 0) {
        sh('git', ['merge', '--abort'], { cwd: root });
        return record(runDir, taskId, { ...out, status: 'conflict', files: conflicted, reason: `lockfile regeneration failed: ${tail(rg.err || rg.out, 20)}` });
      }
      git(['add', '--', ...conflicted], root);
      const c = sh('git', ['commit', '--no-edit', ...trailers], { cwd: root });
      if (c.code !== 0) {
        sh('git', ['merge', '--abort'], { cwd: root });
        return record(runDir, taskId, { ...out, status: 'conflict', files: conflicted, reason: (c.err || c.out).trim() });
      }
      out.regenerated = conflicted;
    } else {
      sh('git', ['merge', '--abort'], { cwd: root });
      return record(runDir, taskId, { ...out, status: 'conflict', files: conflicted, reason: conflicted.length ? 'non-lockfile conflicts' : tail(r.err || r.out, 20) });
    }
  } else if (taskId) {
    // Amend the merge commit with trailers so `git log --grep "Task: T1"` finds the merge too.
    sh('git', ['commit', '--amend', '--no-edit', ...trailers], { cwd: root });
  }
  out.head = git(['rev-parse', 'HEAD'], root);
  if (gate && gate !== 'none') {
    const g = runGate({ level: gate, cwd: root });
    out.gate = { level: gate, pass: g.pass, reason: g.reason || null, failed: g.checks.filter((c) => c.code !== 0).map((c) => ({ cmd: c.cmd, tail: c.tail })) };
    if (!g.pass) {
      git(['reset', '--hard', before], root);
      out.status = 'gate_failed';
      out.head = before;
    }
  }
  return record(runDir, taskId, out);
}

function record(runDir, taskId, out) {
  if (runDir && taskId) {
    try {
      updateState(runDir, taskId, {
        status: { merged: 'merged', gate_failed: 'merge_gate_failed', ungated: 'merge_ungated' }[out.status] || 'merge_conflict',
        merged_head: out.status === 'merged' ? out.head : undefined,
        merge: out,
      });
    } catch { /* state is best effort */ }
    appendLedger(runDir, 'merge', `${taskId} ${out.status}${out.files ? ' files=' + out.files.join(',') : ''}${out.regenerated?.length ? ' regenerated=' + out.regenerated.join(',') : ''}${out.gate && !out.gate.pass ? ' gate=' + out.gate.reason : ''}${out.status === 'ungated' ? ' reason=' + out.reason : ''}`);
  }
  return out;
}
