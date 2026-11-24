// node --test tests — fixture tests for the devteam CLI, scheduler, gates, merges and hooks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'bin', 'devteam');
const U = await import(path.join(ROOT, 'lib', 'util.mjs'));
const P = await import(path.join(ROOT, 'lib', 'plan.mjs'));
const C = await import(path.join(ROOT, 'lib', 'config.mjs'));

const run = (args, opts = {}) => spawnSync(CLI, args, { encoding: 'utf8', ...opts });
const hook = (name, input) => spawnSync(CLI, ['hook', name], { encoding: 'utf8', input: JSON.stringify(input) });
const g = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

function tempRepo(config = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'devteam-test-')));
  g(dir, 'init', '-q', '-b', 'main');
  g(dir, 'config', 'user.email', 'test@example.com');
  g(dir, 'config', 'user.name', 'devteam test');
  fs.mkdirSync(path.join(dir, '.team'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.team', 'config.json'), JSON.stringify({ base_branch: 'main', gates: { fast: ['true'], contracts: [], full: [], security: [] }, roles: {}, ...config }, null, 2));
  fs.writeFileSync(path.join(dir, '.gitignore'), '.team/runs/\n.team/current\n.devteam/\n.claude/worktrees/\n');
  fs.mkdirSync(path.join(dir, 'apps', 'api', 'src'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'apps', 'web'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'apps', 'api', 'src', 'index.ts'), 'export const x = 1;\n');
  fs.writeFileSync(path.join(dir, 'apps', 'web', 'page.tsx'), 'export default 1;\n');
  fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), 'lock: base\n');
  g(dir, 'add', '-A');
  g(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

function writePlan(runDir, tasks) {
  fs.writeFileSync(path.join(runDir, 'plan.json'), JSON.stringify({ epic: 'demo', tasks }, null, 2));
}

// ---------------- globs and scheduling ----------------
test('glob matching and overlap', () => {
  assert.ok(U.matchAny('apps/api/src/a.ts', ['apps/api/**']));
  assert.ok(!U.matchAny('apps/web/a.ts', ['apps/api/**']));
  assert.ok(U.matchAny('tests/e2e/x.e2e.ts', ['**/*.e2e.ts']));
  assert.ok(U.patternsOverlap('apps/api/src/routes/**', 'apps/api/src/routes/p.ts'));
  assert.ok(!U.patternsOverlap('apps/api/src/a.ts', 'apps/api/src/b.ts'));
  assert.ok(!U.patternsOverlap('apps/api/**', 'apps/web/**'));
});

test('plan validation catches ownership, hot files, unknown deps and cycles', () => {
  const cfg = C.effectiveConfig(os.tmpdir());
  const bad = P.validatePlan({ tasks: [
    { id: 'T1', title: 'a', role: 'backend-engineer', files: ['apps/web/x.tsx'], acceptance: ['x'] },
    { id: 'T2', title: 'b', role: 'frontend-engineer', files: ['package.json'], acceptance: ['x'], depends_on: ['T9'] },
  ] }, cfg);
  assert.ok(bad.errors.some((e) => e.includes('outside backend-engineer ownership')));
  assert.ok(bad.errors.some((e) => e.includes('hot file')));
  assert.ok(bad.errors.some((e) => e.includes('unknown task "T9"')));
  const cyc = P.validatePlan({ tasks: [
    { id: 'A', title: 'a', role: 'backend-engineer', files: ['apps/api/a.ts'], acceptance: ['x'], depends_on: ['B'] },
    { id: 'B', title: 'b', role: 'backend-engineer', files: ['apps/api/b.ts'], acceptance: ['x'], depends_on: ['A'] },
  ] }, cfg);
  assert.ok(cyc.errors.some((e) => e.includes('cycle')));
});

test('waves: parallel when files are disjoint, serialized on overlap, deps respected', () => {
  const waves = P.computeWaves([
    { id: 'T1', files: ['apps/api/src/projects.ts'] },
    { id: 'T2', files: ['apps/web/app/projects/page.tsx'] },
    { id: 'T3', files: ['tests/e2e/projects.e2e.ts'] },
    { id: 'T4', files: ['apps/api/src/projects.ts', 'apps/api/src/tasks.ts'] },
    { id: 'T5', files: ['docs/**'], depends_on: ['T1', 'T2'] },
  ]);
  assert.deepEqual(waves, [['T1', 'T2', 'T3'], ['T4'], ['T5']]);
});

// ---------------- hooks: bash guard ----------------
test('pre-bash denies dangerous commands in devteam projects and agent pushes', () => {
  const dir = tempRepo();
  const deny = (command, agent) => hook('pre-bash', { cwd: dir, tool_input: { command }, ...(agent ? { agent_type: 'devteam:backend-engineer' } : {}) }).status;
  assert.equal(deny('git push --force origin team/x'), 2);
  assert.equal(deny('git push origin main'), 2);
  assert.equal(deny('git clean -fdx'), 2);
  assert.equal(deny('cat .env'), 2);
  assert.equal(deny('cat .env.example'), 0);
  assert.equal(deny('terraform apply -auto-approve'), 2);
  assert.equal(deny('kubectl apply -f x.yaml'), 2);
  assert.equal(deny('kubectl --context kind-dev apply -f x.yaml'), 0);
  assert.equal(deny('pnpm -s test'), 0);
  assert.equal(deny('git push -u origin team/demo'), 0, 'humans may push team branches');
  assert.equal(deny('git push -u origin team/demo', true), 2, 'agents never push');
  assert.equal(deny('git commit -m x', true), 2, 'agents never commit on main');
  // outside a devteam project, non-agent sessions are untouched
  const plain = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'plain-')));
  g(plain, 'init', '-q');
  assert.equal(hook('pre-bash', { cwd: plain, tool_input: { command: 'git push --force' } }).status, 0);
});

