// Editor live preview, version history + restore, backup banner, and starting offline.
// Runs against `wrangler dev` with a seeded book. BROWSER=webkit to test Safari's engine.
const assert = require('node:assert/strict');
const pw = require('playwright');
const engine = process.env.BROWSER === 'webkit' ? pw.webkit : pw.chromium;
const BASE = process.env.BASE || 'http://127.0.0.1:8787', BOOK = process.env.BOOK || 'keeper';
const ok = m => console.log('  ✓ ' + m);
(async () => {
  const b = await engine.launch(); const errs = [];
  const ctx = await b.newContext({ viewport: { width: 1280, height: 860 } });
  await ctx.addInitScript(([book]) => { if (!localStorage.getItem('quire-book')) { localStorage.setItem('quire-book', JSON.stringify(book)); localStorage.setItem('quire-view', '"book"'); } }, [BOOK]);
  const p = await ctx.newPage(); p.on('pageerror', e => errs.push(e.message));
  await p.goto(BASE + '/'); await p.waitForSelector('.beatrow');
  const q = f => `#editor .qed[data-field=${f}]`;
  const val = f => p.evaluate(s => document.querySelector(s)._q.value, q(f));

  // A. live preview editor
  const title = await p.locator('.beatrow .t').first().evaluate(t => t.childNodes[0].textContent.trim());
  const second = await p.locator('.beatrow .t').nth(1).evaluate(t => t.childNodes[0].textContent.trim());
  await p.locator('.beatrow').first().click(); await p.waitForSelector(q('beat') + ' .cm-content');
  await p.click('[data-tab=notes]'); await p.click(q('notes') + ' .cm-content'); await p.keyboard.press('Control+End');
  await p.keyboard.type('\nE2E: the lamp was relit. See [[' + second.slice(0, 5));
  await p.waitForSelector('#ac:not([hidden]) button'); await p.keyboard.press('Enter');
  await p.evaluate(s => { const e = document.querySelector(s)._q, v = e.value, i = v.lastIndexOf('the lamp was relit'); e.view.dispatch({ selection: { anchor: i, head: i + 18 } }); }, q('notes'));
  await p.click('#mkCrit'); await p.keyboard.press('Control+End'); await p.keyboard.type(' Done.'); await p.waitForTimeout(200);
  const v = await val('notes');
  assert.ok(v.includes('==the lamp was relit==') && v.includes(`[[${second}]]`), 'markup stored');
  const shown = await p.$eval(q('notes') + ' .cm-content', el => [...el.querySelectorAll('.cm-line')].map(l => l.innerText).join('\n'));
  assert.ok(shown.includes(`the lamp was relit. See ${second}`) && !shown.includes('[[') && !shown.includes('=='), 'markup hidden away from the cursor');
  ok('live preview: markup stored, hidden when rendered');

  // B. history and restore
  await p.waitForFunction(() => quire.book.pending() === 0, null, { timeout: 10000 });
  await p.click('#edMore'); await p.click('#sheet [data-a=history]');
  await p.waitForSelector('#sheet .hist [data-id]');
  const rows = await p.$$eval('#sheet .hist [data-id]', r => r.map(x => x.innerText));
  assert.ok(rows.length >= 2, 'at least a "before" and a current version: ' + rows.join(' / '));
  await p.locator('#sheet .hist [data-id]').last().click();
  await p.waitForSelector('#hRestore'); await p.click('#hRestore'); await p.click('#hRestore');
  await p.waitForTimeout(800);
  assert.ok(!(await val('notes')).includes('E2E:'), 'restored to the earliest version');
  await p.waitForFunction(() => quire.book.pending() === 0, null, { timeout: 10000 });
  await p.click('#edMore'); await p.click('#sheet [data-a=history]'); await p.waitForSelector('#sheet .hist [data-id]');
  assert.ok((await p.$$('#sheet .hist [data-id]')).length >= rows.length + 1, 'restore added a version; the replaced one is kept');
  await p.locator('#sheet .hist [data-id]').nth(1).click(); await p.waitForSelector('#hRestore'); await p.click('#hRestore'); await p.click('#hRestore');
  await p.waitForTimeout(800);
  await p.waitForTimeout(400); const fwd = await val('notes'); assert.ok(fwd.includes('E2E: ==the lamp was relit=='), 'can go forward again: ' + JSON.stringify(fwd.slice(-80)));
  ok('history: list, restore, and undo the restore');

  // C. backup banner
  await p.evaluate(() => { quire.book.meta.dirtySince = Date.now() - 3 * 3600e3; quire.renderBanner(); });
  assert.match(await p.textContent('#banner'), /No GitHub backup for 3 hours/);
  await p.evaluate(() => { quire.book.meta.dirtySince = null; quire.book.meta.tokenExpires = Date.now() + 5 * 864e5; quire.renderBanner(); });
  assert.match(await p.textContent('#banner'), /expires in [45] days/);
  await p.click('#bnX'); assert.ok(await p.$eval('#banner', e => e.hidden));
  ok('banner: stale backup and expiring key warnings, dismissible');

  // D. start offline, write, reconnect
  await p.click('#edBack');
  await p.evaluate(() => navigator.serviceWorker?.ready);
  await p.reload(); await p.waitForSelector('.beatrow'); await p.waitForTimeout(500);
  await ctx.setOffline(true);
  await p.reload(); await p.waitForSelector('.beatrow', { timeout: 15000 });
  ok('app opens with no connection');
  await p.locator('.beatrow').first().click(); await p.waitForSelector(q('beat') + ' .cm-content');
  await p.evaluate(s => { const e = document.querySelector(s)._q; e.focus(); e.setValue(e.value + '\nWritten offline.', (e.value + '\nWritten offline.').length); }, q('beat'));
  await p.waitForTimeout(1800);
  assert.match(await p.textContent('#status'), /Offline · 1 waiting/);
  await p.reload(); await p.waitForSelector('.beatrow', { timeout: 15000 });
  assert.match(await p.textContent('#status'), /waiting/);
  ok('offline edit survives a reload while still offline');
  await ctx.setOffline(false); await p.evaluate(() => dispatchEvent(new Event('online')));
  await p.waitForFunction(() => quire.book.pending() === 0, null, { timeout: 20000 });
  const server = await (await fetch(`${BASE}/api/book/${BOOK}/state?since=0`)).json();
  assert.ok(server.beats.some(x => x.title === title && x.beat.includes('Written offline.')), 'offline edit reached the server');
  ok('back online: the offline edit synced');

  const real = errs.filter(e => !/INTERNET_DISCONNECTED|Failed to fetch|Load failed|NetworkError|network connection/i.test(e));
  assert.deepEqual(real, [], 'no page errors');
  console.log(`features e2e ok (${process.env.BROWSER || 'chromium'})`);
  await b.close();
})().catch(e => { console.error(e); process.exit(1); });
