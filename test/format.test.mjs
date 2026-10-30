import assert from 'node:assert/strict';
import * as F from '../public/format.js';
const cases = [
  'Synopsis: A storm.\n\nClaude adjust:\n\n---\n\nThe wind rose.',
  'Synopsis: A storm.\n\nClaude adjust:\n\nMake it darker.\n\n---\n\nThe wind rose.\n\n=== Notes ===\n\nAuthor\'s notes, 2026-10-01:\n\nhi',
  'Synopsis: \n\nClaude adjust:\n\n---\n\n=== Notes ===\n\nonly notes',
  'Synopsis: x\n\nClaude adjust:\n\n---\n\n',
];
for (const c of cases) assert.equal(F.joinBeat(F.splitBeat(c)), c, c);
assert.equal(F.splitBeat('plain text, no layout').beat, 'plain text, no layout');
// merge
let r = F.merge3('a\nb\nc', 'A\nb\nc', 'a\nb\nC'); assert.deepEqual(r, {text:'A\nb\nC', conflict:false});
r = F.merge3('a\nb\nc', 'X\nb\nc', 'Y\nb\nc'); assert.equal(r.conflict, true);
r = F.merge3('a', 'a\nnew local', 'remote first\na'); assert.equal(r.text, 'remote first\na\nnew local');
// board merge
const base={beats:{a:{x:0,y:0},b:{x:262,y:0}}, acts:[{id:'a1',x:0,name:'One'}]};
const loc={beats:{a:{x:10,y:0},b:{x:262,y:0}}, acts:[{id:'a1',x:0,name:'One'}]};
const rem={beats:{a:{x:0,y:0},b:{x:262,y:240},c:{x:524,y:0}}, acts:[{id:'a1',x:0,name:'Uno'}]};
const m=F.mergeBoard(base,loc,rem); assert.deepEqual(m.beats,{a:{x:10,y:0},b:{x:262,y:240},c:{x:524,y:0}}); assert.equal(m.acts[0].name,'Uno');
// scrivener names
assert.deepEqual(F.parseScrivName('025 The Driftwood [6].txt'), {title:'The Driftwood', sid:'6', deleted:false});
assert.deepEqual(F.parseScrivName('31 TO DELETE - Old bit [12].txt'), {title:'Old bit', sid:'12', deleted:true});
assert.deepEqual(F.parseScrivName('Brand new.txt'), {title:'Brand new', sid:null, deleted:false});
console.log('format tests ok');
