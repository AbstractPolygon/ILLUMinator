// Moves one section of app/js/main.js (the parts between the `// ------ name` lines) into its own module under app/js/, as an init function that main.js calls where the
// section used to be, handing it what it uses from the rest of the page. See docs/splitting-main.md.
//
//   node scripts/extract-section.mjs "<section name>" <module path under app/js> <initName> [--dry]
//
// --dry only reports what the section needs and what the rest of the page needs from it. Sections that share a `let` variable with the rest of the page are refused.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as espree from 'espree';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [section, modPath, initName] = process.argv.slice(2);
const dry = process.argv.includes('--dry');
const file = path.join(repo, 'app/js/main.js');
const text = fs.readFileSync(file, 'utf8');
const lines = text.split('\n');
const ast = espree.parse(text, { ecmaVersion: 'latest', sourceType: 'module', loc: true, range: true });
const heads = [];
lines.forEach((l, i) => { if (/^\/\/ -{5,}/.test(l)) heads.push({ line: i + 1, name: l.replace(/^\/\/ -+ ?/, '').trim() }); });
const hi = heads.findIndex((h) => h.name === section);
if (hi < 0) throw new Error('no section ' + section);
const startLine = heads[hi].line; // the header line itself
const endLine = heads[hi + 1] ? heads[hi + 1].line : lines.length + 1; // exclusive
const inSec = (n) => n.loc.start.line >= startLine && n.loc.end.line < endLine;
const topNodes = ast.body;
const secNodes = topNodes.filter(inSec);
// declared names
const namesOf = (n) => {
  const out = [];
  const collect = (p) => { if (!p) return; if (p.type === 'Identifier') out.push(p.name); else if (p.type === 'ObjectPattern') p.properties.forEach((q) => collect(q.value || q.argument)); else if (p.type === 'ArrayPattern') p.elements.forEach(collect); else if (p.type === 'AssignmentPattern') collect(p.left); else if (p.type === 'RestElement') collect(p.argument); };
  if (n.type === 'FunctionDeclaration' || n.type === 'ClassDeclaration') out.push(n.id.name);
  if (n.type === 'VariableDeclaration') n.declarations.forEach((d) => collect(d.id));
  return out;
};
const kindOf = new Map(); // name -> { kind, node, section }
const secOf = (line) => { let s = null; for (const h of heads) if (h.line <= line) s = h; else break; return s ? s.name : '(top)'; };
for (const n of topNodes) {
  for (const nm of namesOf(n)) {
    let kind = 'value';
    if (n.type === 'FunctionDeclaration') kind = 'function';
    else if (n.type === 'ClassDeclaration') kind = 'class';
    else if (n.type === 'ImportDeclaration') kind = 'import';
    else if (n.type === 'VariableDeclaration') {
      const d = n.declarations.find((x) => namesOf({ type: 'VariableDeclaration', declarations: [x] }).includes(nm));
      const fnInit = d && d.init && (d.init.type === 'ArrowFunctionExpression' || d.init.type === 'FunctionExpression');
      kind = n.kind === 'let' ? 'let' : fnInit ? 'function' : 'value';
    }
    kindOf.set(nm, { kind, section: n.type === 'ImportDeclaration' ? '(import)' : secOf(n.loc.start.line), line: n.loc.start.line });
  }
}
for (const n of topNodes.filter((x) => x.type === 'ImportDeclaration')) for (const s of n.specifiers) kindOf.set(s.local.name, { kind: 'import', section: '(import)', node: n, line: n.loc.start.line, imported: s });
const declaredHere = new Set(secNodes.flatMap(namesOf));
// references
const refsIn = (nodes) => { const set = new Set(); (function walk(node, parent) { if (!node || typeof node.type !== 'string') return; if (node.type === 'Identifier') { const isProp = parent && ((parent.type === 'MemberExpression' && parent.property === node && !parent.computed) || (parent.type === 'Property' && parent.key === node && !parent.computed && !parent.shorthand) || (parent.type === 'MethodDefinition' && parent.key === node)); if (!isProp) set.add(node.name); } for (const k of Object.keys(node)) { if (k === 'loc' || k === 'range') continue; const v = node[k]; if (Array.isArray(v)) v.forEach((c) => walk(c, node)); else if (v && typeof v.type === 'string') walk(v, node); } })({ type: 'Program', body: nodes }, null); return set; };
const used = refsIn(secNodes);
const deps = []; const imports = new Map(); const problems = [];
for (const nm of used) {
  const info = kindOf.get(nm);
  if (!info || declaredHere.has(nm)) continue;
  if (info.kind === 'import') { imports.set(nm, info); continue; }
  if (info.section === section) continue;
  deps.push({ name: nm, ...info });
}
// names declared here and used elsewhere
const restNodes = topNodes.filter((n) => !inSec(n) && n.type !== 'ImportDeclaration');
const usedElsewhere = refsIn(restNodes);
const exportsOut = [...declaredHere].filter((nm) => usedElsewhere.has(nm));
for (const d of deps) if (d.kind === 'let') problems.push(`mutable let dependency: ${d.name} (${d.section})`);
const mutableExports = exportsOut.filter((nm) => kindOf.get(nm).kind === 'let');
for (const nm of mutableExports) problems.push(`mutable let used elsewhere: ${nm}`);
console.log(`section "${section}" lines ${startLine}-${endLine - 1}`);
console.log('deps:', deps.map((d) => `${d.name}[${d.kind},${d.section}]`).join(' ') || '-');
console.log('exports:', exportsOut.join(' ') || '-');
console.log('imports needed:', [...imports.keys()].join(' ') || '-');
if (problems.length) console.log('PROBLEMS:', problems.join('; '));
if (dry || problems.length) process.exit(problems.length ? 2 : 0);
// ---- write the module
const bodyLines = lines.slice(startLine - 1, endLine - 1);
const indent = (s) => (s.length ? '  ' + s : s);
const headerComment = []; // keep the section's first comment lines
const importLines = new Map();
for (const [nm, info] of imports) {
  const n = info.node; const src = n.source.value.replace(/^\.\//, '../');
  if (!importLines.has(src)) importLines.set(src, []);
  const s = info.imported; importLines.get(src).push(s.type === 'ImportDefaultSpecifier' ? { def: nm } : s.type === 'ImportNamespaceSpecifier' ? { ns: nm } : { name: s.imported.name, local: nm });
}
const importText = [...importLines].map(([src, list]) => {
  const named = list.filter((x) => x.name).map((x) => (x.name === x.local ? x.name : `${x.name} as ${x.local}`));
  const def = list.find((x) => x.def); const ns = list.find((x) => x.ns);
  const parts = []; if (def) parts.push(def.def); if (ns) parts.push(`* as ${ns.ns}`); if (named.length) parts.push(`{ ${named.join(', ')} }`);
  return `import ${parts.join(', ')} from '${src}';`;
}).join('\n');
const depNames = deps.map((d) => d.name);
const out = `${importText}${importText ? '\n\n' : ''}export function ${initName}({ ${depNames.join(', ')} }) {\n${bodyLines.slice(1).map(indent).join('\n').replace(/\n+$/, '')}\n${exportsOut.length ? `  return { ${exportsOut.join(', ')} };\n` : ''}}\n`;
const target = path.join(repo, 'app/js', modPath);
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, `// ${heads[hi].name}: moved out of main.js. ${initName}() runs where the section used to, with what it uses from the rest of the page.\n` + out);
// ---- replace in main.js
const wrap = (d) => (d.kind === 'function' ? `${d.name}: (...a) => ${d.name}(...a)` : d.name);
const call = `${exportsOut.length ? `const { ${exportsOut.join(', ')} } = ` : ''}${initName}({ ${deps.map(wrap).join(', ')} });`;
const newLines = [...lines.slice(0, startLine - 1), `// ${heads[hi].name}: ${modPath}`, call, '', ...lines.slice(endLine - 1)];
let result = newLines.join('\n');
const modRel = './' + modPath;
result = result.replace(/(import \{ releaseHighlights \}[^\n]*\n)/, `$1import { ${initName} } from '${modRel}';\n`);
fs.writeFileSync(file, result);
console.log('written', target);
