// Offline tests for bin/devteam-agy using tests/fixtures/fake-agy.mjs (DEVTEAM_AGY points at it).
// HOME is redirected to a temp dir so Gemini worktrees (~/.cache/devteam/worktrees) never touch the real home.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'bin', 'devteam');
const AGY = path.join(ROOT, 'bin', 'devteam-agy');
const FAKE = path.join(ROOT, 'tests', 'fixtures', 'fake-agy.mjs');
fs.chmodSync(FAKE, 0o755);

const g = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

function setup({ gemini = true } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'devteam-agy-')));
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'devteam-home-')));
  g(dir, 'init', '-q', '-b', 'main');
  g(dir, 'config', 'user.email', 'test@example.com');
  g(dir, 'config', 'user.name', 'devteam test');
  fs.mkdirSync(path.join(dir, '.team'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.team', 'config.json'), JSON.stringify({ base_branch: 'main', gates: { fast: ['true'], contracts: [], full: [], security: [] }, gemini: { enabled: gemini }, roles: {} }));
  fs.writeFileSync(path.join(dir, '.gitignore'), '.team/runs/\n.team/current\n.team/context/\n.devteam/\n.claude/worktrees/\n');
  fs.mkdirSync(path.join(dir, 'apps', 'web'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'apps', 'api', 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'apps', 'web', 'page.tsx'), 'export default 1;\n');
  fs.writeFileSync(path.join(dir, 'apps', 'api', 'src', 'index.ts'), 'export const x = 1;\n');
  g(dir, 'add', '-A');
  g(dir, 'commit', '-q', '-m', 'init');
  const env = (mode, extra = {}) => ({ ...process.env, HOME: home, DEVTEAM_AGY: FAKE, FAKE_AGY_MODE: mode, FAKE_AGY_LOG: path.join(home, 'agy.log'), ...extra });
  const cli = (args, opts = {}) => spawnSync(CLI, args, { encoding: 'utf8', cwd: dir, env: env('ok'), ...opts });
  const agy = (args, mode, cwd = dir, extra) => {
    const r = spawnSync(AGY, args, { encoding: 'utf8', cwd, env: env(mode, extra), timeout: 120000 });
    const last = r.stdout.trim().split('\n').pop();
    return { ...r, json: JSON.parse(last) };
  };
  const calls = () => (fs.existsSync(path.join(home, 'agy.log')) ? fs.readFileSync(path.join(home, 'agy.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
  return { dir, home, cli, agy, calls };
}

function withTask(ctx) {
  const runDir = ctx.cli(['run', 'new', 'agy']).stdout.trim();
  fs.writeFileSync(path.join(runDir, 'plan.json'), JSON.stringify({ epic: 'agy', tasks: [
    { id: 'D1', title: 'docs', role: 'tech-writer', files: ['docs/api/new.md'], acceptance: ['doc exists'], low_risk: true },
  ] }));
  assert.equal(ctx.cli(['plan', 'check', runDir]).status, 0);
  assert.equal(ctx.cli(['run', 'epic', runDir]).status, 0);
  // the bridge's own worktree, where Claude Code puts it
  const wt = path.join(ctx.dir, '.claude', 'worktrees', 'agent-bridge');
  g(ctx.dir, 'worktree', 'add', '-q', '-b', 'worktree-agent-bridge', wt);
  return { runDir, wt };
}

const flag = (argv, name) => argv[argv.indexOf(name) + 1];
const grantsOf = (argv) => JSON.parse(flag(argv, '--settings')).permissions.allow;

// ---------------- self-test / availability ----------------
test('self-test: ok with agy, unavailable without it', () => {
  const ctx = setup();
  assert.equal(ctx.agy(['self-test'], 'ok').json.status, 'ok');
  const missing = ctx.agy(['self-test'], 'ok', ctx.dir, { DEVTEAM_AGY: '/nonexistent/agy' });
  assert.equal(missing.status, 0, 'never fails the caller');
  assert.equal(missing.json.status, 'unavailable');
  assert.match(missing.json.reason, /not installed|no JSON/);
});

test('gemini disabled in config → unavailable for every command except self-test', () => {
  const ctx = setup({ gemini: false });
  for (const args of [['map'], ['review', '--kind', 'task'], ['run', '--run', '/x', '--task', 'D1']]) {
    assert.equal(ctx.agy(args, 'ok').json.status, 'unavailable', args.join(' '));
  }
  assert.equal(ctx.calls().length, 0, 'agy is never invoked when disabled');
});

// ---------------- review ----------------
test('review: structured verdict, read-only grants, accept-edits mode, diff and context files written', () => {
  const ctx = setup();
  const { runDir } = withTask(ctx);
  fs.writeFileSync(path.join(runDir, 'spec.md'), '# spec\n');
  const r = ctx.agy(['review', '--kind', 'task', '--run', runDir, '--task', 'D1', '--base', 'main', '--head', 'HEAD'], 'ok');
  assert.equal(r.json.verdict, 'approve');
  assert.equal(r.json.engine, 'gemini');
  const call = ctx.calls().pop().argv;
  assert.equal(flag(call, '--mode'), 'accept-edits', 'plan mode denies every command');
  assert.ok(call.includes('--sandbox'));
  const grants = grantsOf(call);
  assert.ok(grants.some((x) => x === `read_file(${ctx.dir}/**)`));
  assert.ok(grants.includes('command(git diff)') && grants.includes('command(cat)'));
  assert.ok(!grants.some((x) => x.startsWith('write_file')), 'reviews get no write grant');
  assert.match(flag(call, '-p'), /Shell access is limited to read-only commands/);
  assert.ok(fs.existsSync(path.join(runDir, 'tasks', 'D1', 'agy-task.diff')));
  assert.ok(fs.existsSync(path.join(runDir, 'tasks', 'D1', 'agy-brief.md')));
  assert.equal(ctx.agy(['review', '--kind', 'task', '--run', runDir, '--task', 'D1'], 'changes').json.findings[0].severity, 'major');
});

test('review: denied command, quota and garbage all degrade to UNAVAILABLE with the reason', () => {
  const ctx = setup();
  const denied = ctx.agy(['review', '--kind', 'final'], 'denied').json;
  assert.match(denied.summary, /^UNAVAILABLE: agy returned no output \(denied: command\)/);
  assert.equal(denied.verdict, 'approve', 'schema-valid, and workflows ignore UNAVAILABLE lenses');
  const quota = ctx.agy(['review', '--kind', 'final'], 'quota').json;
  assert.match(quota.summary, /^UNAVAILABLE: .*(429|RESOURCE_EXHAUSTED|quota)/);
  assert.match(ctx.agy(['review', '--kind', 'final'], 'garbage').json.summary, /^UNAVAILABLE: agy produced no JSON/);
});

// ---------------- map ----------------
test('map: writes .team/context/map.md stamped with HEAD, then reports fresh', () => {
  const ctx = setup();
  const r = ctx.agy(['map'], 'ok');
  assert.equal(r.json.status, 'ok');
  const map = fs.readFileSync(path.join(ctx.dir, '.team', 'context', 'map.md'), 'utf8');
  assert.match(map, new RegExp(`head=${g(ctx.dir, 'rev-parse', 'HEAD')}`));
  assert.match(map, /fake map/);
  assert.equal(ctx.agy(['map'], 'ok').json.status, 'fresh');
  assert.equal(ctx.calls().length, 1, 'a fresh map costs no agy call');
});

// ---------------- run (overflow implementer) ----------------
test('run: works outside .claude/, keeps new-dir owned files, reverts unowned edits, commits and gates', () => {
  const ctx = setup();
  const { runDir, wt } = withTask(ctx);
  const r = ctx.agy(['run', '--run', runDir, '--task', 'D1'], 'edit', wt);
  assert.equal(r.json.status, 'done', JSON.stringify(r.json));
  assert.deepEqual(r.json.files_changed, ['docs/api/new.md'], 'the owned file in a new directory survives (regression: untracked dirs were collapsed and deleted)');
  assert.ok(r.json.risks.some((x) => /reverted out-of-ownership edits.*: apps\/web\/page\.tsx/.test(x)));
  assert.ok(r.json.worktree.startsWith(path.join(ctx.home, '.cache', 'devteam', 'worktrees')), `Gemini works outside the repo: ${r.json.worktree}`);
  assert.equal(ctx.calls().pop().cwd, fs.realpathSync(r.json.worktree));
  assert.match(r.json.branch, /^task\/agy\/D1/);
  assert.equal(g(ctx.dir, 'show', `${r.json.branch}:docs/api/new.md`), '# new doc');
  assert.equal(g(ctx.dir, 'show', `${r.json.branch}:apps/web/page.tsx`), 'export default 1;');
  assert.match(g(ctx.dir, 'log', '-1', '--format=%B', r.json.branch), /Engine: gemini/);
  const call = ctx.calls().pop().argv;
  assert.ok(grantsOf(call).some((x) => x.startsWith('write_file(') && x.includes('.cache/devteam/worktrees')));
  assert.ok(r.json.commands_run.some((c) => c.cmd === 'devteam gate' && c.exit_code === 0));
  // the integrator can merge the branch from the main checkout, and collect prunes the outside worktree
  const m = spawnSync(CLI, ['merge', r.json.branch, '--run', runDir, '--task', 'D1'], { encoding: 'utf8', cwd: ctx.dir, env: { ...process.env, HOME: ctx.home } });
  assert.equal(JSON.parse(m.stdout).status, 'merged', m.stdout + m.stderr);
  ctx.cli(['run', 'collect', runDir, '--prune']);
  assert.ok(!fs.existsSync(r.json.worktree), 'merged Gemini worktree removed');
});

test('run: claiming success without changes is reported as failed (no false success)', () => {
  const ctx = setup();
  const { runDir, wt } = withTask(ctx);
  const r = ctx.agy(['run', '--run', runDir, '--task', 'D1'], 'noop', wt);
  assert.equal(r.json.status, 'failed');
  assert.ok(r.json.risks.some((x) => /no file changes/.test(x)));
});

test('run: agy failures return a schema-complete unavailable report; blocked passes through', () => {
  const ctx = setup();
  const { runDir, wt } = withTask(ctx);
  const d = ctx.agy(['run', '--run', runDir, '--task', 'D1'], 'denied', wt).json;
  assert.equal(d.status, 'unavailable');
  for (const k of ['task_id', 'summary', 'branch', 'head_sha', 'worktree', 'files_changed', 'commands_run', 'contract_change_request']) assert.ok(k in d, k);
  assert.match(d.summary, /^UNAVAILABLE: agy returned no output/);
  const b = ctx.agy(['run', '--run', runDir, '--task', 'D1'], 'blocked', wt).json;
  assert.equal(b.status, 'needs_contract_change');
  assert.equal(b.contract_change_request, 'add field total to ProjectList');
});

test('a denied shell command is retried once with a no-shell instruction (run and review)', () => {
  const ctx = setup();
  const { runDir, wt } = withTask(ctx);
  const r = ctx.agy(['run', '--run', runDir, '--task', 'D1'], 'denied-once', wt);
  assert.equal(r.json.status, 'done', JSON.stringify(r.json));
  assert.deepEqual(r.json.files_changed, ['docs/api/new.md']);
  const calls = ctx.calls();
  assert.equal(calls.length, 2, 'exactly one retry');
  assert.match(flag(calls[1].argv, '-p'), /Do not run any shell commands at all/);
  assert.doesNotMatch(flag(calls[0].argv, '-p'), /Do not run any shell commands at all/);
  fs.rmSync(path.join(ctx.home, 'fake-agy-count'));
  const rv = ctx.agy(['review', '--kind', 'final'], 'denied-once', ctx.dir, { FAKE_AGY_THEN: 'review' }).json;
  assert.equal(rv.summary, 'review after retry');
  // a model that keeps doing it still degrades to unavailable, with both reasons
  const always = ctx.agy(['review', '--kind', 'final'], 'denied').json;
  assert.match(always.summary, /after a no-shell retry/);
});
