// Prints the manuscript (beats in book order) as Markdown. Usage: node .quire/compile.mjs [--synopses]
import fs from 'node:fs';
import path from 'node:path';
import { importTree, manuscript } from './format.js';
const root = process.cwd(), tree = {};
const walk = rel => { for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
  const r = rel ? `${rel}/${e.name}` : e.name;
  if (e.isDirectory()) { if (!e.name.startsWith('.')) walk(r); }
  else if (/\.(md|json)$/.test(e.name)) tree[r] = fs.readFileSync(path.join(root, r), 'utf8');
} };
walk('');
process.stdout.write(manuscript(importTree(tree), { include: process.argv.includes('--synopses') ? 'synopsis' : 'beat' }));
