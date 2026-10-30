#!/usr/bin/env node
// Quire migration: turn a Scrivener external sync folder (Gale House layout) or any beat-novel
// folder into a Quire repo, or start a new empty one.
//
//   node scripts/migrate.mjs "<sync folder>" <output folder> [--title "Gale House"]
//   node scripts/migrate.mjs --new "My Novel" <output folder>
//
// Never modifies the source folder. Verifies the result by re-reading it.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as F from '../public/format.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = n => { const i = args.indexOf(n); if (i < 0) return null; const v = args[i + 1]; args.splice(i, 2); return v; };
const isNew = args.includes('--new') ? (args.splice(args.indexOf('--new'), 1), true) : false;
const title = flag('--title');
if (args.length < 2) {
  console.error('Usage:\n  node scripts/migrate.mjs "<source folder>" <output folder> [--title "Title"]\n  node scripts/migrate.mjs --new "Title" <output folder>');
  process.exit(1);
}
const [src, out] = args;

export function readTree(dir, exts = /\.(md|txt|json)$/i) {
  const tree = {};
  const walk = rel => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.name.startsWith('.') && !['.github', '.quire'].includes(e.name)) continue;
      if (e.isDirectory()) { if (!['node_modules', 'Backups', '.git'].includes(e.name)) walk(r); }
      else if (exts.test(e.name)) tree[r] = fs.readFileSync(path.join(dir, r), 'utf8');
    }
  };
  walk('');
  return tree;
}

function writeTree(dir, tree) {
  for (const [p, t] of Object.entries(tree)) {
    const f = path.join(dir, p);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, t);
  }
}

if (fs.existsSync(out) && fs.readdirSync(out).filter(n => n !== '.git').length) {
  console.error(`Output folder ${out} is not empty. Choose a new folder.`); process.exit(1);
}

let project;
if (isNew) project = { title: src, beats: [], board: F.emptyBoard(), files: { 'notes/Characters.md': '' } };
else {
  const tree = readTree(src);
  project = F.importTree(tree, { title: title || path.basename(path.resolve(src)).replace(/ Sync.*$/, '') });
  if (title) project.title = title;
}

const tree = F.exportTree(project);
// Repo extras: README, compile workflow and the compile tool.
const tpl = path.join(here, '..', 'template');
const extra = readTree(tpl, /\.(md|txt|json|yml|mjs)$/i);
extra['.quire/format.js'] = fs.readFileSync(path.join(here, '..', 'public', 'format.js'), 'utf8');
for (const [p, t] of Object.entries(extra)) if (!tree[p]) tree[p] = t.replaceAll('{{TITLE}}', project.title);
fs.mkdirSync(out, { recursive: true });
writeTree(out, tree);

// Verify: re-read the output and compare every beat field.
const back = F.importTree(readTree(out));
const byId = new Map(back.beats.map(b => [b.id, b]));
let problems = 0;
for (const b of project.beats) {
  const c = byId.get(b.id);
  for (const f of F.FIELDS) if (!c || (c[f] ?? '') !== (b[f] ?? '')) { problems++; console.error(`  mismatch: ${b.title} (${f})`); break; }
}
const live = project.beats.filter(b => !b.deleted).length;
console.log(`Quire repo written to ${out}
  title:          ${project.title}
  source layout:  ${isNew ? 'new' : project.layout}
  beats:          ${live} live, ${project.beats.length - live} retired
  other files:    ${Object.keys(project.files).length}
  verification:   ${problems ? problems + ' problem(s)' : 'every beat round-trips exactly'}`);
process.exit(problems ? 2 : 0);