// ---------------- task lifecycle, ownership, gate, stop hook ----------------
function setupTask() {
  const dir = tempRepo();
  const runDir = run(['run', 'new', 'demo'], { cwd: dir }).stdout.trim();
  writePlan(runDir, [
    { id: 'T1', title: 'api change', role: 'backend-engineer', files: ['apps/api/src/index.ts', 'apps/api/src/index.test.ts'], acceptance: ['works'], risk: [] },
    { id: 'T2', title: 'web change', role: 'frontend-engineer', files: ['apps/web/page.tsx'], acceptance: ['works'] },
  ]);
  assert.equal(run(['plan', 'check', runDir], { cwd: dir }).status, 0);
  assert.equal(run(['run', 'epic', runDir], { cwd: dir }).status, 0);
  const wt = path.join(dir, '.claude', 'worktrees', 'agent-test1');
  g(dir, 'worktree', 'add', '-q', '-b', 'worktree-agent-test1', wt);
  return { dir, runDir, wt };
}

test('task start writes the marker, renames the branch and prints the brief', () => {
  const { runDir, wt } = setupTask();
  const r = run(['task', 'start', runDir, 'T1'], { cwd: wt });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Brief — T1: api change/);
  assert.match(r.stdout, /apps\/api\/src\/index\.ts/);
  const marker = JSON.parse(fs.readFileSync(path.join(wt, '.devteam', 'task.json'), 'utf8'));
  assert.equal(marker.branch, 'task/demo/T1');
  assert.equal(g(wt, 'rev-parse', '--abbrev-ref', 'HEAD'), 'task/demo/T1');
  assert.ok(marker.allowed.includes('pnpm-lock.yaml'));
});

test('implementers must run in a worktree unless --allow-main', () => {
  const { dir, runDir } = setupTask();
  assert.notEqual(run(['task', 'start', runDir, 'T1'], { cwd: dir }).status, 0);
});

