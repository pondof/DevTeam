// Human-readable branch report, assembled deterministically from a run's artifacts (no model involved, so it
// cannot invent anything): what was asked, what each task changed, how it was reviewed and gated, which decisions
// were made without the human, what is still open, and how to verify and merge it.
import fs from 'node:fs';
import path from 'node:path';
import { readJSON, readText, exists, tryGit, sh } from './util.mjs';
import { effectiveConfig } from './config.mjs';
import { loadPlan, readState, taskDir } from './run.mjs';

const MAJOR = new Set(['critical', 'major']);

/** Body of a "## title" section of a markdown document, without the heading. */
function section(md, title) {
  const lines = md.split('\n');
  const want = `## ${title}`.toLowerCase();
  const start = lines.findIndex((l) => l.trim().toLowerCase() === want);
  if (start < 0) return '';
  const out = [];
  for (let i = start + 1; i < lines.length && !lines[i].startsWith('## '); i++) out.push(lines[i]);
  return out.join('\n').trim();
}

function taskArtifacts(runDir, id) {
  const dir = taskDir(runDir, id);
  const files = exists(dir) ? fs.readdirSync(dir) : [];
  const json = (f) => readJSON(path.join(dir, f), null);
  return {
    state: readState(runDir, id),
    report: json('report.json'),
    reviews: files.filter((f) => /^review-.+\.json$/.test(f)).sort().map((f) => ({
      lens: f.replace(/^review-/, '').replace(/-\d+\.json$/, '').replace(/\.json$/, ''),
      round: Number((f.match(/-(\d+)\.json$/) || [])[1] || 1),
      ...json(f),
    })),
    gates: json('wt-gates.json') || json('wt-gates-fast.json'),
    unavailable: files.filter((f) => f.startsWith('unavailable-')).map((f) => json(f)).filter(Boolean),
    reproduce: json('reproduce-debugger.json'),
  };
}

const oneLine = (s, n = 300) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
const bullets = (arr, n = 8) => (arr || []).filter(Boolean).slice(0, n).map((x) => `- ${oneLine(x, 400)}`);
const code = (s) => '`' + s + '`';

