// Hook handlers. Every handler fails open on internal errors (a broken hook must never wedge a
// session) and does nothing outside devteam projects / devteam agents.
import fs from 'node:fs';
import path from 'node:path';
import { worktreeRoot, mainRoot, isLinkedWorktree, readJSON, readText, exists, matchAny, appendLedger, tryGit, nowIso } from './util.mjs';
import { effectiveConfig, roleFromAgentType } from './config.mjs';
import { markerPath } from './task.mjs';
import { gateSatisfied } from './gate.mjs';
import { currentRun, updateState, readState, runStatus, loadPlan } from './run.mjs';

const MAX_STOP_BLOCKS = 3;

class Deny extends Error {}
const deny = (msg) => { throw new Deny(msg); };

function devteamProject(cwd) {
  const root = mainRoot(cwd);
  return root && exists(path.join(root, '.team', 'config.json')) ? root : null;
}

function agentRole(input) {
  if (!input.agent_type) return { cfg: null, role: null };
  const root = worktreeRoot(input.cwd) || input.cwd;
  const cfg = effectiveConfig(root);
  return { cfg, role: roleFromAgentType(cfg, input.agent_type) };
}

// ---------- PreToolUse: Bash ----------
const BASH_RULES = [
  [/\bgit\s+push\b[^|;&]*(\s--force\b|\s-f\b|\s--force-with-lease\b|\s\+[^\s]+)/, 'force pushes are never allowed'],
  [/\bgit\s+push\b[^|;&]*\s(origin\s+)?(HEAD:)?(main|master)(\s|$)/, 'pushing to main/master is human-only'],
  [/\bgit\s+clean\b[^|;&]*\s-[a-zA-Z]*x/, 'git clean -x deletes ignored state, including the .team/runs ledger'],
  [/\bgit\b[^|;&]*\s--no-verify\b/, 'skipping git hooks (--no-verify) is not allowed'],
  [/\brm\s+(-[a-zA-Z]+\s+)*-[a-zA-Z]*[rR][a-zA-Z]*\s+(-[a-zA-Z]+\s+)*["']?(\/|~|\$HOME|\$\{HOME\})\/?["']?(\s|$)/, 'recursive delete of / or the home directory'],
  [/\b(terraform|tofu)\s+(apply|destroy|import|state\s+(rm|mv|push))\b/, 'infrastructure changes are human-only (use `plan`)'],
  [/\bpulumi\s+(up|destroy|refresh|import)\b/, 'infrastructure changes are human-only (use `preview`)'],
  [/\bhelm\s+(install|upgrade|uninstall|rollback)\b/, 'cluster changes are human-only'],
  [/\bkubectl\b(?![^|;&]*--context[= ]?(kind-|orbstack|docker-desktop|minikube))[^|;&]*\s(apply|delete|replace|patch|scale|rollout|edit|drain|cordon|create|set)\b/, 'kubectl mutations only against local clusters (--context kind-*/orbstack/docker-desktop/minikube)'],
  [/\bdocker\s+(system|volume|image|container|network|builder)\s+prune\b/, 'docker prune can destroy other projects\' data'],
  [/(^|[\s;&|(])(cat|less|more|head|tail|bat|sed|awk|grep|rg|cp|mv|source|xxd|strings|base64)\s+(?:[^|;&]*[\s/'"=])?\.env(\.(local|development|production|staging|test|prod|dev))?(?=$|[\s'";|&)])/, 'reading .env files is denied (use .env.example)'],
  [/\b(aws|gcloud|az)\s+[^|;&]*\s(delete|terminate|destroy|remove|deploy|put-|create-|update-)/, 'cloud mutations are human-only'],
];
const AGENT_BASH_RULES = [
  [/\bgit\s+push\b/, 'agents never push; the orchestrator asks the human before anything leaves this machine'],
  [/(^|[\s;&|(])(printenv|env)\s*($|[|;&>])/, 'dumping the environment is denied for agents'],
  [/\bgh\s+(pr\s+(merge|close)|release\s+create|repo\s+(delete|edit))\b/, 'merging, releasing and repo settings are human-only'],
  [/\bdevteam\b[^|;&]*\s--allow-ungated\b/, 'merging a task without a passing gate is a human decision; report the ungated task instead'],
];

export function preBash(input) {
  const cmd = input.tool_input?.command || '';
  const isAgent = !!input.agent_type;
  const project = devteamProject(input.cwd);
  const { role } = agentRole(input);
  if (!project && !role) return;
  for (const [re, why] of BASH_RULES) if (re.test(cmd)) deny(`devteam guard: ${why}. Blocked command: ${cmd.slice(0, 200)}`);
  if (isAgent && role) {
    for (const [re, why] of AGENT_BASH_RULES) if (re.test(cmd)) deny(`devteam guard: ${why}.`);
    if (/\bgit\s+commit\b/.test(cmd)) {
      const cfg = effectiveConfig(worktreeRoot(input.cwd) || input.cwd);
      const branch = tryGit(['rev-parse', '--abbrev-ref', 'HEAD'], input.cwd);
      if (branch && branch === cfg.base_branch) deny(`devteam guard: agents never commit on ${branch}; work happens on team/* (epic) and task/* branches`);
    }
  }
}

// ---------- PreToolUse: Edit / Write / MultiEdit / NotebookEdit ----------
export function preEdit(input) {
  const ti = input.tool_input || {};
  const file = ti.file_path || ti.notebook_path || ti.path;
  if (!file || !input.agent_type) return;
  const { role } = agentRole(input);
  if (!role) return;
  const cwd = input.cwd || process.cwd();
  const wt = worktreeRoot(cwd) || cwd;
  const abs = path.resolve(cwd, file);
  const marker = readJSON(markerPath(wt), null);
  if (role.kind === 'reviewer' || role.kind === 'bridge') deny(`devteam ownership: ${role.name} is a read-only role and cannot edit ${file}`);
  if (marker) {
    const rel = path.relative(wt, abs).split(path.sep).join('/');
    if (rel.startsWith('..') || path.isAbsolute(rel)) deny(`devteam ownership: ${file} is outside your worktree ${wt}. Work only inside it.`);
    if (rel.startsWith('.devteam/')) deny('devteam ownership: .devteam/ is written by devteam commands only');
    if (!matchAny(rel, marker.allowed)) {
      deny(`devteam ownership: task ${marker.taskId} may not change ${rel}. Allowed: ${marker.allowed.join(', ')}. ` +
        'If the task really needs this file (or a contract change), stop and return status "blocked" or "needs_contract_change" with the exact request.');
    }
    return;
  }
  if (role.kind === 'implementer' && isLinkedWorktree(cwd)) {
    deny('devteam ownership: run `devteam task start <runDir> <taskId>` first; it prints your brief and sets which files you own');
  }
  const root = worktreeRoot(cwd) || cwd;
  const rel = path.relative(root, abs).split(path.sep).join('/');
  if (rel.startsWith('..') || path.isAbsolute(rel)) deny(`devteam ownership: ${file} is outside the repository`);
  if (role.kind === 'integrator') {
    // The integrator may resolve conflict markers in any file that is currently unmerged.
    const unmerged = (tryGit(['diff', '--name-only', '--diff-filter=U'], root) || '').split('\n').filter(Boolean);
    if (unmerged.includes(rel)) return;
  }
  if (!matchAny(rel, role.owns)) deny(`devteam ownership: ${role.name} owns ${role.owns.join(', ') || 'nothing'}; ${rel} is not one of them`);
}

// ---------- transcript helpers ----------
const MARKER_RE = /DEVTEAM\s+run=(\S+)\s+task=(\S+)\s+role=(\S+)\s+mode=(\S+)/;

export function parseTranscript(file) {
  const out = { marker: null, structured: null };
  const text = readText(file);
  if (!text) return out;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    const content = e?.message?.content;
    if (!out.marker && e.type === 'user') {
      const s = typeof content === 'string' ? content : Array.isArray(content) ? content.map((c) => c.text || '').join('\n') : '';
      const m = s.match(MARKER_RE);
      if (m) out.marker = { run: m[1], task: m[2], role: m[3], mode: m[4] };
    }
    if (e.type === 'assistant' && Array.isArray(content)) {
      for (const c of content) if (c.type === 'tool_use' && c.name === 'StructuredOutput') out.structured = c.input;
    }
  }
  return out;
}

// ---------- SubagentStart / SubagentStop ----------
export function subagentStart(input) {
  const { role } = agentRole(input);
  if (!role) return;
  const run = currentRun(input.cwd);
  if (run) appendLedger(run, 'agent', `start ${input.agent_type} ${input.agent_id || ''}${isLinkedWorktree(input.cwd) ? ' (worktree)' : ''}`);
}

export function subagentStop(input) {
  const { role } = agentRole(input);
  if (!role) return;
  const cwd = input.cwd || process.cwd();
  let wt = worktreeRoot(cwd) || cwd;
  let marker = readJSON(markerPath(wt), null);
  const tr = input.agent_transcript_path ? parseTranscript(input.agent_transcript_path) : { marker: null, structured: null };
  // The Gemini bridge works in a sibling worktree outside the repo (devteam-agy run), so its own cwd has no
  // marker: follow the report's worktree when it carries the marker for the same run and task.
  const reported = tr.structured?.worktree;
  if (!marker && reported && tr.marker && path.resolve(reported) !== path.resolve(wt)) {
    const other = readJSON(markerPath(reported), null);
    if (other && path.resolve(other.runDir) === path.resolve(tr.marker.run) && other.taskId === tr.marker.task) {
      wt = reported;
      marker = other;
    }
  }
  const runDir = marker?.runDir || tr.marker?.run || null;
  const taskId = marker?.taskId || (tr.marker ? (tr.marker.task === '-' ? '_epic' : tr.marker.task) : null);
  const mode = tr.marker?.mode || (marker ? 'implement' : 'adhoc');
  const report = tr.structured;

  let gateStatus = null;
  if (marker?.gate_required && (!report || report.status === 'done')) {
    const s = gateSatisfied(wt);
    if (!s.ok) {
      const blocksFile = path.join(wt, '.devteam', 'stop-blocks');
      const n = Number(readText(blocksFile).trim() || 0);
      if (n < MAX_STOP_BLOCKS) {
        fs.writeFileSync(blocksFile, String(n + 1));
        if (runDir) appendLedger(runDir, 'gate', `${taskId} stop blocked (${n + 1}/${MAX_STOP_BLOCKS}): ${s.why}`);
        deny(`devteam stop gate (${n + 1}/${MAX_STOP_BLOCKS}): ${s.why}. Fix it, commit with \`devteam commit\`, run \`devteam gate\`, then return your report again. ` +
          'If you cannot get the gate green, return status "failed" (or "blocked") with the reason instead of "done".');
      }
      gateStatus = 'unresolved';
    } else gateStatus = 'pass';
  } else if (marker?.gate_required) gateStatus = 'skipped';

  if (!runDir || !exists(runDir) || !taskId) return;
  const dir = path.join(runDir, 'tasks', taskId);
  fs.mkdirSync(dir, { recursive: true });
  const roleName = marker?.role || tr.marker?.role || role.name;
  const unavailable = report && (report.status === 'unavailable' || /^UNAVAILABLE/.test(report.summary || ''));
  if (report) {
    let name;
    if (unavailable) {
      // Keep the reason: a Claude fallback will write report.json next.
      const n = fs.readdirSync(dir).filter((f) => f.startsWith('unavailable-')).length + 1;
      name = `unavailable-${roleName}-${mode}-${n}.json`;
    } else if (mode === 'implement' || mode === 'fix') name = 'report.json';
    else if (mode === 'review' || mode === 'final') {
      const n = fs.readdirSync(dir).filter((f) => f.startsWith(`review-${roleName}`)).length + 1;
      name = `review-${roleName}-${n}.json`;
    } else name = `${mode}-${roleName}.json`;
    fs.writeFileSync(path.join(dir, name), JSON.stringify({ ...report, _captured_at: nowIso(), _agent: input.agent_type, _gate: gateStatus }, null, 2) + '\n');
  }
  if (marker) {
    const head = tryGit(['rev-parse', 'HEAD'], wt);
    const isOwner = roleName === marker.task_role;
    const patch = { head, worktree: wt, branch: marker.branch, gates: gateStatus || readState(runDir, taskId).gates };
    if (isOwner) patch.status = report ? (report.status === 'done' ? 'implemented' : report.status) : 'stopped_without_report';
    else { patch.support_head = head; patch.support_role = roleName; }
    try { updateState(runDir, taskId, patch); } catch { /* best effort */ }
  }
  appendLedger(runDir, 'agent', `stop ${input.agent_type} task=${taskId} mode=${mode}${report?.status ? ' status=' + report.status : ''}${unavailable ? ` reason=${String(report.reason || report.summary || '').slice(0, 160)}` : ''}${report?.verdict ? ' verdict=' + report.verdict : ''}${gateStatus ? ' gate=' + gateStatus : ''}`);
}

// ---------- SessionStart ----------
export function sessionStart(input) {
  if (input.agent_type) return;
  const root = devteamProject(input.cwd);
  if (!root) return;
  const run = currentRun(input.cwd);
  if (!run) {
    process.stdout.write('devteam project (no active run). Use /devteam:feature, /devteam:quick or /devteam:bugfix.\n');
    return;
  }
  const plan = loadPlan(run);
  process.stdout.write(`devteam: active run — trust this ledger and git over memory after a compaction.\n${runStatus(run, { brief: !!plan && plan.tasks.length > 12 })}\n`);
}

export function runHook(name, input) {
  const handlers = { 'pre-bash': preBash, 'pre-edit': preEdit, 'subagent-start': subagentStart, 'subagent-stop': subagentStop, 'session-start': sessionStart };
  const h = handlers[name];
  if (!h) return 0;
  try {
    h(input);
    return 0;
  } catch (e) {
    if (e instanceof Deny) {
      process.stderr.write(e.message + '\n');
      return 2;
    }
    try {
      const root = mainRoot(input.cwd);
      if (root && exists(path.join(root, '.team'))) fs.appendFileSync(path.join(root, '.team', 'hook-errors.log'), `${nowIso()} ${name}: ${e.stack || e}\n`);
    } catch { /* ignore */ }
    return 0;
  }
}
