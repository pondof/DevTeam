// Consistency checks for the plugin and for a project's devteam config.
import fs from 'node:fs';
import path from 'node:path';
import { PLUGIN_ROOT, readJSON, readText, exists, patternsOverlap, excludedBy } from './util.mjs';
import { effectiveConfig, pluginRegistry } from './config.mjs';

const KINDS = new Set(['main', 'planner', 'implementer', 'integrator', 'reviewer', 'support', 'bridge']);
const MODELS = new Set(['opus', 'sonnet', 'haiku', 'fable', 'inherit']);
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

export function frontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return null;
  const fm = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (kv) fm[kv[1]] = kv[2].replace(/^["']|["']$/g, '');
  }
  fm._body = text.slice(m[0].length);
  return fm;
}

export function lintAgentFile(file, roleName, role, problems) {
  const fm = frontmatter(readText(file));
  if (!fm) return problems.push(`error: ${file}: missing frontmatter`);
  if (fm.name !== roleName) problems.push(`error: ${file}: name "${fm.name}" should be "${roleName}"`);
  if (!fm.description) problems.push(`error: ${file}: description required`);
  if (!MODELS.has(fm.model)) problems.push(`error: ${file}: model must be one of ${[...MODELS].join('/')} (explicit, so agents never inherit the session's tier)`);
  if (!EFFORTS.has(fm.effort)) problems.push(`error: ${file}: effort must be one of ${[...EFFORTS].join('/')}`);
  if (!fm.tools) problems.push(`error: ${file}: tools must be listed explicitly`);
  if (role && role.kind === 'reviewer' && /\b(Edit|Write|NotebookEdit)\b/.test(fm.tools || '')) problems.push(`error: ${file}: reviewer roles must not have Edit/Write tools`);
  if (role && role.model && fm.model !== role.model && role.engine === 'claude') problems.push(`warn: ${file}: frontmatter model ${fm.model} differs from roles.json ${role.model} (workflows pass the roles.json value)`);
  if (role && role.kind === 'implementer' && !/devteam task start/.test(fm._body)) problems.push(`error: ${file}: implementer body must tell the agent to run \`devteam task start\``);
}

export function lintPlugin() {
  const problems = [];
  let reg;
  try { reg = pluginRegistry(); } catch (e) { return [`error: roles.json: ${e.message}`]; }
  const agentsDir = path.join(PLUGIN_ROOT, 'agents');
  const agentFiles = new Set(fs.readdirSync(agentsDir).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3)));
  for (const [name, role] of Object.entries(reg.roles)) {
    if (!KINDS.has(role.kind)) problems.push(`error: roles.json ${name}: unknown kind ${role.kind}`);
    if (!['claude', 'gemini'].includes(role.engine)) problems.push(`error: roles.json ${name}: engine must be claude or gemini`);
    if (role.kind === 'implementer' && !(role.owns || []).length) problems.push(`error: roles.json ${name}: implementers must own at least one glob`);
    if (!agentFiles.has(name)) { problems.push(`error: agents/${name}.md missing for role ${name}`); continue; }
    lintAgentFile(path.join(agentsDir, `${name}.md`), name, role, problems);
    agentFiles.delete(name);
  }
  for (const orphan of agentFiles) problems.push(`warn: agents/${orphan}.md has no roles.json entry (workflows cannot route to it)`);
  const impl = Object.entries(reg.roles).filter(([, r]) => r.kind === 'implementer' && r.enabled !== false);
  for (let i = 0; i < impl.length; i++) for (let j = i + 1; j < impl.length; j++) {
    const [a, ra] = impl[i]; const [b, rb] = impl[j];
    // Cross-cutting file-type globs (**/Dockerfile, **/*.e2e.ts, **/README.md) overlap by design; report directory overlaps only.
    const dirGlobs = (owns) => owns.filter((g) => !g.startsWith('**/') && !g.startsWith('!'));
    const hits = [];
    for (const ga of dirGlobs(ra.owns)) for (const gb of dirGlobs(rb.owns)) {
      // An explicit carve-out ("!packages/db/seeds/**") on either side makes nested ownership intentional.
      if (patternsOverlap(ga, gb) && !excludedBy(ra.owns, gb) && !excludedBy(rb.owns, ga)) hits.push(`${ga} ~ ${gb}`);
    }
    if (hits.length) problems.push(`warn: ownership overlap ${a} <-> ${b}: ${hits.join(', ')} (tasks must split these files explicitly)`);
  }
  try { readJSON(path.join(PLUGIN_ROOT, 'hooks', 'hooks.json')); } catch (e) { problems.push(`error: hooks/hooks.json: ${e.message}`); }
  for (const f of fs.readdirSync(path.join(PLUGIN_ROOT, 'workflows'))) {
    if (!f.endsWith('.js')) continue;
    const src = readText(path.join(PLUGIN_ROOT, 'workflows', f));
    if (!src.startsWith('export const meta')) problems.push(`error: workflows/${f}: must start with \`export const meta\``);
    if (/Date\.now\(\)|Math\.random\(\)|new Date\(\)/.test(src)) problems.push(`error: workflows/${f}: Date.now/Math.random/new Date() break workflow resume`);
  }
  const skillsDir = path.join(PLUGIN_ROOT, 'skills');
  for (const s of fs.readdirSync(skillsDir)) {
    const p = path.join(skillsDir, s, 'SKILL.md');
    if (!exists(p)) { problems.push(`error: skills/${s}/SKILL.md missing`); continue; }
    const fm = frontmatter(readText(p));
    if (!fm?.name || !fm?.description) problems.push(`error: skills/${s}/SKILL.md: name and description required`);
  }
  for (const f of fs.readdirSync(path.join(PLUGIN_ROOT, 'templates', 'schemas'))) {
    try { readJSON(path.join(PLUGIN_ROOT, 'templates', 'schemas', f)); } catch (e) { problems.push(`error: templates/schemas/${f}: ${e.message}`); }
  }
  return problems;
}

export function lintProject(root) {
  const problems = [];
  const p = path.join(root, '.team', 'config.json');
  if (!exists(p)) return problems;
  let proj;
  try { proj = readJSON(p); } catch (e) { return [`error: .team/config.json: ${e.message}`]; }
  const cfg = effectiveConfig(root);
  for (const [name, over] of Object.entries(proj.roles || {})) {
    const role = cfg.roles[name];
    if (role.local) {
      const f = path.join(root, '.claude', 'agents', `${name}.md`);
      if (!exists(f)) problems.push(`error: local role ${name}: ${path.relative(root, f)} missing`);
      else lintAgentFile(f, name, role, problems);
      if (!KINDS.has(role.kind)) problems.push(`error: local role ${name}: kind required (${[...KINDS].join('/')})`);
    } else if (!pluginRegistry().roles[name]) {
      problems.push(`error: .team/config.json role ${name} is not a plugin role; add "local": true and an agent file to define a new one`);
    }
    if (over.owns && !Array.isArray(over.owns)) problems.push(`error: role ${name}: owns must be an array`);
  }
  for (const k of ['fast', 'contracts', 'full', 'security']) {
    if (cfg.gates?.[k] && !Array.isArray(cfg.gates[k])) problems.push(`error: gates.${k} must be an array of shell commands`);
  }
  if (!(cfg.gates?.fast || []).length) problems.push('warn: gates.fast is empty: implementers will pass the gate without lint/typecheck/tests');
  return problems;
}
