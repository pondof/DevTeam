// /devteam:init — non-destructive project setup. Existing files are kept unless --force.
import fs from 'node:fs';
import path from 'node:path';
import { PLUGIN_ROOT, mainRoot, readJSON, writeJSON, readText, exists, sh } from './util.mjs';

const T = (...p) => path.join(PLUGIN_ROOT, 'templates', 'project', ...p);

function union(a = [], b = []) {
  return [...new Set([...a, ...b])];
}

export function initProject({ stack = 'ts', sandbox = true, force = false, cwd = process.cwd() } = {}) {
  const root = mainRoot(cwd);
  if (!root) throw new Error('run init inside a git repository (git init first)');
  const actions = [];
  const write = (rel, content) => {
    const p = path.join(root, rel);
    if (exists(p) && !force) { actions.push(`kept     ${rel}`); return false; }
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
    actions.push(`wrote    ${rel}`);
    return true;
  };

  // .team/config.json
  const cfgTemplate = readJSON(T(`config.${stack}.json`), null) || readJSON(T('config.generic.json'));
  cfgTemplate.project = path.basename(root);
  write('.team/config.json', JSON.stringify(cfgTemplate, null, 2) + '\n');
  fs.mkdirSync(path.join(root, '.team', 'context'), { recursive: true });
  fs.mkdirSync(path.join(root, '.team', 'runs'), { recursive: true });

  // AGENTS.md + symlinks so Claude and Gemini read the same rules
  const agentsMd = path.join(root, 'AGENTS.md');
  const claudeMd = path.join(root, 'CLAUDE.md');
  if (!exists(agentsMd) && exists(claudeMd) && !fs.lstatSync(claudeMd).isSymbolicLink()) {
    actions.push('kept     CLAUDE.md (existing). Merge it into AGENTS.md and symlink CLAUDE.md -> AGENTS.md when ready');
  } else {
    write('AGENTS.md', readText(T(`AGENTS.${stack}.md`)) || readText(T('AGENTS.generic.md')));
    for (const link of ['CLAUDE.md', 'GEMINI.md']) {
      const p = path.join(root, link);
      if (!exists(p)) { fs.symlinkSync('AGENTS.md', p); actions.push(`linked   ${link} -> AGENTS.md`); }
      else actions.push(`kept     ${link}`);
    }
  }

  // .gitignore
  const gi = path.join(root, '.gitignore');
  const lines = ['.team/runs/', '.team/current', '.team/context/', '.team/worktrees/', '.team/hook-errors.log', '.devteam/', '.claude/worktrees/', '.claude/settings.local.json'];
  const cur = readText(gi);
  const missing = lines.filter((l) => !cur.split('\n').includes(l));
  if (missing.length) {
    fs.writeFileSync(gi, cur + (cur && !cur.endsWith('\n') ? '\n' : '') + (cur ? '\n' : '') + '# devteam\n' + missing.join('\n') + '\n');
    actions.push(`updated  .gitignore (+${missing.length})`);
  }

  // .claude/settings.json (merged, never replaced)
  const sp = path.join(root, '.claude', 'settings.json');
  const tmpl = readJSON(T('settings.json'));
  const existing = readJSON(sp, {});
  const merged = { ...existing };
  merged.permissions = {
    ...(existing.permissions || {}),
    // The Edit rule also lets sandboxed Bash in task worktrees write the run ledger in the main checkout.
    allow: union(existing.permissions?.allow, [...tmpl.permissions.allow, `Edit(/${path.join(root, '.team')}/**)`]),
    deny: union(existing.permissions?.deny, tmpl.permissions.deny),
  };
  if (sandbox && !existing.sandbox) merged.sandbox = tmpl.sandbox;
  if (merged.sandbox) {
    // Sandboxed agent commands may write the run ledger and pnpm's global store (both outside the worktree).
    // Git metadata lives in the main checkout's .git, which the sandbox always protects: that is why
    // `devteam *` (task start, commit, merge) is in excludedCommands rather than .git in allowWrite.
    const extra = [path.join(root, '.team')];
    const store = sh('pnpm', ['store', 'path'], { cwd: root });
    if (store.code === 0 && store.out.trim()) extra.push(path.dirname(store.out.trim()));
    merged.sandbox.filesystem = { ...(merged.sandbox.filesystem || {}), allowWrite: union(merged.sandbox.filesystem?.allowWrite, extra) };
  }
  writeJSON(sp, merged);
  actions.push(`merged   .claude/settings.json${sandbox && !existing.sandbox ? ' (sandbox on)' : ''}`);

  // CI with deterministic gates only (no LLM calls, no API keys)
  const ci = readText(T(`ci.${stack}.yml`));
  if (ci) write('.github/workflows/devteam-ci.yml', ci);

  // Contracts and ADR folders the architect owns
  if (stack === 'ts') {
    fs.mkdirSync(path.join(root, 'docs', 'adr'), { recursive: true });
    if (!exists(path.join(root, 'docs', 'adr', '0000-template.md'))) write('docs/adr/0000-template.md', readText(T('adr-template.md')));
  }
  return { root, actions };
}
