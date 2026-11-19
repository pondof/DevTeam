export const meta = {
  name: 'build',
  description: 'devteam build: implement planned tasks wave by wave in isolated worktrees, review each with risk-routed lenses and a capped fix loop, merge in DAG order, then system QA and final cross-model review',
  whenToUse: 'Started by the devteam feature, quick, bugfix and replay skills with the JSON printed by `devteam run args <run> build`. A bare invocation does nothing.',
  phases: [
    { title: 'Prep', detail: 'integrator installs planned dependencies once, before wave 1' },
    { title: 'Implement', detail: 'one engineer per task in its own worktree; the stop hook enforces a green gate' },
    { title: 'Review', detail: 'code review plus security / data / infra / Gemini lenses routed by risk tags and files; fix loop' },
    { title: 'Integrate', detail: 'serial merge queue per wave, gated after every merge, rolled back on red' },
    { title: 'Final', detail: 'system QA, whole-branch review, security scanners, Gemini cross-review' },
  ],
}

// ---------- args ----------
let A = args
if (typeof A === 'string') { try { A = JSON.parse(A) } catch { A = null } }
if (!A || !A.runDir || !A.plan || !A.cfg || !A.epicBranch) {
  return { started: false, reason: 'missing args', next: 'Run `devteam run args <run> build` and pass its JSON object as the Workflow args (an object, not a string). Use /devteam:feature or /devteam:quick.' }
}
const { runDir, plan, cfg } = A
const mode = A.mode || 'feature'
const R = cfg.roles
const byId = new Map(plan.tasks.map((t) => [t.id, t]))
const only = A.only ? new Set(A.only) : null
const results = {}
for (const id of A.done || []) results[id] = { id, status: 'merged', note: 'merged in an earlier pass' }
const stats = { claude_agents: 0, gemini_agents: 0, fix_rounds: 0, gemini_unavailable: 0 }

// ---------- schemas (keep in sync with templates/schemas) ----------
const STR = { type: 'string' }
const STRS = { type: 'array', items: STR }
const REPORT = {
  type: 'object',
  properties: {
    task_id: STR,
    status: { type: 'string', enum: ['done', 'blocked', 'needs_contract_change', 'failed', 'unavailable'] },
    summary: STR, branch: STR, head_sha: STR, worktree: STR, files_changed: STRS,
    commands_run: { type: 'array', items: { type: 'object', properties: { cmd: STR, exit_code: { type: 'integer' } }, required: ['cmd', 'exit_code'] } },
    tests_added: STRS, deps_requested: STRS, contract_change_request: STR, decisions: STRS, open_questions: STRS, risks: STRS,
  },
  required: ['task_id', 'status', 'summary', 'branch', 'head_sha', 'worktree', 'files_changed', 'commands_run', 'contract_change_request'],
}
const REVIEW = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['approve', 'changes_requested'] },
    summary: STR,
    findings: { type: 'array', items: { type: 'object', properties: { severity: { type: 'string', enum: ['critical', 'major', 'minor', 'nit'] }, file: STR, line: { type: 'integer' }, issue: STR, fix: STR }, required: ['severity', 'file', 'issue'] } },
  },
  required: ['verdict', 'summary', 'findings'],
}
const MERGE = {
  type: 'object',
  properties: {
    merged: STRS,
    failed: { type: 'array', items: { type: 'object', properties: { task: STR, status: STR, files: STRS, reason: STR }, required: ['task', 'status', 'reason'] } },
    head: STR,
  },
  required: ['merged', 'failed', 'head'],
}
const PREP = { type: 'object', properties: { status: { type: 'string', enum: ['ok', 'partial', 'failed'] }, installed: STRS, failed: STRS }, required: ['status', 'installed', 'failed'] }
const DEBUG = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['reproduced', 'diagnosed', 'not_reproduced'] },
    root_cause: STR, evidence: STR, failing_test: STR, head_sha: STR, fix_plan: STR, owner_role: STR, scope_change: STR,
  },
  required: ['status', 'root_cause', 'fix_plan', 'owner_role'],
}
const QA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['pass', 'fail'] }, summary: STR,
    failures: { type: 'array', items: { type: 'object', properties: { test: STR, acceptance: STR, suspected_task: STR, evidence: STR }, required: ['test', 'evidence'] } },
    flaky_suspects: STRS,
  },
  required: ['status', 'summary', 'failures'],
}

