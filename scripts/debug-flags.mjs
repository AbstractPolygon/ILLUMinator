// Lists the debug switches and test hooks the code reads (app/js/core/debugflags.js) into docs/debug-flags.md, so there is one place that says what exists and where.
//
//   node scripts/debug-flags.mjs          rewrites docs/debug-flags.md
//   node scripts/debug-flags.mjs --check  exits 1 when the file is out of date (test/debugflags-doc.test.mjs runs this)
//
// Switches are found in the code itself: a name read from `debugFlags()` (directly, through a variable it was assigned to in the same function, or by destructuring).
// Hooks are the names passed to hook() and setHook().
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as espree from 'espree';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(root, 'docs/debug-flags.md');

function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, name.name);
    if (name.isDirectory()) walk(p, out);
    else if (name.name.endsWith('.js')) out.push(p);
  }
  return out;
}

const isCall = (n, name) => n && n.type === 'CallExpression' && n.callee.type === 'Identifier' && n.callee.name === name;

function scan(file) {
  const rel = path.relative(root, file).split(path.sep).join('/');
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split('\n');
  const ast = espree.parse(text, { ecmaVersion: 'latest', sourceType: 'module', loc: true, range: true });
  const flags = [];
  const hooks = [];
  const note = (line) => {
    // only a comment at the end of the same line: a comment above may be about something else
    const same = /\S.*?\s\/\/\s*(.+)$/.exec(lines[line - 1] || '');
    return same ? same[1].trim().slice(0, 140) : '';
  };
  const add = (list, name, node) => list.push({ name, file: rel, line: node.loc.start.line, note: note(node.loc.start.line) });
  const fnStack = [];
  const aliases = []; // { name, fn }

  (function visit(node, parent) {
    if (!node || typeof node.type !== 'string') return;
    const isFn = /Function/.test(node.type);
    if (isFn) fnStack.push(node);
    if (node.type === 'VariableDeclarator' && isCall(node.init, 'debugFlags')) {
      if (node.id.type === 'Identifier') aliases.push({ name: node.id.name, fn: fnStack[fnStack.length - 1] || ast });
      else if (node.id.type === 'ObjectPattern') for (const p of node.id.properties) if (p.key && p.key.name) add(flags, p.key.name, p);
    }
    if (node.type === 'MemberExpression' && !node.computed && isCall(node.object, 'debugFlags')) add(flags, node.property.name, node);
    if (isCall(node, 'hook') || isCall(node, 'setHook')) {
      const a = node.arguments[0];
      if (a && a.type === 'Literal' && typeof a.value === 'string') add(hooks, a.value, node);
    }
    for (const key of Object.keys(node)) {
      const v = node[key];
      if (key === 'loc' || key === 'range') continue;
      if (Array.isArray(v)) v.forEach((c) => visit(c, node));
      else if (v && typeof v.type === 'string') visit(v, node);
    }
    if (isFn) fnStack.pop();
  })(ast, null);

  // reads through an alias, inside the function the alias was made in
  (function visitAliases(node) {
    if (!node || typeof node.type !== 'string') return;
    if (node.type === 'MemberExpression' && !node.computed && node.object.type === 'Identifier') {
      for (const a of aliases) {
        if (node.object.name === a.name && node.range[0] >= a.fn.range[0] && node.range[1] <= a.fn.range[1]) add(flags, node.property.name, node);
      }
    }
    for (const key of Object.keys(node)) {
      const v = node[key];
      if (key === 'loc' || key === 'range') continue;
      if (Array.isArray(v)) v.forEach(visitAliases);
      else if (v && typeof v.type === 'string') visitAliases(v);
    }
  })(ast);
  return { flags, hooks };
}

function group(list) {
  const by = new Map();
  for (const x of list) {
    if (!by.has(x.name)) by.set(x.name, { name: x.name, where: [], note: '' });
    const e = by.get(x.name);
    const where = `${x.file}:${x.line}`;
    if (!e.where.includes(where) && e.where.length < 3) e.where.push(where);
    if (!e.note && x.note) e.note = x.note;
  }
  return [...by.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function kind(name, hook) {
  if (hook) return /Dump$|Stats$|Result$|Probe$|Diag|Metrics$/.test(name) ? 'callback: receives a stage\'s result' : /^no|^force|Override$|^use/.test(name) ? 'override' : 'harness value';
  if (/^no[A-Z]/.test(name)) return 'turns a stage off';
  if (/^(print|log|dump|cmp)/.test(name)) return 'prints or dumps';
  return 'tuning value';
}

const all = { flags: [], hooks: [] };
for (const f of walk(path.join(root, 'app/js'))) {
  const r = scan(f);
  all.flags.push(...r.flags);
  all.hooks.push(...r.hooks);
}
const flags = group(all.flags);
const hooks = group(all.hooks);
const row = (e, hook) => `| \`${e.name}\` | ${kind(e.name, hook)} | ${e.where.join(', ')} | ${e.note.replace(/\|/g, '\\|')} |`;
const doc = `# Debug switches and test hooks

Generated by \`node scripts/debug-flags.mjs\` from the code (\`npm test\` fails when this file is out of date). Nothing here is set by the app itself: a test harness or the browser
console sets them. See \`app/js/core/debugflags.js\` for how.

## Switches (\`globalThis.__lytro.<name>\`)

Read with \`debugFlags().name\`. In the worker, a harness usually prepends a line to \`worker.js\` that sets \`globalThis.__lytro = { ... }\`.

| Name | Kind | Read at | Comment in the code |
|---|---|---|---|
${flags.map((e) => row(e, false)).join('\n')}

## Hooks (\`globalThis.__<name>\`)

Read with \`hook('name')\`, published with \`setHook('name', value)\`.

| Name | Kind | Used at | Comment in the code |
|---|---|---|---|
${hooks.map((e) => row(e, true)).join('\n')}
`;

if (process.argv.includes('--check')) {
  const have = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
  if (have !== doc) {
    console.error('docs/debug-flags.md is out of date: run node scripts/debug-flags.mjs');
    process.exit(1);
  }
} else {
  fs.writeFileSync(OUT, doc);
  console.log(`${flags.length} switches and ${hooks.length} hooks written to docs/debug-flags.md`);
}