test('pre-edit enforces task ownership inside the worktree', () => {
  const { runDir, wt } = setupTask();
  const edit = (file, agent = 'devteam:backend-engineer') => hook('pre-edit', { cwd: wt, agent_type: agent, tool_input: { file_path: path.join(wt, file) } });
  assert.equal(edit('apps/api/src/index.ts').status, 2, 'no marker yet: must run task start first');
  run(['task', 'start', runDir, 'T1'], { cwd: wt });
  assert.equal(edit('apps/api/src/index.ts').status, 0);
  const denied = edit('apps/web/page.tsx');
  assert.equal(denied.status, 2);
  assert.match(denied.stderr, /may not change apps\/web\/page\.tsx/);
  assert.equal(edit('.devteam/gates.json').status, 2, 'gate results cannot be forged');
  assert.equal(hook('pre-edit', { cwd: wt, agent_type: 'devteam:code-reviewer', tool_input: { file_path: path.join(wt, 'apps/api/src/index.ts') } }).status, 2, 'reviewers are read-only');
  assert.equal(hook('pre-edit', { cwd: wt, tool_input: { file_path: path.join(wt, 'apps/web/page.tsx') } }).status, 0, 'the human session is not restricted');
});

test('gate: clean tree, ownership on the diff, commands, HEAD stamp', () => {
  const { runDir, wt } = setupTask();
  run(['task', 'start', runDir, 'T1'], { cwd: wt });
  fs.writeFileSync(path.join(wt, 'apps/api/src/index.ts'), 'export const x = 2;\n');
  let r = run(['gate', '--json'], { cwd: wt });
  assert.equal(r.status, 1);
  assert.match(JSON.parse(r.stdout).reason, /uncommitted/);
  assert.equal(run(['commit', 'T1: change x'], { cwd: wt }).status, 0);
  assert.match(g(wt, 'log', '-1', '--format=%B'), /Task: T1/);
  r = run(['gate', '--json'], { cwd: wt });
  assert.equal(r.status, 0, r.stdout);
  const res = JSON.parse(r.stdout);
  assert.equal(res.head, g(wt, 'rev-parse', 'HEAD'));
  // an out-of-ownership change sneaking in through Bash is caught by the gate
  fs.writeFileSync(path.join(wt, 'apps/web/page.tsx'), 'export default 2;\n');
  run(['commit', 'T1: sneaky'], { cwd: wt });
  r = run(['gate', '--json'], { cwd: wt });
  assert.equal(r.status, 1);
  assert.deepEqual(JSON.parse(r.stdout).ownership.violations, ['apps/web/page.tsx']);
});

test('gate runs configured commands and fails fast', () => {
  const dir = tempRepo({ gates: { contracts: ['true'], fast: ['false', 'echo never'], full: [], security: [] } });
  const r = run(['gate', '--json'], { cwd: dir });
  const res = JSON.parse(r.stdout);
  assert.equal(r.status, 1);
  assert.equal(res.checks.length, 2);
  assert.equal(res.checks[1].cmd, 'false');
});

function transcript(dir, prompt, structured) {
  const p = path.join(dir, `transcript-${Math.random().toString(36).slice(2)}.jsonl`);
  const lines = [
    { type: 'user', message: { role: 'user', content: prompt } },
    ...(structured ? [{ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'StructuredOutput', input: structured }] } }] : []),
  ];
  fs.writeFileSync(p, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return p;
}

