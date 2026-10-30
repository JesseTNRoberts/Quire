// Builds a fake Scrivener external sync folder in the Gale House layout from the sample novel.
import fs from 'node:fs';
import path from 'node:path';
import { joinBeat } from '../public/format.js';
import { sampleProject } from '../public/sample-novel.js';
const dir = process.argv[2];
fs.rmSync(dir, { recursive: true, force: true });
const p = sampleProject();
const w = (f, t) => { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), t); };
const board = { ...p.board, beats: {} };
p.beats.forEach((b, i) => {
  const sid = i + 3;
  const name = i === 9 ? `${b.title}.txt` : `${String(i + 1).padStart(3, '0')} ${b.title} [${sid}].txt`;
  w('Draft/' + name, joinBeat(b));
  board.beats[i === 9 ? `t:${b.title}` : `id:${sid}`] = p.board.beats[b.id];
});
w('Draft/11 TO DELETE - Lighthouse cat [40].txt', joinBeat({ synopsis: 'A cat. Cut.', beat: 'Meow.' }));
board.links = [{ id: 'x1', from: 'id:4', to: 'id:10', label: 'pages' }];
w('gale-house-board.json', JSON.stringify(board, null, 2));
w('Notes/01 Characters [90].txt', p.files['notes/Characters.md']);
w('Notes/02 Plot spine [91].txt', p.files['notes/Plot spine.md']);
w('Claude/Claude instructions.md', p.files['claude/Claude instructions.md']);
w('Claude chats/2026-10-20 storm.md', '# Chat\n\nAbout the storm.');
w('gale-house-digest.md', 'generated'); w('claude-reload.txt', '1'); w('Backups/x.json', '{}');
w('Gale House Storyboard.html', '<html>');
console.log('fixture at', dir);