export function buildReport(runDir) {
  const run = readJSON(path.join(runDir, 'run.json'), {});
  const root = run.root;
  const cfg = effectiveConfig(root);
  const base = cfg.base_branch;
  const epic = run.epic_branch;
  const plan = loadPlan(runDir) || { tasks: [] };
  const spec = readText(path.join(runDir, 'spec.md'));
  const design = readText(path.join(runDir, 'design.md'));
  const ledger = readText(path.join(runDir, 'ledger.md')).split('\n').filter((l) => l.startsWith('- '));
  const epicExists = !!tryGit(['rev-parse', '--verify', '--quiet', `refs/heads/${epic}`], root);
  const ahead = epicExists ? tryGit(['rev-list', '--count', `${base}..${epic}`], root) : null;
  const clean = epicExists ? sh('git', ['merge-tree', '--write-tree', base, epic], { cwd: root }).code === 0 : null;
  const title = (spec.match(/^#\s+(?:Spec:\s*)?(.+)$/m) || [])[1] || plan.tasks[0]?.title || run.slug;
  const L = [];

  L.push(`# ${title}`, '');
  L.push(`Branch ${code(epic)} → ${code(base)} · run ${code(run.id)} · ${plan.tasks.length} task(s)` +
    (epicExists ? ` · ${ahead} commit(s) ahead · ${clean ? 'merges cleanly' : `**has merge conflicts with ${base}**`}` : ' · branch not found'));
  L.push('');

  // ---- what was asked
  L.push('## What was asked');
  const problem = section(spec, 'Problem');
  if (problem) L.push(problem);
  else if (plan.tasks.length === 1) L.push(oneLine(plan.tasks[0].notes || plan.tasks[0].title, 800));
  else L.push(plan.tasks.map((t) => `- ${t.title}`).join('\n'));
  const acs = section(spec, 'Acceptance criteria');
  if (acs) L.push('', '<details><summary>Acceptance criteria</summary>', '', acs, '', '</details>');
  else if (plan.tasks.length === 1 && plan.tasks[0].acceptance?.length) L.push('', 'Acceptance criteria:', ...bullets(plan.tasks[0].acceptance));
  const oos = section(spec, 'Out of scope');
  if (oos) L.push('', '<details><summary>Out of scope</summary>', '', oos, '', '</details>');
  L.push('');

  // ---- design
  if (design) {
    const firstPara = design.replace(/^#.*$/m, '').trim().split(/\n\s*\n/)[0];
    L.push('## Design (short)', oneLine(firstPara, 900), '', `Full design: ${code(path.join(runDir, 'design.md'))}`, '');
  }

  // ---- per task
  L.push('## What was done, task by task');
  const allRisks = [];
  const allQuestions = [];
  const reviewRows = [];
  const minorFindings = [];
  for (const t of plan.tasks) {
    const a = taskArtifacts(runDir, t.id);
    const r = a.report || {};
    const engine = a.state.engine || r.engine || 'claude';
    const gate = a.gates ? (a.gates.pass ? 'green' : `red (${a.gates.reason || 'see gates'})`) : a.state.gates || 'not recorded';
    L.push(`### ${t.id}: ${t.title}`);
    L.push(`*${t.role}* · ${engine}${a.unavailable.length ? ' (Gemini was unavailable, Claude fallback)' : ''} · status **${a.state.status || 'unknown'}** · attempts ${a.state.attempts || 1} · gate ${gate}`);
    if (a.reproduce) {
      L.push('', `**Root cause:** ${oneLine(a.reproduce.root_cause, 700)}`);
      if (a.reproduce.failing_test) L.push(`**Reproduced by:** ${code(a.reproduce.failing_test)}`);
    }
    if (r.summary) L.push('', oneLine(r.summary, 900));
    if (r.files_changed?.length) L.push('', `Files: ${r.files_changed.map(code).join(', ')}`);
    if (r.tests_added?.length) L.push(`Tests added: ${r.tests_added.slice(0, 8).map((x) => code(oneLine(x, 120))).join(', ')}`);
    if (r.decisions?.length) L.push('', 'Decisions:', ...bullets(r.decisions, 6));
    for (const u of a.unavailable) allRisks.push(`${t.id}: Gemini attempt unavailable: ${oneLine(u.reason || u.summary, 200)}`);
    (r.risks || []).forEach((x) => allRisks.push(`${t.id}: ${x}`));
    (r.open_questions || []).forEach((x) => allQuestions.push(`${t.id}: ${x}`));
    for (const rv of a.reviews) {
      const majors = (rv.findings || []).filter((f) => MAJOR.has(f.severity));
      const minors = (rv.findings || []).filter((f) => f.severity === 'minor');
      reviewRows.push(`| ${t.id} | ${rv.lens}${rv.round > 1 ? ` (round ${rv.round})` : ''} | ${rv.verdict === 'approve' ? 'approve' : '**changes requested**'} | ${majors.length} | ${minors.length} |`);
      minors.forEach((f) => minorFindings.push(`${t.id} (${rv.lens}): ${f.file ? code(f.file) + ' ' : ''}${oneLine(f.issue, 220)}`));
    }
    L.push('');
  }

  // ---- reviews
  L.push('## How it was reviewed');
  if (reviewRows.length) L.push('| task | reviewer | verdict | critical/major | minor |', '|---|---|---|---|---|', ...reviewRows);
  else L.push('No task reviews were recorded.');
  const epicReviews = taskArtifacts(runDir, '_epic').reviews.filter((rv) => rv.verdict);
  if (epicReviews.length) {
    L.push('', '**Final whole-branch review:**');
    for (const rv of epicReviews) {
      L.push(`- ${rv.lens}: ${rv.verdict === 'approve' ? 'approve' : '**changes requested**'}. ${oneLine(rv.summary, 280)}`);
      (rv.findings || []).filter((f) => MAJOR.has(f.severity)).forEach((f) => L.push(`  - ${f.severity}: ${f.file ? code(f.file) + ' ' : ''}${oneLine(f.issue, 300)}`));
      (rv.findings || []).filter((f) => f.severity === 'minor').forEach((f) => minorFindings.push(`final (${rv.lens}): ${f.file ? code(f.file) + ' ' : ''}${oneLine(f.issue, 220)}`));
    }
  }
  const qa = readJSON(path.join(taskDir(runDir, '_epic'), 'system-qa-engineer.json'), null);
  if (qa) L.push('', `**System QA:** ${qa.status === 'pass' ? 'pass' : '**fail**'}. ${oneLine(qa.summary, 400)}`);
  const threat = readJSON(path.join(taskDir(runDir, '_epic'), 'threat-security-engineer.json'), null);
  if (threat) L.push(`**Threat model (design time):** ${threat.verdict}. ${oneLine(threat.summary, 300)}`);
  L.push('');

  // ---- decisions made without the human
  const rulings = ledger.filter((l) => /\[(ruling|checkpoint|contract)\]/.test(l)).map((l) => l.replace(/^- \S+ /, ''));
  if (rulings.length) {
    L.push('## Decisions made without you',
      'Rulings and checkpoints from the ledger. Each ruling says what was decided, why, and what it costs if wrong.', '',
      ...rulings.slice(0, 20).map((l) => `- ${oneLine(l, 500)}`), '');
  }

  // ---- open items
  if (allRisks.length || allQuestions.length || minorFindings.length) {
    L.push('## Still open (not blocking)');
    if (allRisks.length) L.push('**Risks noted by the engineers:**', ...bullets(allRisks, 12));
    if (allQuestions.length) L.push('', '**Open questions:**', ...bullets(allQuestions, 8));
    if (minorFindings.length) L.push('', `**Minor review findings (${minorFindings.length}):**`, ...bullets(minorFindings, 12));
    L.push('');
  }

  // ---- files and commits
  if (epicExists) {
    const stat = sh('git', ['diff', '--stat', `${base}...${epic}`], { cwd: root }).out.replace(/\s+$/, ''); // untrimmed: keeps column alignment
    const log = tryGit(['log', '--oneline', '--no-decorate', `${base}..${epic}`], root) || '';
    L.push('## Files changed', '```', stat.split('\n').slice(-40).join('\n'), '```', '');
    L.push('<details><summary>Commits</summary>', '', '```', log.split('\n').slice(0, 40).join('\n'), '```', '', '</details>', '');
  }

  // ---- verify and merge
  const gates = [...(cfg.gates?.contracts || []), ...(cfg.gates?.fast || []), ...(cfg.gates?.full || [])];
  L.push('## Check it yourself', '```sh', `git checkout ${epic}`, ...(gates.length ? gates : ['# no gate commands configured']), `git checkout ${base}`, '```');
  L.push('', '## Merge it (your decision)', '```sh', `git checkout ${base} && git merge --no-ff ${epic}`, '```', '');
  L.push(`Everything above comes from ${code(runDir)}: the ledger, ${code('tasks/<id>/report.json')}, the ${code('review-*.json')} files and the gate results.`);
  return L.join('\n') + '\n';
}

export function writeReport(runDir) {
  const p = path.join(runDir, 'report.md');
  fs.writeFileSync(p, buildReport(runDir));
  return p;
}
