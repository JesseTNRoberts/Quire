import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import assert from 'node:assert/strict';
execFileSync('node', ['test/make-fixture.mjs', '/tmp/q-fix']);
fs.rmSync('/tmp/q-out', { recursive: true, force: true });
const out = execFileSync('node', ['scripts/migrate.mjs', '/tmp/q-fix', '/tmp/q-out', '--title', 'Test']).toString();
assert.match(out, /10 live, 1 retired/); assert.match(out, /round-trips exactly/);
// Migrating the migrated repo again (quire layout) must also round-trip.
fs.rmSync('/tmp/q-out2', { recursive: true, force: true });
const out2 = execFileSync('node', ['scripts/migrate.mjs', '/tmp/q-out', '/tmp/q-out2']).toString();
assert.match(out2, /source layout:  quire/); assert.match(out2, /round-trips exactly/);
console.log('migrate tests ok');