test('subagent-stop blocks until the gate is green for HEAD, then captures the report', () => {
  const { runDir, wt } = setupTask();
  run(['task', 'start', runDir, 'T1'], { cwd: wt });
  fs.writeFileSync(path.join(wt, 'apps/api/src/index.ts'), 'export const x = 3;\n');
  run(['commit', 'T1: x=3'], { cwd: wt });
  const report = { task_id: 'T1', status: 'done', summary: 'did it', branch: 'task/demo/T1', head_sha: 'x', worktree: wt, files_changed: [], commands_run: [], contract_change_request: '' };
  const tp = transcript(wt + '/..', `DEVTEAM run=${runDir} task=T1 role=backend-engineer mode=implement`, report);
  const stop = () => hook('subagent-stop', { cwd: wt, agent_type: 'devteam:backend-engineer', agent_transcript_path: tp });
  let r = stop();
  assert.equal(r.status, 2, 'no gate yet');
  assert.match(r.stderr, /no gate result yet/);
  run(['gate'], { cwd: wt });
  r = stop();
  assert.equal(r.status, 0, r.stderr);
  const saved = JSON.parse(fs.readFileSync(path.join(runDir, 'tasks', 'T1', 'report.json'), 'utf8'));
  assert.equal(saved.summary, 'did it');
  assert.equal(saved._gate, 'pass');
  const state = JSON.parse(fs.readFileSync(path.join(runDir, 'tasks', 'T1', 'state.json'), 'utf8'));
  assert.equal(state.status, 'implemented');
  assert.equal(state.head, g(wt, 'rev-parse', 'HEAD'));
  // a blocked report is not forced through the gate
  fs.writeFileSync(path.join(wt, 'apps/api/src/index.ts'), 'dirty\n');
  const tp2 = transcript(wt + '/..', `DEVTEAM run=${runDir} task=T1 role=backend-engineer mode=implement`, { ...report, status: 'needs_contract_change' });
  assert.equal(hook('subagent-stop', { cwd: wt, agent_type: 'devteam:backend-engineer', agent_transcript_path: tp2 }).status, 0);
});

test('subagent-stop gives up after 3 blocks and records the gate as unresolved', () => {
  const { runDir, wt } = setupTask();
  run(['task', 'start', runDir, 'T1'], { cwd: wt });
  const tp = transcript(wt + '/..', `DEVTEAM run=${runDir} task=T1 role=backend-engineer mode=implement`, null);
  const input = { cwd: wt, agent_type: 'devteam:backend-engineer', agent_transcript_path: tp };
  assert.equal(hook('subagent-stop', input).status, 2);
  assert.equal(hook('subagent-stop', input).status, 2);
  assert.equal(hook('subagent-stop', input).status, 2);
  assert.equal(hook('subagent-stop', input).status, 0);
  const state = JSON.parse(fs.readFileSync(path.join(runDir, 'tasks', 'T1', 'state.json'), 'utf8'));
  assert.equal(state.gates, 'unresolved');
  assert.equal(state.status, 'stopped_without_report');
});

test('review captures go to review-<role>-<n>.json, epic-level to _epic', () => {
  const { dir, runDir } = setupTask();
  const tp = transcript(dir, `DEVTEAM run=${runDir} task=T1 role=code-reviewer mode=review`, { verdict: 'approve', summary: 'ok', findings: [] });
  assert.equal(hook('subagent-stop', { cwd: dir, agent_type: 'devteam:code-reviewer', agent_transcript_path: tp }).status, 0);
  assert.ok(fs.existsSync(path.join(runDir, 'tasks', 'T1', 'review-code-reviewer-1.json')));
  const tp2 = transcript(dir, `DEVTEAM run=${runDir} task=- role=security-engineer mode=final`, { verdict: 'approve', summary: 'ok', findings: [] });
  hook('subagent-stop', { cwd: dir, agent_type: 'devteam:security-engineer', agent_transcript_path: tp2 });
  assert.ok(fs.existsSync(path.join(runDir, 'tasks', '_epic', 'review-security-engineer-1.json')));
});

test('resume: a fix attempt in a fresh worktree continues from the previous head', () => {
  const { dir, runDir, wt } = setupTask();
  run(['task', 'start', runDir, 'T1'], { cwd: wt });
  fs.writeFileSync(path.join(wt, 'apps/api/src/index.ts'), 'export const x = 4;\n');
  run(['commit', 'T1: x=4'], { cwd: wt });
  const head = g(wt, 'rev-parse', 'HEAD');
  const st = path.join(runDir, 'tasks', 'T1', 'state.json');
  fs.writeFileSync(st, JSON.stringify({ ...JSON.parse(fs.readFileSync(st, 'utf8')), head }));
  const wt2 = path.join(dir, '.claude', 'worktrees', 'agent-test2');
  g(dir, 'worktree', 'add', '-q', '-b', 'worktree-agent-test2', wt2);
  const r = run(['task', 'start', runDir, 'T1'], { cwd: wt2 });
  assert.match(r.stdout, /reset to the previous attempt/);
  assert.equal(g(wt2, 'rev-parse', 'HEAD'), head);
  assert.equal(g(wt2, 'rev-parse', '--abbrev-ref', 'HEAD'), 'task/demo/T1-2');
});