// ---------- helpers ----------
function semaphore(n) {
  let active = 0
  const queue = []
  const pump = () => {
    while (active < n && queue.length) {
      const { fn, resolve, reject } = queue.shift()
      active++
      Promise.resolve().then(fn).then(resolve, reject).finally(() => { active--; pump() })
    }
  }
  return (fn) => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); pump() })
}
const claudeSlot = semaphore(Math.max(1, cfg.parallel?.claude || 2))
const geminiSlot = semaphore(Math.max(1, cfg.parallel?.gemini || 2))
const marker = (task, role, m) => `DEVTEAM run=${runDir} task=${task} role=${role} mode=${m}`
function roleOpts(name, final) {
  const r = R[name]
  if (!r) throw new Error(`role ${name} is not enabled in this project`)
  return { agentType: r.agentType, model: final && r.final_model ? r.final_model : r.model, effort: final && r.final_effort ? r.final_effort : r.effort }
}
const claudeAgent = (prompt, opts) => claudeSlot(() => { stats.claude_agents++; return agent(prompt, opts) })
const geminiAgent = (prompt, opts) => geminiSlot(() => { stats.gemini_agents++; return agent(prompt, { ...opts, ...roleOpts('gemini-bridge') }) })
const geminiOn = !!cfg.gemini?.enabled && !!R['gemini-bridge']
const unavailable = (r) => !r || r.status === 'unavailable' || /^UNAVAILABLE/.test(r.summary || '')

