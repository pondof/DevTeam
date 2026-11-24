export const meta = {
  name: 'design',
  description: 'devteam design: the architect freezes contracts and writes design.md + plan.json (task DAG with file ownership), then a security threat model and a Gemini cross-model design review challenge it in parallel',
  whenToUse: 'Started by the devteam feature skill after checkpoint 1, with the JSON printed by `devteam run args <run> design`. A bare invocation does nothing.',
  phases: [
    { title: 'Design', detail: 'architect: contracts first, design.md, ADRs, plan.json, `devteam plan check`' },
    { title: 'Challenge', detail: 'security threat model + Gemini design review, in parallel' },
  ],
}

let A = args
if (typeof A === 'string') { try { A = JSON.parse(A) } catch { A = null } }
if (!A || !A.runDir || !A.cfg || !A.epicBranch) {
  return { started: false, reason: 'missing args', next: 'Run `devteam run args <run> design` and pass its JSON object as the Workflow args. Use /devteam:feature.' }
}
const { runDir, cfg } = A
const R = cfg.roles
const STR = { type: 'string' }
const STRS = { type: 'array', items: STR }
const DESIGN = {
  type: 'object',
  properties: {
    summary: STR, design_path: STR, plan_path: STR, contract_sha: STR,
    task_count: { type: 'integer' }, waves: { type: 'integer' }, plan_check: { type: 'string', enum: ['ok', 'failed'] },
    open_questions: STRS, risks: STRS,
  },
  required: ['summary', 'design_path', 'plan_path', 'task_count', 'plan_check'],
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
const marker = (role, m) => `DEVTEAM run=${runDir} task=- role=${role} mode=${m}`
const opts = (name, extra) => ({ agentType: R[name].agentType, model: R[name].model, effort: R[name].effort, ...extra })
const short = (r) => r && ({ verdict: r.verdict, summary: (r.summary || '').slice(0, 500), findings: (r.findings || []).filter((f) => f.severity !== 'nit').slice(0, 12) })

phase('Design')
const design = await agent([
  marker('architect', A.feedback ? 'revise' : 'design'),
  `You are designing the feature for the devteam run at ${runDir}. You are in the main checkout on the epic branch ${A.epicBranch} (base ${A.baseBranch}).`,
  `Spec: ${A.specPath}`,
  `Repo map: ${A.mapPath} (if it exists)`,
  A.feedback ? `This is a revision. The human / reviewers asked for:\n${A.feedback}` : '',
  'Follow your role instructions: contracts first (committed), design.md, ADRs if needed, plan.json, and `devteam plan check` until it passes. Return the structured output.',
].filter(Boolean).join('\n'), opts('architect', { schema: DESIGN, label: 'architect', phase: 'Design' }))

if (!design || design.plan_check !== 'ok') {
  return { runDir, design, stopped: 'design_incomplete', next: 'Show the human what the architect produced and why the plan check failed; re-run design with feedback or fix plan.json with the architect.' }
}

phase('Challenge')
const jobs = []
if (R['security-engineer']) {
  jobs.push(() => agent(`${marker('security-engineer', 'threat')}\nThreat-model the design. Spec ${runDir}/spec.md, design ${runDir}/design.md, plan ${runDir}/plan.json, contract diff: git diff ${A.baseBranch}...${A.epicBranch} -- packages/contracts`,
    opts('security-engineer', { schema: REVIEW, label: 'threat-model', phase: 'Challenge' })).then((r) => r && { lens: 'security', ...r }))
}
if (cfg.gemini?.enabled && R['gemini-bridge']) {
  jobs.push(() => agent(`${marker('gemini-bridge', 'design-review')}\nRun with a Bash timeout of 600000 ms:\ndevteam-agy review --kind design --run "${runDir}" --base ${A.baseBranch} --head ${A.epicBranch}`,
    opts('gemini-bridge', { schema: REVIEW, label: 'gemini:design-review', phase: 'Challenge' })).then((r) => r && { lens: 'gemini', ...r }))
}
const reviews = (await parallel(jobs)).filter(Boolean)
const usable = reviews.filter((r) => !/^UNAVAILABLE/.test(r.summary || ''))
const blocking = usable.flatMap((r) => (r.findings || []).filter((f) => f.severity === 'critical' || f.severity === 'major').map((f) => ({ lens: r.lens, ...f })))

return {
  runDir,
  design,
  reviews: usable.map((r) => ({ lens: r.lens, ...short(r) })),
  unavailable: reviews.filter((r) => /^UNAVAILABLE/.test(r.summary || '')).map((r) => r.lens),
  blocking_count: blocking.length,
  blocking: blocking.slice(0, 15),
  next: blocking.length
    ? 'Checkpoint 2: show the human the design summary, waves and the blocking findings; recommend a revision (re-run design with --feedback summarizing the findings to fix) unless the human accepts the risks.'
    : 'Checkpoint 2: show the human the design summary, the contract diff stat, the waves from `devteam plan check`, and any minor findings; ask for approval to build.',
}
