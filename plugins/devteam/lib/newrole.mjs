// Scaffold a new role: agent file + registry entry, then lint. Plugin scope edits this plugin;
// project scope adds a local role under <project>/.claude/agents and .team/config.json.
import fs from 'node:fs';
import path from 'node:path';
import { PLUGIN_ROOT, mainRoot, readJSON, writeJSON, readText, exists } from './util.mjs';
import { lintPlugin, lintProject } from './lint.mjs';

const TOOLS = {
  implementer: 'Read, Edit, Write, Glob, Grep, Bash',
  support: 'Read, Edit, Write, Glob, Grep, Bash',
  planner: 'Read, Edit, Write, Glob, Grep, Bash',
  integrator: 'Read, Edit, Write, Glob, Grep, Bash',
  reviewer: 'Read, Glob, Grep, Bash',
  bridge: 'Bash',
};

export function listRoleTemplates() {
  const dir = path.join(PLUGIN_ROOT, 'templates', 'roles');
  return fs.readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3));
}

export function newRole(name, opts = {}) {
  if (!/^[a-z][a-z0-9-]{1,40}$/.test(name)) throw new Error('role name must be kebab-case, e.g. mobile-engineer');
  const scope = opts.scope || 'project';
  const kind = opts.kind || 'implementer';
  if (!TOOLS[kind]) throw new Error(`kind must be one of ${Object.keys(TOOLS).join(', ')}`);
  const owns = (opts.owns ? String(opts.owns).split(',') : []).map((s) => s.trim()).filter(Boolean);
  if ((kind === 'implementer' || kind === 'support') && !owns.length && !opts.template) throw new Error('implementers need --owns "glob,glob"');
  const model = opts.model || (kind === 'reviewer' ? 'sonnet' : 'sonnet');
  const effort = opts.effort || (kind === 'reviewer' ? 'high' : 'medium');
  const description = opts.description || `${name} (${kind})`;

  let body;
  let entry = {};
  if (opts.template) {
    const tp = path.join(PLUGIN_ROOT, 'templates', 'roles', `${opts.template}.md`);
    if (!exists(tp)) throw new Error(`no role template ${opts.template} (have: ${listRoleTemplates().join(', ')})`);
    body = readText(tp).replace(/^name: .*$/m, `name: ${name}`);
    const meta = body.match(/<!--\s*devteam-role\s+([\s\S]*?)-->/);
    entry = meta ? JSON.parse(meta[1]) : {};
  } else {
    body = readText(path.join(PLUGIN_ROOT, 'templates', 'role.md.tmpl'))
      .replaceAll('{{name}}', name)
      .replaceAll('{{description}}', description)
      .replaceAll('{{model}}', model)
      .replaceAll('{{effort}}', effort)
      .replaceAll('{{tools}}', TOOLS[kind])
      .replaceAll('{{owns}}', owns.map((o) => `- \`${o}\``).join('\n') || '- (read-only role)')
      .replaceAll('{{kind_section}}', readText(path.join(PLUGIN_ROOT, 'templates', `role-section.${kind}.md`)).trim());
  }
  entry = {
    team: opts.team || entry.team || 'build',
    kind: entry.kind || kind,
    engine: opts.engine || entry.engine || 'claude',
    model: opts.model || entry.model || model,
    effort: opts.effort || entry.effort || effort,
    owns: owns.length ? owns : entry.owns || [],
    description: opts.description || entry.description || description,
    ...(opts['review-tags'] || opts['review-globs'] || entry.review_when ? {
      review_when: {
        tags: opts['review-tags'] ? String(opts['review-tags']).split(',') : entry.review_when?.tags || [],
        globs: opts['review-globs'] ? String(opts['review-globs']).split(',') : entry.review_when?.globs || [],
      },
    } : {}),
  };

  const written = [];
  if (scope === 'plugin') {
    const f = path.join(PLUGIN_ROOT, 'agents', `${name}.md`);
    if (exists(f) && !opts.force) throw new Error(`${f} already exists`);
    fs.writeFileSync(f, body);
    written.push(f);
    const regPath = path.join(PLUGIN_ROOT, 'roles.json');
    const reg = readJSON(regPath);
    reg.roles[name] = entry;
    writeJSON(regPath, reg);
    written.push(regPath);
    return { written, problems: lintPlugin() };
  }
  const root = mainRoot(opts.cwd || process.cwd());
  if (!root) throw new Error('project scope needs a git repository');
  const f = path.join(root, '.claude', 'agents', `${name}.md`);
  if (exists(f) && !opts.force) throw new Error(`${f} already exists`);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, body);
  written.push(f);
  const cp = path.join(root, '.team', 'config.json');
  const cfg = readJSON(cp, { roles: {} });
  cfg.roles = cfg.roles || {};
  cfg.roles[name] = { local: true, ...entry };
  writeJSON(cp, cfg);
  written.push(cp);
  return { written, problems: lintProject(root) };
}
