// Drives the app in headless Chromium at phone, tablet and desktop sizes, against `wrangler dev`.
const assert = require('node:assert/strict');
const pw = require('playwright');
const chromium = process.env.BROWSER === 'webkit' ? pw.webkit : pw.chromium;
const BASE = process.argv[2] || process.env.BASE || 'http://127.0.0.1:8787';
const BOOK = process.env.BOOK || 'keeper';
const shots = '/tmp/shots';
const fill = (p, f, v) => p.evaluate(([f, v]) => { const q = document.querySelector(`#editor .qed[data-field=${f}]`)._q; q.focus(); q.setValue(v, v.length); }, [f, v]);
const val = (p, f) => p.evaluate(f => document.querySelector(`#editor .qed[data-field=${f}]`)._q.value, f);
(async () => {
  require('fs').mkdirSync(shots, { recursive: true });
  const b = await chromium.launch();
  const errors = [];
  const mk = async (w, h, mobile) => { const c = await b.newContext({ viewport: { width: w, height: h }, isMobile: mobile && process.env.BROWSER !== 'firefox', hasTouch: mobile, deviceScaleFactor: 2 });
    await c.addInitScript(([bk]) => { localStorage.setItem('quire-book', JSON.stringify(bk)); localStorage.setItem('quire-view', '"book"'); }, [BOOK]); const p = await c.newPage(); p.on('pageerror', e => errors.push(e.message)); p.on('console', m => m.type() === 'error' && errors.push(m.text())); return p; };

  // Phone
  const phone = await mk(390, 844, true);
  await phone.goto(BASE + '/'); await phone.waitForSelector('.beatrow');
  await phone.waitForTimeout(500); await phone.screenshot({ path: `${shots}/phone-book.png` });
  await phone.click('.beatrow >> nth=0'); await phone.waitForSelector('#editor:not([hidden])');
  await fill(phone, 'beat', 'The ferryman would not come close.\n\nTyped on the phone.');
  await phone.waitForTimeout(2500);
  const st = await phone.textContent('#status'); console.log('phone status after typing:', st);
  await phone.screenshot({ path: `${shots}/phone-editor.png` });

  // Desktop sees the phone's edit live, then edits another field of the same beat.
  const desk = await mk(1440, 900, false);
  await desk.goto(BASE + '/'); await desk.waitForSelector('.beatrow');
  await desk.click('.beatrow >> nth=0'); await desk.waitForSelector('#editor:not([hidden])');
  const deskBeat = await val(desk, 'beat');
  assert.ok(deskBeat.includes('Typed on the phone'), 'desktop sees phone edit'); console.log('  ✓ desktop sees phone edit');
  await desk.click('[data-tab=notes]'); await fill(desk, 'notes', 'Note typed on the desktop.');
  await desk.waitForTimeout(2500);
  const phoneNotes = await val(phone, 'notes');
  assert.equal(phoneNotes, 'Note typed on the desktop.'); console.log('  ✓ phone sees desktop note live');
  await desk.screenshot({ path: `${shots}/desktop-split.png` });

  // Concurrent edits to the same field: phone offline edits line 1, desktop edits line 3 -> clean merge.
  await phone.context().setOffline(true);
  await fill(phone, 'beat', 'The ferryman would NOT come close.\n\nTyped on the phone.');
  await phone.waitForTimeout(1800);
  assert.match(await phone.textContent('#status'), /Offline/); console.log('  ✓ phone shows offline');
  await desk.click('[data-tab=beat]');
  await fill(desk, 'beat', 'The ferryman would not come close.\n\nTyped on the phone. And the desk.');
  await desk.waitForTimeout(2000);
  await phone.context().setOffline(false);
  await phone.evaluate(() => dispatchEvent(new Event('online')));
  await phone.waitForTimeout(4000);
  const merged = await val(phone, 'beat');
  assert.equal(merged, 'The ferryman would NOT come close.\n\nTyped on the phone. And the desk.'); console.log('  ✓ simultaneous edits merged');
  await desk.waitForTimeout(1500);
  assert.equal(await val(desk, 'beat'), merged); console.log('  ✓ desktop matches');

  // Board on desktop
  await desk.click('[data-view=board]'); await desk.waitForSelector('.card'); await desk.waitForTimeout(300);
  await desk.screenshot({ path: `${shots}/desktop-board.png` });
  await desk.keyboard.press('Escape');
  await desk.click('[data-view=settings]'); await desk.waitForTimeout(300);
  await desk.screenshot({ path: `${shots}/desktop-settings.png`, fullPage: true });

  // Tablet
  const tab = await mk(1024, 1366, true);
  await tab.goto(BASE + '/'); await tab.waitForSelector('.beatrow');
  await tab.click('[data-view=book]'); await tab.click('.beatrow >> nth=1'); await tab.waitForTimeout(400);
  await tab.screenshot({ path: `${shots}/tablet-split.png` });
  await tab.click('[data-view=board]'); await tab.waitForTimeout(400);
  await tab.screenshot({ path: `${shots}/tablet-board.png` });
  // Phone board
  await phone.click('#edBack'); await phone.click('[data-view=board]'); await phone.waitForTimeout(400);
  await phone.screenshot({ path: `${shots}/phone-board.png` });
  const real = errors.filter(e => !/INTERNET_DISCONNECTED|Failed to fetch|Load failed|NetworkError|network connection/i.test(e));
  assert.deepEqual(real, []);
  console.log(`sync e2e ok (${process.env.BROWSER || 'chromium'})`);
  await b.close();
})().catch(e => { console.error(e); process.exit(1); });
