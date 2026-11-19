// Deterministic quality gate. Results are written to .devteam/gates.json stamped with HEAD,
// so the SubagentStop hook and reviewers can trust them without re-running anything.
import path from 'node:path';
import { git, shell, worktreeRoot, readJSON, writeJSON, nowIso, tail, matchAny } from './util.mjs';
import { effectiveConfig } from './config.mjs';
import { markerPath } from './task.mjs';

export const LEVELS = {
  fast: ['contracts', 'fast'],
  full: ['contracts', 'fast', 'full'],
  security: ['security'],
  contracts: ['contracts'],
  all: ['contracts', 'fast', 'full', 'security'],
};

export function changedFiles(wt, baseSha) {
  if (!baseSha) return [];
  const out = git(['diff', '--name-only', `${baseSha}...HEAD`], wt);
  return out ? out.split('\n').filter(Boolean) : [];
}

export function ownershipViolations(files, allowed) {
  return files.filter((f) => !f.startsWith('.devteam/') && !matchAny(f, allowed));
}

export function runGate({ level = 'fast', cwd = process.cwd(), skipOwnership = false, only } = {}) {
  const wt = worktreeRoot(cwd);
  if (!wt) throw new Error('not inside a git worktree');
  if (!LEVELS[level]) throw new Error(`unknown gate level ${level} (${Object.keys(LEVELS).join(', ')})`);
  const cfg = effectiveConfig(wt);
  const marker = readJSON(markerPath(wt), null);
  const head = git(['rev-parse', 'HEAD'], wt);
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], wt);
  const dirtyLines = git(['status', '--porcelain'], wt).split('\n').filter((l) => l && !l.includes('.devteam/'));
  const result = { level, head, branch, at: nowIso(), clean: dirtyLines.length === 0, dirty: dirtyLines.slice(0, 20), checks: [], ownership: null, pass: false };

  if (!result.clean) {
    result.reason = 'uncommitted changes: commit with `devteam commit "<message>"` before running the gate';
    return finish(wt, result);
  }
  if (marker && !skipOwnership) {
    const files = changedFiles(wt, marker.base_sha);
    const violations = ownershipViolations(files, marker.allowed);
    result.ownership = { ok: violations.length === 0, changed: files.length, violations };
    if (violations.length) {
      result.reason = `files outside your task ownership: ${violations.join(', ')}`;
      return finish(wt, result);
    }
  }
  const groups = LEVELS[level];
  const timeout = (cfg.gates?.timeout_sec || 900) * 1000;
  const commands = groups.flatMap((g) => (cfg.gates?.[g] || []).map((cmd) => ({ group: g, cmd })));
  for (const { group, cmd } of commands) {
    if (only && !cmd.includes(only)) continue;
    const t0 = Date.now();
    const r = shell(cmd, { cwd: wt, timeout, env: { ...process.env, CI: '1', FORCE_COLOR: '0' } });
    const secs = Math.round((Date.now() - t0) / 100) / 10;
    result.checks.push({ group, cmd, code: r.code, secs, tail: r.code === 0 ? '' : tail(`${r.out}\n${r.err}`, 60) });
    if (r.code !== 0) break; // fail fast: later checks usually depend on earlier ones
  }
  if (!commands.length) result.note = `no commands configured for level ${level} in .team/config.json`;
  result.pass = result.checks.every((c) => c.code === 0);
  if (!result.pass) result.reason = `failed: ${result.checks.find((c) => c.code !== 0).cmd}`;
  return finish(wt, result);
}

function finish(wt, result) {
  writeJSON(path.join(wt, '.devteam', `gates-${result.level}.json`), result);
  if (result.level === 'fast' || result.level === 'full' || result.level === 'all') writeJSON(path.join(wt, '.devteam', 'gates.json'), result);
  return result;
}

export function formatGate(r) {
  const L = [`gate ${r.level}: ${r.pass ? 'PASS' : 'FAIL'}  head=${r.head.slice(0, 12)} branch=${r.branch}`];
  if (!r.clean) L.push(`  dirty: ${r.dirty.join(' | ')}`);
  if (r.ownership) L.push(`  ownership: ${r.ownership.ok ? 'ok' : 'VIOLATION'} (${r.ownership.changed} files changed)${r.ownership.violations.length ? ' -> ' + r.ownership.violations.join(', ') : ''}`);
  for (const c of r.checks) {
    L.push(`  ${c.code === 0 ? 'ok  ' : 'FAIL'} [${c.group}] ${c.cmd} (${c.secs}s)`);
    if (c.code !== 0) L.push(c.tail.split('\n').map((l) => '      ' + l).join('\n'));
  }
  if (r.note) L.push(`  note: ${r.note}`);
  if (r.reason && !r.pass) L.push(`  reason: ${r.reason}`);
  return L.join('\n');
}

/** Used by the stop hook: is there a passing fast/full gate for the current HEAD with a clean tree? */
export function gateSatisfied(wt) {
  const g = readJSON(path.join(wt, '.devteam', 'gates.json'), null);
  if (!g) return { ok: false, why: 'no gate result yet: run `devteam gate`' };
  const head = git(['rev-parse', 'HEAD'], wt);
  const dirty = git(['status', '--porcelain'], wt).split('\n').filter((l) => l && !l.includes('.devteam/'));
  if (dirty.length) return { ok: false, why: `uncommitted changes (${dirty.slice(0, 3).join(', ')}): commit with \`devteam commit\`, then run \`devteam gate\`` };
  if (g.head !== head) return { ok: false, why: `last gate ran on ${g.head.slice(0, 10)} but HEAD is ${head.slice(0, 10)}: run \`devteam gate\` again` };
  if (!g.pass) return { ok: false, why: `gate is red: ${g.reason || 'see .devteam/gates.json'}` };
  return { ok: true, gate: g };
}
