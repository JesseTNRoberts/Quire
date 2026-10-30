// An original sample novel used for the demo and the tests. Not anyone's real manuscript.
export const SAMPLE = {
  title: 'The Keeper’s Ledger',
  acts: [
    { id: 'a1', name: 'Act One', sub: 'The ledger', x: 0 },
    { id: 'a2', name: 'Act Two', sub: 'The storm', x: 1310 },
  ],
  lanes: [
    { id: 'l1', name: 'Mara', color: '#5B7DB1' },
    { id: 'l2', name: 'The island', color: '#8A6BB0' },
  ],
  topics: [{ id: 't1', name: 'Mystery', color: '#C9822B' }, { id: 't2', name: 'Weather', color: '#3E9A7E' }],
  beats: [
    ['Arrival on Skarra', 'Mara takes the relief keeper’s post on a rock nobody else wanted.', 'The ferryman would not come within a cable’s length of the landing.\n\nMara climbed the iron ladder with her bag in her teeth.', 0, 0],
    ['The ledger under the stairs', 'She finds the last keeper’s log, with the final month torn out.', '', 1, 0, ['t1']],
    ['First light check', 'A routine morning on the lamp; the lens is cleaner than it should be.', 'Someone had polished the brass. She had not.', 2, 0, ['t1']],
    ['The island remembers', 'Gannets abandon the north cliff overnight.', '', 1, 1, ['t2']],
    ['Radio silence', 'The mainland stops answering at the scheduled call.', '', 3, 0],
    ['Glass falling', 'The barometer drops faster than Mara has ever seen.', '', 5, 0, ['t2']],
    ['Footprints in the salt', 'Bare prints lead from the tide line to the oil store, and none lead back.', '', 6, 0, ['t1']],
    ['The torn month', 'Mara finds the missing pages pasted inside the oil store door.', '', 7, 0, ['t1'], 'Make the found pages feel physical: smell of paraffin, the glue gone brown.'],
    ['Storm night', 'The lamp fails at the height of the gale and someone else relights it.', '', 6, 1, ['t2']],
    ['The relief boat', 'Morning brings the relief boat, and a keeper who says he never left.', '', 8, 0],
  ],
};

export function sampleProject() {
  const board = { version: 1, textScale: 1, acts: SAMPLE.acts, lanes: SAMPLE.lanes, topics: SAMPLE.topics,
    beats: {}, notes: [{ id: 'n1', x: 560, y: 14, text: 'Keep the keeper’s voice dry.', color: '#F6E7A6' }],
    links: [], days: [{ id: 'd1', x: 0, date: '1931-11-02' }], actNotes: {}, trash: {} };
  const beats = SAMPLE.beats.map(([title, synopsis, beat, col, lane, tags = [], adjust = ''], i) => {
    const id = 'k' + String(i + 1).padStart(3, '0');
    board.beats[id] = { x: 40 + col * 262, y: 120 + lane * 240 + 45, tags };
    return { id, title, synopsis, adjust, beat, notes: '', deleted: false };
  });
  const files = {
    'notes/Characters.md': 'Mara Quell, 34, relief keeper. Practical, sleeps badly.\n\nTomas Reay, the keeper before her.\n',
    'notes/Plot spine.md': '2026-10-28: The second keeper is real. No ghosts.\n',
    'claude/Claude instructions.md': 'Keep the author’s words. Suggestions go in chat, not files.\n',
  };
  return { title: SAMPLE.title, beats, board, files };
}