function globRe(glob) {
  let g = String(glob).replace(/^\.\//, '')
  if (g.endsWith('/')) g += '**'
  let re = ''
  for (let i = 0; i < g.length; i++) {
    const c = g[i]
    if (c === '*') {
      if (g[i + 1] === '*') { if (g[i + 2] === '/') { re += '(?:.*/)?'; i += 2 } else { re += '.*'; i += 1 } } else re += '[^/]*'
    } else if (c === '?') re += '[^/]'
    else if ('\\^$+.()|{}[]'.includes(c)) re += '\\' + c
    else re += c
  }
  return new RegExp('^' + re + '$')
}
const anyMatch = (globs, files) => (globs || []).some((g) => { const re = globRe(g); return files.some((f) => re.test(f)) })
const shortReport = (r) => r && ({ status: r.status, engine: r.engine, summary: (r.summary || '').slice(0, 400), files: (r.files_changed || []).length, deps_requested: r.deps_requested || [], contract_change_request: r.contract_change_request || '', open_questions: (r.open_questions || []).slice(0, 5), risks: (r.risks || []).slice(0, 5) })
const shortReview = (r) => r && ({ lens: r.lens, verdict: r.verdict, summary: (r.summary || '').slice(0, 300), findings: (r.findings || []).filter((f) => f.severity === 'critical' || f.severity === 'major').slice(0, 8) })
const blocking = (reviews) => reviews.filter((r) => r.verdict === 'changes_requested')
  .flatMap((r) => (r.findings || []).filter((f) => f.severity === 'critical' || f.severity === 'major').map((f) => ({ ...f, lens: r.lens })))

function engineOf(t) {
  if (!geminiOn) return 'claude'
  if (t.engine) return t.engine
  if (A.overflow && t.low_risk) return 'gemini'
  return R[t.role]?.engine || 'claude'
}

// ---------- implement ----------
async function implement(t, round, findings) {
  const m = round ? 'fix' : 'implement'
  const fb = findings && findings.length ? JSON.stringify(findings).slice(0, 6000) : ''
  if (engineOf(t) === 'gemini') {
    const pre = fb ? `mkdir -p .devteam && cat > .devteam/feedback.json <<'DEVTEAM_EOF'\n${fb}\nDEVTEAM_EOF\n` : ''
    const rep = await geminiAgent(
      `${marker(t.id, 'gemini-bridge', m)}\nRun this in your current directory with a Bash timeout of 600000 ms:\n${pre}devteam-agy run --run "${runDir}" --task ${t.id}${fb ? ' --feedback-file .devteam/feedback.json' : ''}`,
      { isolation: 'worktree', schema: REPORT, label: `${t.id}:${t.role}:gemini${round ? ':fix' + round : ''}`, phase: 'Implement' })
    if (!unavailable(rep)) return { ...rep, engine: 'gemini' }
    stats.gemini_unavailable++
    log(`${t.id}: Gemini unavailable (${(rep && (rep.summary || rep.reason)) || 'no result'}); falling back to Claude ${t.role}`)
  }
  const prompt = [
    marker(t.id, t.role, m),
    `You are implementing task ${t.id} ("${t.title}") of the devteam run at ${runDir}.`,
    `First command: devteam task start "${runDir}" ${t.id}`,
    fb ? `Reviewers requested changes (fix round ${round}). Your worktree already holds your previous commit. Address every finding below, then commit and re-run the gate:\n${fb}` : '',
    'Finish with `devteam commit` and a green `devteam gate`, then return your report as structured output.',
  ].filter(Boolean).join('\n')
  const rep = await claudeAgent(prompt, { ...roleOpts(t.role), isolation: 'worktree', schema: REPORT, label: `${t.id}:${t.role}${round ? ':fix' + round : ''}`, phase: 'Implement' })
  return rep ? { ...rep, engine: 'claude' } : null
}

// ---------- review ----------
function lensesFor(t, rep) {
  const files = rep.files_changed && rep.files_changed.length ? rep.files_changed : t.files
  const lenses = [{ name: 'code', role: 'code-reviewer' }]
  for (const [name, r] of Object.entries(R)) {
    if (!r.review_when || name === 'code-reviewer' || name === t.role) continue
    const tagHit = (r.review_when.tags || []).some((x) => (t.risk || []).includes(x))
    if (tagHit || anyMatch(r.review_when.globs, files)) lenses.push({ name, role: name })
  }
  const policy = cfg.gemini?.review_tasks || 'risky'
  if (geminiOn && (policy === 'all' || (policy === 'risky' && (t.risk || []).length))) lenses.push({ name: 'gemini', gemini: true })
  return lenses
}

async function review(t, rep, round) {
  const lenses = lensesFor(t, rep)
  const ctx = [
    `Task ${t.id} "${t.title}" implemented by ${t.role} (${rep.engine}). Review round ${round + 1}.`,
    `Branch ${rep.branch}, head ${rep.head_sha}, worktree ${rep.worktree}.`,
    `Diff: git diff ${A.epicBranch}...${rep.head_sha}   Brief: devteam task brief "${runDir}" ${t.id}`,
    `Engineer report: ${JSON.stringify({ summary: rep.summary, decisions: rep.decisions, risks: rep.risks, tests_added: rep.tests_added, open_questions: rep.open_questions }).slice(0, 3000)}`,
  ].join('\n')
  const out = await parallel(lenses.map((l) => async () => {
    if (l.gemini) {
      const r = await geminiAgent(`${marker(t.id, 'gemini-bridge', 'review')}\nRun with a Bash timeout of 600000 ms:\ndevteam-agy review --kind task --run "${runDir}" --task ${t.id} --base ${A.epicBranch} --head ${rep.head_sha}`,
        { schema: REVIEW, label: `${t.id}:review:gemini`, phase: 'Review' })
      if (unavailable(r)) { stats.gemini_unavailable++; return null }
      return { lens: 'gemini', ...r }
    }
    const r = await claudeAgent(`${marker(t.id, l.role, 'review')}\n${ctx}`, { ...roleOpts(l.role), schema: REVIEW, label: `${t.id}:review:${l.name}`, phase: 'Review' })
    return r ? { lens: l.name, ...r } : null
  }))
  return out.filter(Boolean)
}

// ---------- one task end to end ----------
async function runTask(t) {
  let rep = await implement(t, 0)
  for (let round = 0; ; round++) {
    if (!rep) return { id: t.id, status: 'failed', reason: 'the implementer returned no report' }
    if (rep.status !== 'done') return { id: t.id, status: rep.status, branch: rep.branch, head: rep.head_sha, report: shortReport(rep) }
    const reviews = await review(t, rep, round)
    const block = blocking(reviews)
    if (!block.length) {
      return { id: t.id, status: 'approved', branch: rep.branch, head: rep.head_sha, engine: rep.engine, rounds: round + 1, report: shortReport(rep), reviews: reviews.map(shortReview) }
    }
    if (round >= (cfg.fix_loop_max ?? 2)) {
      const dbg = await claudeAgent([
        marker(t.id, 'debugger', 'diagnose'),
        `Task ${t.id} ("${t.title}") still has blocking review findings after ${round + 1} rounds. Brief: devteam task brief "${runDir}" ${t.id}. Worktree: ${rep.worktree}. Head: ${rep.head_sha}.`,
        `Last report: ${JSON.stringify(shortReport(rep))}`,
        `Open findings: ${JSON.stringify(block).slice(0, 5000)}`,
        'Diagnose why the attempts did not converge and what must change. Read-only: do not edit files.',
      ].join('\n'), { ...roleOpts('debugger'), schema: DEBUG, label: `${t.id}:diagnose`, phase: 'Review' })
      return { id: t.id, status: 'review_failed', branch: rep.branch, head: rep.head_sha, open_findings: block.slice(0, 10), diagnosis: dbg }
    }
    stats.fix_rounds++
    log(`${t.id}: ${block.length} blocking finding(s) from ${[...new Set(block.map((f) => f.lens))].join(', ')}; fix round ${round + 1}`)
    rep = await implement(t, round + 1, block)
  }
}

// ---------- prep: planned dependencies ----------
if (A.deps_prep && A.deps_prep.length && R.integrator) {
  phase('Prep')
  const prep = await claudeAgent(`${marker('-', 'integrator', 'prep')}\nInstall these planned dependencies on ${A.epicBranch} before wave 1, gate, and commit:\n${A.deps_prep.join('\n')}`,
    { ...roleOpts('integrator'), schema: PREP, label: 'prep:deps', phase: 'Prep' })
  if (!prep || prep.status === 'failed') {
    return { runDir, mode, stopped: 'deps_prep_failed', prep, stats, next: 'Show the human which dependencies failed to install; fix the plan (deps) or install manually, then re-run the build.' }
  }
  log(`deps installed: ${prep.installed.join(', ') || 'none'}${prep.failed.length ? ` (failed: ${prep.failed.join(', ')})` : ''}`)
}

// ---------- bugfix: reproduce first ----------
let reproduction = null
if (mode === 'bugfix') {
  const t0 = plan.tasks[0]
  reproduction = await claudeAgent([
    marker(t0.id, 'debugger', 'reproduce'),
    `Bug to reproduce (task ${t0.id}, owner ${t0.role}): ${t0.title}`,
    `First command: devteam task start "${runDir}" ${t0.id} --role debugger`,
    'Reproduce it with the smallest failing test, find the root cause, commit the failing test with `devteam commit`, and return your structured output.',
  ].join('\n'), { ...roleOpts('debugger'), isolation: 'worktree', schema: DEBUG, label: `${t0.id}:reproduce`, phase: 'Implement' })
  if (!reproduction || reproduction.status === 'not_reproduced') {
    return { runDir, mode, stopped: 'not_reproduced', reproduction, stats, next: 'Tell the human the bug could not be reproduced, with the debugger evidence, and ask for more detail (steps, data, logs).' }
  }
  if (reproduction.owner_role && reproduction.owner_role !== t0.role) log(`debugger suggests ${reproduction.owner_role} should own the fix (plan says ${t0.role})`)
}

// ---------- waves ----------
for (let w = 0; w < plan.waves.length; w++) {
  const ids = plan.waves[w].filter((id) => !results[id] && (!only || only.has(id)))
  if (!ids.length) continue
  const ready = []
  for (const id of ids) {
    const t = byId.get(id)
    const unmet = (t.depends_on || []).filter((d) => (results[d] ? results[d].status !== 'merged' : !only || only.has(d)))
    if (unmet.length) results[id] = { id, status: 'skipped', reason: `dependencies not merged: ${unmet.join(', ')}` }
    else ready.push(t)
  }
  if (!ready.length) continue
  phase('Implement')
  log(`wave ${w + 1}/${plan.waves.length}: ${ready.map((t) => `${t.id}(${t.role}/${engineOf(t)})`).join(' ')}`)
  const outs = await parallel(ready.map((t) => () => runTask(t)))
  outs.forEach((o, i) => { results[ready[i].id] = o || { id: ready[i].id, status: 'failed', reason: 'agent died' } })

  const approved = plan.tasks.map((t) => t.id).filter((id) => results[id] && results[id].status === 'approved' && ready.some((t) => t.id === id))
  if (!approved.length) continue
  phase('Integrate')
  const list = approved.map((id) => `${id} ${results[id].branch}`).join('\n')
  const m = await claudeAgent(`${marker('-', 'integrator', 'merge')}\nRun dir: ${runDir}\nWave ${w + 1}: merge these approved tasks into ${A.epicBranch}, in this order:\n${list}`,
    { ...roleOpts('integrator'), schema: MERGE, label: `wave${w + 1}:merge`, phase: 'Integrate' })
  for (const id of approved) {
    if (m && (m.merged || []).includes(id)) results[id] = { ...results[id], status: 'merged' }
    else {
      const f = m && (m.failed || []).find((x) => x.task === id)
      results[id] = { ...results[id], status: f ? `merge_${f.status}` : 'merge_unknown', merge: f || null }
    }
  }
}

// ---------- final ----------
const merged = Object.values(results).filter((r) => r.status === 'merged')
let final = null
if (merged.length && mode === 'feature' && A.final !== false) {
  phase('Final')
  const ctx = `Epic branch ${A.epicBranch} (checked out in the main checkout), base ${A.baseBranch}. Whole-branch diff: git diff ${A.baseBranch}...${A.epicBranch}. Spec: ${runDir}/spec.md. Design: ${runDir}/design.md. Status: devteam run status "${runDir}".`
  const jobs = [
    () => claudeAgent(`${marker('-', 'qa-engineer', 'system')}\n${ctx}\nRun system QA on the integrated epic branch.`, { ...roleOpts('qa-engineer'), schema: QA, label: 'final:qa', phase: 'Final' }),
    () => claudeAgent(`${marker('-', 'code-reviewer', 'final')}\n${ctx}`, { ...roleOpts('code-reviewer', true), schema: REVIEW, label: 'final:code-review', phase: 'Final' }),
    () => claudeAgent(`${marker('-', 'security-engineer', 'final')}\n${ctx}`, { ...roleOpts('security-engineer', true), schema: REVIEW, label: 'final:security', phase: 'Final' }),
  ]
  if (geminiOn) jobs.push(() => geminiAgent(`${marker('-', 'gemini-bridge', 'final')}\nRun with a Bash timeout of 600000 ms:\ndevteam-agy review --kind final --run "${runDir}" --base ${A.baseBranch} --head ${A.epicBranch}`, { schema: REVIEW, label: 'final:gemini', phase: 'Final' }))
  const [qa, code, sec, gem] = await parallel(jobs)
  final = {
    qa: qa ? { status: qa.status, summary: qa.summary, failures: (qa.failures || []).slice(0, 10) } : null,
    code: shortReview(code && { lens: 'code', ...code }),
    security: shortReview(sec && { lens: 'security', ...sec }),
    gemini: geminiOn ? (unavailable(gem) ? 'unavailable' : shortReview({ lens: 'gemini', ...gem })) : 'disabled',
  }
}

const all = plan.tasks.filter((t) => !only || only.has(t.id)).map((t) => results[t.id] || { id: t.id, status: 'not_run' })
const counts = {}
all.forEach((r) => { counts[r.status] = (counts[r.status] || 0) + 1 })
return {
  runDir, mode, epicBranch: A.epicBranch, counts, stats,
  ...(reproduction ? { reproduction } : {}),
  tasks: all.map((r) => ({ id: r.id, status: r.status, ...(r.reason ? { reason: r.reason } : {}), ...(r.report ? { report: r.report } : {}), ...(r.open_findings ? { open_findings: r.open_findings } : {}), ...(r.diagnosis ? { diagnosis: r.diagnosis } : {}), ...(r.merge ? { merge: r.merge } : {}), ...(r.reviews ? { reviews: r.reviews.map((x) => `${x.lens}:${x.verdict}`) } : {}) })),
  final,
  next: 'Run `devteam run collect "<runDir>" --prune` and `devteam run status "<runDir>"`. Summarize for the human in a few lines; route blocked/needs_contract_change tasks to /devteam:contract-change, review_failed or merge failures to /devteam:replay or /devteam:bugfix, and final findings to a fix decision before checkpoint 3.',
}
