export const meta = {
  name: 'review',
  description: 'devteam review: multi-lens review of a branch or the whole repo (code, security with scanners, Gemini cross-model), then adversarial verification of every critical/major finding',
  whenToUse: 'Started by the devteam review skill with the JSON printed by `devteam run args <run> review`. A bare invocation does nothing.',
  phases: [
    { title: 'Find', detail: 'code-reviewer, security-engineer (runs scanners), Gemini, in parallel' },
    { title: 'Verify', detail: 'one skeptic per critical/major finding tries to refute it' },
  ],
}

let A = args
if (typeof A === 'string') { try { A = JSON.parse(A) } catch { A = null } }
if (!A || !A.runDir || !A.cfg || !A.base) {
  return { started: false, reason: 'missing args', next: 'Run `devteam run args <run> review --base <ref> --head <ref>` and pass its JSON object. Use /devteam:review.' }
}
const { runDir, cfg } = A
const R = cfg.roles
const STR = { type: 'string' }
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
const scope = A.mode === 'audit'
  ? `Audit the whole repository at its current HEAD (${A.head}); compare against ${A.base} only to see recent change. Prioritize breadth: the highest-severity, most reachable problems first.`
  : `Review the change ${A.base}...${A.head} (git diff ${A.base}...${A.head}).`
const focus = A.focus ? `\nFocus: ${A.focus}` : ''

phase('Find')
const jobs = [
  () => agent(`${marker('code-reviewer', 'final')}\n${scope}${focus}`, opts('code-reviewer', { model: R['code-reviewer'].final_model || R['code-reviewer'].model, schema: REVIEW, label: 'find:code', phase: 'Find' })).then((r) => r && { lens: 'code', ...r }),
  () => agent(`${marker('security-engineer', 'final')}\n${scope}${focus}`, opts('security-engineer', { schema: REVIEW, label: 'find:security', phase: 'Find' })).then((r) => r && { lens: 'security', ...r }),
]
if (cfg.gemini?.enabled && R['gemini-bridge']) {
  jobs.push(() => agent(`${marker('gemini-bridge', 'review')}\nRun with a Bash timeout of 600000 ms:\ndevteam-agy review --kind final --run "${runDir}" --base ${A.base} --head ${A.head}${A.focus ? ` --focus "${String(A.focus).replace(/"/g, "'")}"` : ''}`,
    opts('gemini-bridge', { schema: REVIEW, label: 'find:gemini', phase: 'Find' })).then((r) => r && { lens: 'gemini', ...r }))
}
const found = (await parallel(jobs)).filter(Boolean).filter((r) => !/^UNAVAILABLE/.test(r.summary || ''))
const serious = found.flatMap((r) => (r.findings || []).filter((f) => f.severity === 'critical' || f.severity === 'major').map((f) => ({ lens: r.lens, ...f })))
const minor = found.flatMap((r) => (r.findings || []).filter((f) => f.severity === 'minor').map((f) => ({ lens: r.lens, ...f })))

// Dedupe by file + line + first words of the issue, keeping the most severe.
const key = (f) => `${f.file}:${f.line || 0}:${String(f.issue).toLowerCase().split(/\W+/).slice(0, 6).join(' ')}`
const unique = []
const seen = new Map()
for (const f of serious) {
  const k = key(f)
  if (seen.has(k)) { const prev = seen.get(k); prev.lenses.push(f.lens); continue }
  const entry = { ...f, lenses: [f.lens] }
  seen.set(k, entry); unique.push(entry)
}

phase('Verify')
const verified = await parallel(unique.map((f, i) => () =>
  agent(`${marker('code-reviewer', 'refute')}\nTry to refute this finding from the code. Default to refuted (verdict approve) only if you can show it is wrong.\n${JSON.stringify(f)}`,
    opts('code-reviewer', { effort: 'medium', schema: REVIEW, label: `verify:${i + 1}`, phase: 'Verify' }))
    .then((v) => ({ finding: f, stands: !v || v.verdict === 'changes_requested', evidence: v ? (v.summary || '').slice(0, 400) : 'verifier unavailable' }))))

const confirmed = verified.filter((v) => v && v.stands).map((v) => ({ ...v.finding, verification: v.evidence }))
const refuted = verified.filter((v) => v && !v.stands).map((v) => ({ file: v.finding.file, issue: v.finding.issue, why: v.evidence }))
return {
  runDir, base: A.base, head: A.head, mode: A.mode || 'diff',
  lenses: found.map((r) => `${r.lens}:${r.verdict}`),
  confirmed, refuted, minor: minor.slice(0, 20),
  next: 'Write the confirmed findings to <runDir>/review.md (most severe first) and summarize for the human; offer /devteam:bugfix or /devteam:quick per confirmed finding.',
}
