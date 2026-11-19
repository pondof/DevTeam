// Hook tests driven by REAL payloads captured from Claude Code 2.1.328 (tests/fixtures/hooks/*.json) and a real
// workflow-agent transcript (tests/fixtures/transcripts/workflow-implementer.jsonl). Machine-specific values are
// placeholders ({{CWD}}, {{AGENT_TYPE}}, {{RUN}}, …) filled in per test. Re-capture fixtures after Claude Code
// upgrades that change hook input shapes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'bin', 'devteam');
const FX = path.join(ROOT, 'tests', 'fixtures');

const run = (args, opts = {}) => spawnSync(CLI, args, { encoding: 'utf8', ...opts });
const g = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

/** Load a fixture and fill placeholders. Values are JSON-escaped so paths with quotes stay valid. */
function fixture(name, vars = {}) {
  let text = fs.readFileSync(path.join(FX, 'hooks', name), 'utf8');
  const all = { HOME: os.homedir(), TRANSCRIPT: path.join(os.tmpdir(), 'none.jsonl'), ...vars };
  for (const [k, v] of Object.entries(all)) text = text.split(`{{${k}}}`).join(JSON.stringify(String(v)).slice(1, -1));
  const left = text.match(/\{\{[A-Z_]+\}\}/);
  if (left) throw new Error(`fixture ${name}: unfilled placeholder ${left[0]}`);
  return JSON.parse(text);
}

function hook(name, payload) {
  return spawnSync(CLI, ['hook', name], { encoding: 'utf8', input: typeof payload === 'string' ? payload : JSON.stringify(payload) });
}

function project({ withRun = true } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'devteam-fx-')));
  g(dir, 'init', '-q', '-b', 'main');
  g(dir, 'config', 'user.email', 'test@example.com');
  g(dir, 'config', 'user.name', 'devteam test');
  fs.mkdirSync(path.join(dir, '.team'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.team', 'config.json'), JSON.stringify({ base_branch: 'main', gates: { fast: ['true'], contracts: [], full: [], security: [] }, roles: {} }));
  fs.writeFileSync(path.join(dir, '.gitignore'), '.team/runs/\n.team/current\n.devteam/\n.claude/worktrees/\n');
  fs.mkdirSync(path.join(dir, 'apps', 'api', 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'apps', 'api', 'src', 'index.ts'), 'export const x = 1;\n');
  fs.mkdirSync(path.join(dir, 'apps', 'web'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'apps', 'web', 'page.tsx'), 'export default 1;\n');
  g(dir, 'add', '-A');
  g(dir, 'commit', '-q', '-m', 'init');
  let runDir = null;
  if (withRun) {
    runDir = run(['run', 'new', 'fx'], { cwd: dir }).stdout.trim();
    fs.writeFileSync(path.join(runDir, 'plan.json'), JSON.stringify({ epic: 'fx', tasks: [
      { id: 'B1', title: 'migration', role: 'backend-engineer', files: ['apps/api/src/index.ts'], acceptance: ['x'] },
    ] }));
    assert.equal(run(['plan', 'check', runDir], { cwd: dir }).status, 0);
    run(['run', 'epic', runDir], { cwd: dir });
  }
  return { dir, runDir };
}

const ledger = (runDir) => fs.readFileSync(path.join(runDir, 'ledger.md'), 'utf8');

// ---------------- wiring ----------------
test('hooks.json wires every handler to bin/devteam with matchers for the real tool names', () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'hooks', 'hooks.json'), 'utf8'));
  const wired = [];
  for (const [event, groups] of Object.entries(cfg.hooks)) {
    for (const grp of groups) for (const h of grp.hooks) {
      const m = h.command.match(/^"\$\{CLAUDE_PLUGIN_ROOT\}\/bin\/devteam" hook ([a-z-]+)$/);
      assert.ok(m, `${event}: unexpected command ${h.command}`);
      wired.push({ event, matcher: grp.matcher, handler: m[1] });
      assert.equal(hook(m[1], {}).status, 0, `${m[1]} must accept an empty payload`);
    }
  }
  assert.deepEqual(new Set(wired.map((w) => w.event)), new Set(['PreToolUse', 'SubagentStart', 'SubagentStop', 'SessionStart']));
  const bashMatcher = wired.find((w) => w.handler === 'pre-bash').matcher;
  const editMatcher = wired.find((w) => w.handler === 'pre-edit').matcher;
  assert.ok(new RegExp(`^(${bashMatcher})$`).test(fixture('pre-tool-use.bash.devteam-agent.json', { CWD: '/x', COMMAND: 'x' }).tool_name));
  assert.ok(new RegExp(`^(${editMatcher})$`).test(fixture('pre-tool-use.write.subagent.json', { CWD: '/x', AGENT_TYPE: 'x', FILE: '/x' }).tool_name));
  assert.ok(new RegExp(`^(${wired.find((w) => w.handler === 'session-start').matcher})$`).test(fixture('session-start.startup.json', { CWD: '/x' }).source));
});