// ---------------- merge queue ----------------
test('merge: clean merge, lockfile-only conflict regenerated, real conflict aborted', () => {
  const dir = tempRepo({ regenerable: ['pnpm-lock.yaml'], regenerate_cmd: "printf 'lock: regenerated\\n' > pnpm-lock.yaml" });
  const runDir = run(['run', 'new', 'demo'], { cwd: dir }).stdout.trim();
  writePlan(runDir, [{ id: 'T1', title: 'a', role: 'backend-engineer', files: ['apps/api/src/index.ts'], acceptance: ['x'] }]);
  run(['run', 'epic', runDir], { cwd: dir });
  const branch = (name, file, content, lock) => {
    g(dir, 'checkout', '-q', '-b', name, 'team/demo');
    fs.writeFileSync(path.join(dir, file), content);
    if (lock) fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), lock);
    g(dir, 'commit', '-qam', name);
    g(dir, 'checkout', '-q', 'team/demo');
  };
  branch('t/a', 'apps/api/src/index.ts', 'export const x = 10;\n', 'lock: a\n');
  branch('t/b', 'apps/web/page.tsx', 'export default 10;\n', 'lock: b\n');
  branch('t/c', 'apps/api/src/index.ts', 'export const x = 99;\n');
  let r = JSON.parse(run(['merge', 't/a', '--run', runDir, '--task', 'T1', '--allow-ungated'], { cwd: dir }).stdout);
  assert.equal(r.status, 'merged');
  assert.match(g(dir, 'log', '-1', '--format=%B'), /Task: T1/);
  r = JSON.parse(run(['merge', 't/b'], { cwd: dir }).stdout);
  assert.equal(r.status, 'merged');
  assert.deepEqual(r.regenerated, ['pnpm-lock.yaml']);
  assert.equal(fs.readFileSync(path.join(dir, 'pnpm-lock.yaml'), 'utf8'), 'lock: regenerated\n');
  const c = run(['merge', 't/c'], { cwd: dir });
  assert.equal(c.status, 3);
  r = JSON.parse(c.stdout);
  assert.equal(r.status, 'conflict');
  assert.deepEqual(r.files, ['apps/api/src/index.ts']);
  assert.equal(g(dir, 'status', '--porcelain', '--untracked-files=no'), '', 'merge aborted cleanly');
  const state = JSON.parse(fs.readFileSync(path.join(runDir, 'tasks', 'T1', 'state.json'), 'utf8'));
  assert.equal(state.status, 'merged');
});

test('merge rolls back when the gate goes red', () => {
  const dir = tempRepo({ gates: { fast: ['test ! -f apps/api/src/broken.ts'], contracts: [], full: [], security: [] } });
  const runDir = run(['run', 'new', 'demo'], { cwd: dir }).stdout.trim();
  run(['run', 'epic', runDir], { cwd: dir });
  g(dir, 'checkout', '-q', '-b', 't/broken', 'team/demo');
  fs.writeFileSync(path.join(dir, 'apps/api/src/broken.ts'), 'x');
  g(dir, 'add', '-A'); g(dir, 'commit', '-qm', 'broken');
  g(dir, 'checkout', '-q', 'team/demo');
  const before = g(dir, 'rev-parse', 'HEAD');
  const r = JSON.parse(run(['merge', 't/broken'], { cwd: dir }).stdout);
  assert.equal(r.status, 'gate_failed');
  assert.equal(g(dir, 'rev-parse', 'HEAD'), before);
});

