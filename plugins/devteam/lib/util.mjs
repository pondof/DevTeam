// Shared helpers for the devteam CLI, hooks and the agy wrapper. No dependencies beyond Node 20+.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function sh(cmd, args = [], opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
  return { code: r.status ?? (r.error ? 127 : 1), out: r.stdout || '', err: r.stderr || (r.error ? String(r.error.message) : '') };
}

export function shell(command, opts = {}) {
  return sh('/bin/sh', ['-c', command], opts);
}

export function git(args, cwd) {
  const r = sh('git', args, { cwd });
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${(r.err || r.out).trim()}`);
  return r.out.trim();
}

export function tryGit(args, cwd) {
  const r = sh('git', args, { cwd });
  return r.code === 0 ? r.out.trim() : null;
}

/** Top level of the worktree that contains cwd (a task worktree or the main checkout). */
export function worktreeRoot(cwd = process.cwd()) {
  return tryGit(['rev-parse', '--show-toplevel'], cwd);
}

/** Root of the main checkout, even when cwd is inside a linked worktree. */
export function mainRoot(cwd = process.cwd()) {
  const common = tryGit(['rev-parse', '--path-format=absolute', '--git-common-dir'], cwd);
  if (!common) return null;
  return path.basename(common) === '.git' ? path.dirname(common) : worktreeRoot(cwd);
}

export function isLinkedWorktree(cwd = process.cwd()) {
  const wt = worktreeRoot(cwd);
  const main = mainRoot(cwd);
  return !!wt && !!main && path.resolve(wt) !== path.resolve(main);
}

export function readJSON(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    if (fallback !== undefined) return fallback;
    throw new Error(`cannot read JSON ${p}: ${e.message}`);
  }
}

export function writeJSON(p, value) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(value, null, 2) + '\n');
}

export function readText(p, fallback = '') {
  try { return fs.readFileSync(p, 'utf8'); } catch { return fallback; }
}

export function exists(p) {
  try { fs.accessSync(p); return true; } catch { return false; }
}

export function nowIso() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function die(msg, code = 1) {
  process.stderr.write(`devteam: ${msg}\n`);
  process.exit(code);
}

/** Convert a glob (supports **, *, ?, trailing /) to an anchored RegExp over forward-slash paths. */
export function globToRegExp(glob) {
  let g = String(glob).trim().replace(/^\.\//, '');
  if (g.endsWith('/')) g += '**';
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        if (g[i + 2] === '/') { re += '(?:.*/)?'; i += 2; } else { re += '.*'; i += 1; }
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if ('\\^$+.()|{}[]'.includes(c)) re += '\\' + c;
    else re += c;
  }
  return new RegExp('^' + re + '$');
}

export function normalizeRel(p) {
  return String(p).replace(/\\/g, '/').replace(/^\.\//, '');
}

export function matchAny(file, globs) {
  const f = normalizeRel(file);
  return (globs || []).some((g) => globToRegExp(g).test(f));
}

const WILDCARD = /[*?]/;

/** A representative concrete path for a pattern (used to test a task glob against role ownership). */
export function samplePath(pattern) {
  const p = normalizeRel(pattern);
  if (!WILDCARD.test(p) && !p.endsWith('/')) return p;
  return p.replace(/\/$/, '/**').replace(/\*\*/g, 'x/x').replace(/\*/g, 'x').replace(/\?/g, 'x');
}

/** Do two path patterns possibly refer to a common file? Conservative: true when unsure. */
export function patternsOverlap(a, b) {
  const pa = normalizeRel(a), pb = normalizeRel(b);
  if (pa === pb) return true;
  if (globToRegExp(pa).test(samplePath(pb)) || globToRegExp(pb).test(samplePath(pa))) return true;
  const prefix = (p) => p.split(WILDCARD)[0];
  const xa = prefix(pa), xb = prefix(pb);
  const wa = WILDCARD.test(pa), wb = WILDCARD.test(pb);
  if (wa && wb) return xa.startsWith(xb) || xb.startsWith(xa);
  if (wa) return pb.startsWith(xa) && globToRegExp(pa).test(pb);
  if (wb) return pa.startsWith(xb) && globToRegExp(pb).test(pa);
  return false;
}

export function parseFlags(argv) {
  const flags = {}; const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { rest.push(...argv.slice(i + 1)); break; }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) flags[a.slice(2, eq)] = a.slice(eq + 1);
      else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) flags[a.slice(2)] = argv[++i];
      else flags[a.slice(2)] = true;
    } else rest.push(a);
  }
  return { flags, rest };
}

export function tail(text, lines = 60) {
  const arr = String(text || '').replace(/\s+$/, '').split('\n');
  return arr.slice(-lines).join('\n');
}

export function appendLedger(runDir, event, message) {
  if (!runDir || !exists(runDir)) return;
  const line = `- ${nowIso()} [${event}] ${String(message).replace(/\n+/g, ' ').slice(0, 400)}\n`;
  try { fs.appendFileSync(path.join(runDir, 'ledger.md'), line); } catch { /* sandboxed callers may not write here; hooks will */ }
}