test('real payloads carry the fields the handlers rely on', () => {
  const f = (n) => fixture(n, { CWD: '/x', COMMAND: 'x', AGENT_TYPE: 'devteam:x', FILE: '/x', AGENT_TRANSCRIPT: '/x' });
  assert.ok(f('pre-tool-use.bash.devteam-agent.json').agent_type.startsWith('devteam:'), 'plugin agents are reported as devteam:<name>');
  for (const n of ['pre-tool-use.bash.devteam-agent.json', 'pre-tool-use.write.subagent.json']) {
    const p = f(n);
    assert.ok(p.cwd && p.tool_input && p.agent_type && p.agent_id, n);
  }
  assert.ok('command' in f('pre-tool-use.bash.devteam-agent.json').tool_input);
  assert.ok('file_path' in f('pre-tool-use.write.subagent.json').tool_input);
  const stop = f('subagent-stop.devteam.json');
  for (const k of ['cwd', 'agent_type', 'agent_id', 'agent_transcript_path', 'stop_hook_active']) assert.ok(k in stop, `SubagentStop.${k}`);
  assert.ok('cwd' in f('session-start.startup.json') && !('agent_type' in f('session-start.startup.json')));
});

// ---------------- SessionStart ----------------
test('session-start injects the active run status, a hint without a run, nothing outside devteam projects', () => {
  const { dir, runDir } = project();
  let r = hook('session-start', fixture('session-start.startup.json', { CWD: dir }));
  assert.equal(r.status, 0);
  assert.match(r.stdout, /devteam: active run/);
  assert.match(r.stdout, new RegExp(path.basename(runDir)));
  assert.match(r.stdout, /B1 .* backend-engineer/);
  const bare = project({ withRun: false });
  r = hook('session-start', fixture('session-start.startup.json', { CWD: bare.dir }));
  assert.match(r.stdout, /no active run/);
  const plain = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'plain-')));
  g(plain, 'init', '-q');
  r = hook('session-start', fixture('session-start.startup.json', { CWD: plain }));
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
});

// ---------------- SubagentStart ----------------
test('subagent-start logs devteam agents to the ledger and ignores other agents', () => {
  const { dir, runDir } = project();
  const before = ledger(runDir);
  assert.equal(hook('subagent-start', fixture('subagent-start.devteam.json', { CWD: dir, AGENT_TYPE: 'devteam:gemini-bridge' })).status, 0);
  const p = fixture('subagent-start.devteam.json', { CWD: dir, AGENT_TYPE: 'devteam:gemini-bridge' });
  assert.match(ledger(runDir), new RegExp(`\\[agent\\] start devteam:gemini-bridge ${p.agent_id}`));
  const mid = ledger(runDir);
  hook('subagent-start', fixture('subagent-start.devteam.json', { CWD: dir, AGENT_TYPE: 'probe-writer' }));
  assert.equal(ledger(runDir), mid, 'non-devteam agents are not logged');
  assert.notEqual(before, mid);
});

// ---------------- PreToolUse: Bash (real devteam agent payload) ----------------
test('pre-bash with a real devteam agent payload', () => {
  const { dir } = project();
  const bash = (COMMAND) => hook('pre-bash', fixture('pre-tool-use.bash.devteam-agent.json', { CWD: dir, COMMAND })).status;
  assert.equal(bash('echo bridge-probe'), 0);
  assert.equal(bash('devteam-agy review --kind task --run /x --task T1'), 0);
  assert.equal(bash('git push -u origin team/fx'), 2, 'agents never push');
  assert.equal(bash('printenv'), 2);
  assert.equal(bash('cat .env'), 2);
  assert.equal(bash('gh pr merge 3'), 2);
  assert.equal(bash('terraform apply'), 2);
});