test('merge refuses to target the base branch', () => {
  const dir = tempRepo();
  g(dir, 'checkout', '-q', '-b', 't/x');
  g(dir, 'checkout', '-q', 'main');
  assert.notEqual(run(['merge', 't/x'], { cwd: dir }).status, 0);
});

// ---------------- run args, init, new-role, lint ----------------
test('run args: compact, skips merged tasks, quick mode disables final', () => {
  const { dir, runDir } = setupTask();
  fs.mkdirSync(path.join(runDir, 'tasks', 'T1'), { recursive: true });
  fs.writeFileSync(path.join(runDir, 'tasks', 'T1', 'state.json'), JSON.stringify({ status: 'merged' }));
  const a = JSON.parse(run(['run', 'args', runDir, 'build', '--mode', 'quick'], { cwd: dir }).stdout);
  assert.deepEqual(a.done, ['T1']);
  assert.equal(a.final, false);
  assert.equal(a.epicBranch, 'team/demo');
  assert.ok(a.cfg.roles['backend-engineer'].agentType === 'devteam:backend-engineer');
  assert.ok(!a.cfg.roles['ux-designer'], 'disabled roles are not passed');
  assert.ok(JSON.stringify(a).length < 8000, 'args stay small');
});

test('init is non-destructive and links CLAUDE.md/GEMINI.md to AGENTS.md', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'devteam-init-')));
  g(dir, 'init', '-q', '-b', 'main');
  assert.equal(run(['init', '--stack', 'ts'], { cwd: dir }).status, 0);
  assert.equal(fs.readlinkSync(path.join(dir, 'CLAUDE.md')), 'AGENTS.md');
  assert.equal(fs.readlinkSync(path.join(dir, 'GEMINI.md')), 'AGENTS.md');
  const settings = JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'settings.json'), 'utf8'));
  assert.equal(settings.sandbox.enabled, true);
  assert.ok(settings.permissions.allow.some((p) => p.startsWith('Edit(//') && p.endsWith('/.team/**)')));
  fs.writeFileSync(path.join(dir, '.team', 'config.json'), '{"custom": true}\n');
  run(['init', '--stack', 'ts'], { cwd: dir });
  assert.equal(fs.readFileSync(path.join(dir, '.team', 'config.json'), 'utf8'), '{"custom": true}\n');
});

test('new-role (project scope) registers a local role that plans can use', () => {
  const dir = tempRepo();
  const r = run(['new-role', 'mobile-engineer', '--template', 'mobile-engineer'], { cwd: dir });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(fs.existsSync(path.join(dir, '.claude', 'agents', 'mobile-engineer.md')));
  const cfg = C.effectiveConfig(dir);
  assert.equal(cfg.roles['mobile-engineer'].agentType, 'mobile-engineer');
  assert.deepEqual(cfg.roles['mobile-engineer'].owns, ['apps/mobile/**']);
  const v = P.validatePlan({ tasks: [{ id: 'M1', title: 'screen', role: 'mobile-engineer', files: ['apps/mobile/src/Home.tsx'], acceptance: ['x'] }] }, cfg);
  assert.deepEqual(v.errors, []);
  const custom = run(['new-role', 'perf-reviewer', '--kind', 'reviewer', '--review-tags', 'perf', '--description', 'perf lens'], { cwd: dir });
  assert.equal(custom.status, 0, custom.stdout + custom.stderr);
  assert.deepEqual(C.effectiveConfig(dir).roles['perf-reviewer'].review_when.tags, ['perf']);
});

test('plugin lint has no errors', () => {
  const r = run(['lint']);
  assert.equal(r.status, 0, r.stdout);
});

