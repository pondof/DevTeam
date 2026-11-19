#!/usr/bin/env node
// Stand-in for the Antigravity CLI in tests. Output shapes copy real `agy -p --output-format json` results
// observed with agy 1.5.10. Behaviour is chosen by FAKE_AGY_MODE; every invocation's argv is appended to
// FAKE_AGY_LOG (one JSON line) so tests can assert flags and permission grants.
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
if (process.env.FAKE_AGY_LOG) fs.appendFileSync(process.env.FAKE_AGY_LOG, JSON.stringify({ argv, cwd: process.cwd() }) + '\n');
const mode = process.env.FAKE_AGY_MODE || 'ok';
const ok = (extra) => {
  process.stdout.write(JSON.stringify({ conversation_id: 'fake', status: 'SUCCESS', response: '', duration_seconds: 0.1, num_turns: 1, usage: { total_tokens: 1 }, ...extra }) + '\n');
};
const schema = argv.includes('--json-schema') ? argv[argv.indexOf('--json-schema') + 1] : '';

switch (mode) {
  case 'ok':
    if (schema.includes('review')) ok({ structured_output: { verdict: 'approve', summary: 'fake review ok', findings: [] } });
    else if (schema) ok({ structured_output: { ok: true, model: 'Fake Gemini' } });
    else ok({ response: '# Repository Map\n\n## 1. Overview\nfake map\n' });
    break;
  case 'changes':
    ok({ structured_output: { verdict: 'changes_requested', summary: 'fake finding', findings: [{ severity: 'major', file: 'apps/api/src/index.ts', line: 1, issue: 'x is wrong', fix: 'make it right' }] } });
    break;
  case 'denied': // what agy prints when a tool needs a permission headless mode cannot grant
    process.stderr.write('jetski: no output produced — a tool required the "command" permission that headless mode cannot prompt for, so it was auto-denied.\n');
    ok({ denied_actions: [{ action: 'command', display_name: 'Bash' }] });
    break;
  case 'quota':
    process.stderr.write('E1119 12:00:00.000000 1 errorreport.go:1] RESOURCE_EXHAUSTED: quota exceeded for model\nError: 429 Too Many Requests\n');
    process.exit(1);
    break;
  case 'garbage':
    process.stdout.write('this is not json\n');
    break;
  case 'edit': { // a task run: one owned file in a NEW directory, one file outside the task's ownership
    fs.mkdirSync(path.join(process.cwd(), 'docs', 'api'), { recursive: true });
    fs.writeFileSync(path.join(process.cwd(), 'docs', 'api', 'new.md'), '# new doc\n');
    fs.writeFileSync(path.join(process.cwd(), 'apps', 'web', 'page.tsx'), 'export default 999;\n');
    ok({ structured_output: { status: 'done', summary: 'Wrote docs/api/new.md. Also touched page.tsx.', contract_change_request: '', decisions: [], risks: [] } });
    break;
  }
  case 'noop': // claims success, changes nothing (the false-success case)
    ok({ structured_output: { status: 'done', summary: 'Documented everything.', contract_change_request: '' } });
    break;
  case 'blocked':
    ok({ structured_output: { status: 'needs_contract_change', summary: 'needs a new field', contract_change_request: 'add field total to ProjectList' } });
    break;
  default:
    process.stderr.write(`unknown FAKE_AGY_MODE ${mode}\n`);
    process.exit(2);
}