// ---------------- PreToolUse: Write (real subagent payload) ----------------
test('pre-edit with a real Write payload: ownership in a task worktree', () => {
  const { dir, runDir } = project();
  const wt = path.join(dir, '.claude', 'worktrees', 'agent-fx');
  g(dir, 'worktree', 'add', '-q', '-b', 'worktree-agent-fx', wt);
  const write = (AGENT_TYPE, rel) => hook('pre-edit', fixture('pre-tool-use.write.subagent.json', { CWD: wt, AGENT_TYPE, FILE: path.join(wt, rel) }));
  assert.equal(write('devteam:backend-engineer', 'apps/api/src/index.ts').status, 2, 'must run task start first');
  assert.equal(run(['task', 'start', runDir, 'B1'], { cwd: wt }).status, 0);
  assert.equal(write('devteam:backend-engineer', 'apps/api/src/index.ts').status, 0);
  const denied = write('devteam:backend-engineer', 'apps/web/page.tsx');
  assert.equal(denied.status, 2);
  assert.match(denied.stderr, /may not change apps\/web\/page\.tsx/);
  assert.equal(write('devteam:code-reviewer', 'apps/api/src/index.ts').status, 2, 'reviewers are read-only');
  assert.equal(write('probe-writer', 'apps/web/page.tsx').status, 0, 'non-devteam agents are not governed');
});

// ---------------- SubagentStop with a real workflow transcript ----------------
test('subagent-stop: real workflow transcript → gate enforced, structured report captured', () => {
  const { dir, runDir } = project();
  const wt = path.join(dir, '.claude', 'worktrees', 'agent-fx2');
  g(dir, 'worktree', 'add', '-q', '-b', 'worktree-agent-fx2', wt);
  assert.equal(run(['task', 'start', runDir, 'B1'], { cwd: wt }).status, 0);
  const tr = fs.readFileSync(path.join(FX, 'transcripts', 'workflow-implementer.jsonl'), 'utf8')
    .split('{{RUN}}').join(runDir).split('{{HOME}}').join(os.homedir());
  const trPath = path.join(dir, 'agent-transcript.jsonl');
  fs.writeFileSync(trPath, tr);
  const real = tr.split('\n').filter(Boolean).map((l) => JSON.parse(l)).pop().message.content.find((c) => c.name === 'StructuredOutput').input;
  const stop = () => hook('subagent-stop', fixture('subagent-stop.devteam.json', { CWD: wt, AGENT_TYPE: 'devteam:backend-engineer', AGENT_TRANSCRIPT: trPath }));
  // The real report says status=done, so the gate must be green for HEAD before the agent may stop.
  let r = stop();
  assert.equal(r.status, 2);
  assert.match(r.stderr, /devteam stop gate \(1\/3\)/);
  fs.writeFileSync(path.join(wt, 'apps/api/src/index.ts'), 'export const x = 2;\n');
  assert.equal(run(['commit', 'B1: change'], { cwd: wt }).status, 0);
  assert.equal(run(['gate'], { cwd: wt }).status, 0);
  r = stop();
  assert.equal(r.status, 0, r.stderr);
  const saved = JSON.parse(fs.readFileSync(path.join(runDir, 'tasks', 'B1', 'report.json'), 'utf8'));
  assert.equal(saved.summary, real.summary, 'the real structured output is captured verbatim');
  assert.equal(saved._gate, 'pass');
  assert.match(ledger(runDir), /stop devteam:backend-engineer task=B1 mode=implement status=done gate=pass/);
});

// ---------------- fail-open ----------------
test('hooks fail open on malformed input or a broken environment; ownership still fails closed', () => {
  const broken = { cwd: '/nonexistent/dir', agent_type: 'devteam:backend-engineer', tool_input: { command: 'echo x', file_path: '/nonexistent/dir/apps/api/x.ts' } };
  for (const h of ['pre-bash', 'pre-edit', 'subagent-start', 'subagent-stop', 'session-start']) {
    assert.equal(hook(h, '{not json').status, 0, `${h} malformed`);
    assert.equal(hook(h, broken).status, 0, `${h} with a nonexistent cwd`);
  }
  // A devteam agent writing outside its role's ownership is denied even when the environment is odd.
  const outside = hook('pre-edit', { ...broken, tool_input: { file_path: '/nonexistent/dir/apps/web/x.tsx' } });
  assert.equal(outside.status, 2);
  assert.match(outside.stderr, /backend-engineer owns/);
});