test('run cleanup deletes only task branches merged into the epic branch', () => {
  const { dir, runDir, wt } = setupTask();
  run(['task', 'start', runDir, 'T1'], { cwd: wt });
  fs.writeFileSync(path.join(wt, 'apps/api/src/index.ts'), 'export const x = 5;\n');
  run(['commit', 'T1: x=5'], { cwd: wt });
  g(dir, 'branch', 'task/demo/T9', 'team/demo');
  g(dir, 'checkout', '-q', '-b', 'task/demo/T8', 'team/demo');
  fs.writeFileSync(path.join(dir, 'apps/web/page.tsx'), 'export default 8;\n');
  g(dir, 'commit', '-qam', 'unmerged work');
  g(dir, 'checkout', '-q', 'team/demo');
  const r = JSON.parse(run(['run', 'cleanup', runDir], { cwd: dir }).stdout);
  assert.deepEqual(r.deleted, ['task/demo/T9'], 'only the already-merged (empty) branch goes');
  assert.deepEqual(r.kept.map((k) => k.branch).sort(), ['task/demo/T1', 'task/demo/T8']);
});

test('an unavailable Gemini report is kept separately and does not overwrite report.json', () => {
  const { runDir, wt } = setupTask();
  run(['task', 'start', runDir, 'T1', '--engine', 'gemini'], { cwd: wt });
  const tp = transcript(wt + '/..', `DEVTEAM run=${runDir} task=T1 role=gemini-bridge mode=implement`,
    { task_id: 'T1', status: 'unavailable', summary: 'UNAVAILABLE: agy returned no output (denied: command)', branch: '', head_sha: '', worktree: wt, files_changed: [], commands_run: [], contract_change_request: '' });
  assert.equal(hook('subagent-stop', { cwd: wt, agent_type: 'devteam:gemini-bridge', agent_transcript_path: tp }).status, 0);
  const files = fs.readdirSync(path.join(runDir, 'tasks', 'T1'));
  assert.ok(files.some((f) => f.startsWith('unavailable-backend-engineer-implement-')), files.join(','));
  assert.ok(!files.includes('report.json'));
  assert.match(fs.readFileSync(path.join(runDir, 'ledger.md'), 'utf8'), /reason=UNAVAILABLE: agy returned no output/);
});

// ---------------- review fixes: ungated merges, carve-outs, generated files ----------------
test('merge refuses a task branch without a passing gate stamped on its head', () => {
  const { dir, runDir, wt } = setupTask();
  run(['task', 'start', runDir, 'T1'], { cwd: wt });
  fs.writeFileSync(path.join(wt, 'apps/api/src/index.ts'), 'export const x = 6;\n');
  run(['commit', 'T1: x=6'], { cwd: wt });
  const merge = () => run(['merge', 'task/demo/T1', '--run', runDir, '--task', 'T1'], { cwd: dir });
  let r = merge();
  assert.equal(r.status, 3);
  let out = JSON.parse(r.stdout);
  assert.equal(out.status, 'ungated');
  assert.match(out.reason, /never ran `devteam gate`/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(runDir, 'tasks', 'T1', 'state.json'), 'utf8')).status, 'merge_ungated');
  run(['gate'], { cwd: wt });
  fs.writeFileSync(path.join(wt, 'apps/api/src/index.ts'), 'export const x = 7;\n');
  run(['commit', 'T1: x=7 after the gate'], { cwd: wt });
  out = JSON.parse(merge().stdout);
  assert.equal(out.status, 'ungated');
  assert.match(out.reason, /gate ran on .* but task\/demo\/T1 is at/, 'a stale gate is not evidence');
  run(['gate'], { cwd: wt });
  out = JSON.parse(merge().stdout);
  assert.equal(out.status, 'merged', JSON.stringify(out));
  assert.equal(out.gate_evidence.ok, true);
  assert.match(g(dir, 'log', '-1', '--format=%B'), /Task: T1/);
});

test('agents cannot pass --allow-ungated', () => {
  const dir = tempRepo();
  assert.equal(hook('pre-bash', { cwd: dir, agent_type: 'devteam:integrator', tool_input: { command: 'devteam merge task/x/T1 --run r --task T1 --allow-ungated' } }).status, 2);
  assert.equal(hook('pre-bash', { cwd: dir, agent_type: 'devteam:integrator', tool_input: { command: 'devteam merge task/x/T1 --run r --task T1' } }).status, 0);
});

test('ownership carve-outs: "!glob" excludes, lint accepts intentional nesting, plans respect it', () => {
  assert.ok(U.matchAny('packages/db/migrations/1.sql', ['packages/db/**', '!packages/db/seeds/**']));
  assert.ok(!U.matchAny('packages/db/seeds/users.ts', ['packages/db/**', '!packages/db/seeds/**']));
  assert.ok(U.excludedBy(['packages/db/**', '!packages/db/seeds/**'], 'packages/db/seeds/**'));
  const cfg = C.effectiveConfig(os.tmpdir());
  const v = P.validatePlan({ tasks: [{ id: 'T1', title: 'seed', role: 'backend-engineer', files: ['packages/db/seeds/users.ts'], acceptance: ['x'] }] }, cfg);
  assert.ok(v.errors.some((e) => e.includes('outside backend-engineer ownership')));
  const ok = P.validatePlan({ tasks: [{ id: 'T1', title: 'seed', role: 'data-engineer', files: ['packages/db/seeds/users.ts'], acceptance: ['x'] }] }, cfg);
  assert.deepEqual(ok.errors, []);
  const lint = run(['lint']);
  assert.match(lint.stdout, /0 error\(s\), 0 warning\(s\)/);
});

test('init (ts) ignores the AGENTS.md that Next.js writes into apps', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'devteam-init2-')));
  g(dir, 'init', '-q', '-b', 'main');
  run(['init', '--stack', 'ts'], { cwd: dir });
  assert.match(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8'), /^apps\/\*\/AGENTS\.md$/m);
  fs.mkdirSync(path.join(dir, 'apps', 'web'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'apps', 'web', 'AGENTS.md'), 'generated\n');
  assert.equal(g(dir, 'status', '--porcelain', '--', 'apps'), '');
});

test('run report: human-readable summary built only from run artifacts', () => {
  const { dir, runDir, wt } = setupTask();
  fs.writeFileSync(path.join(runDir, 'spec.md'), '# Spec: Demo feature\n\n## Problem\nUsers cannot do X.\n\n## Acceptance criteria\n- AC1: Given A When B Then C\n');
  run(['task', 'start', runDir, 'T1'], { cwd: wt });
  fs.writeFileSync(path.join(wt, 'apps/api/src/index.ts'), 'export const x = 9;\n');
  run(['commit', 'T1: x=9'], { cwd: wt });
  run(['gate'], { cwd: wt });
  const td = path.join(runDir, 'tasks', 'T1');
  fs.writeFileSync(path.join(td, 'report.json'), JSON.stringify({ status: 'done', summary: 'Changed x to 9.', files_changed: ['apps/api/src/index.ts'], tests_added: [], decisions: ['kept it simple'], risks: ['none really'] }));
  fs.writeFileSync(path.join(td, 'review-code-reviewer-1.json'), JSON.stringify({ verdict: 'approve', summary: 'ok', findings: [{ severity: 'minor', file: 'apps/api/src/index.ts', issue: 'magic number' }] }));
  run(['run', 'ledger', runDir, 'ruling', 'R1: chose 9 — spec says so — cost if wrong: trivial'], { cwd: dir });
  assert.equal(run(['merge', 'task/demo/T1', '--run', runDir, '--task', 'T1'], { cwd: dir }).status, 0);
  const p = run(['run', 'report', runDir], { cwd: dir }).stdout.trim();
  const md = fs.readFileSync(p, 'utf8');
  for (const want of ['# Demo feature', 'Users cannot do X.', 'AC1: Given A When B Then C', '### T1: api change', 'Changed x to 9.',
    '| T1 | code-reviewer | approve | 0 | 1 |', 'R1: chose 9', 'magic number', 'none really', 'git checkout main && git merge --no-ff team/demo', 'merges cleanly']) {
    assert.ok(md.includes(want), `report should contain: ${want}`);
  }
});
