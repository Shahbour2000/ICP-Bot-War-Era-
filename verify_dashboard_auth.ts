/**
 * Verification script for the dashboard's session signing and permission
 * logic (src/dashboard/session.ts, src/dashboard/permissions.ts).
 *
 * Run with: npx ts-node verify_dashboard_auth.ts
 *
 * This exercises the security-critical guarantees directly: a forged or
 * tampered session cookie must never verify, an expired one must never
 * verify, and only Administrator/Manage Server permission bits grant
 * dashboard access. No live Discord connection or database is needed.
 */
import * as crypto from 'crypto';
import { signSession, verifySession, parseCookies } from './src/dashboard/session';
import { hasManageAccess } from './src/dashboard/permissions';

let passed = 0;
let failed = 0;

function assert(label: string, condition: boolean): void {
  if (condition) {
    passed++;
    console.log(`✅ PASS: ${label}`);
  } else {
    failed++;
    console.log(`❌ FAIL: ${label}`);
  }
}

const SECRET = process.env.SESSION_SECRET || '';
if (!SECRET) {
  console.error('Set SESSION_SECRET before running this script, e.g.:\n  SESSION_SECRET=test-secret npx ts-node verify_dashboard_auth.ts');
  process.exit(1);
}

// --- Sign/verify round trip -------------------------------------------
const token = signSession({
  discordId: '123',
  username: 'abu',
  avatar: null,
  guilds: [{ id: 'g1', name: 'Test Guild', permissions: '8' }],
});
const decoded = verifySession(token);
assert('session round trip preserves discordId', decoded?.discordId === '123');
assert('session round trip preserves guild list', decoded?.guilds[0]?.id === 'g1');

// --- Tamper detection ---------------------------------------------------
const tamperedSig = token.slice(0, -1) + (token.slice(-1) === 'A' ? 'B' : 'A');
assert('flipping one signature character is rejected', verifySession(tamperedSig) === null);

const [, realSig] = token.split('.');
const forgedBody = Buffer.from(
  JSON.stringify({
    discordId: '999-attacker',
    username: 'x',
    avatar: null,
    guilds: [{ id: 'guild-attacker-does-not-manage', name: 'x', permissions: '8' }],
    exp: Math.floor(Date.now() / 1000) + 9999,
  })
).toString('base64url');
assert('forged payload reusing an old signature is rejected', verifySession(`${forgedBody}.${realSig}`) === null);

// --- Expiry --------------------------------------------------------------
const expiredBody = Buffer.from(
  JSON.stringify({ discordId: '1', username: 'x', avatar: null, guilds: [], exp: Math.floor(Date.now() / 1000) - 10 })
).toString('base64url');
const expiredSig = crypto.createHmac('sha256', SECRET).update(expiredBody).digest('base64url');
assert('expired session is rejected even with a correct signature', verifySession(`${expiredBody}.${expiredSig}`) === null);

// --- Malformed input never throws ---------------------------------------
assert('missing token returns null, no throw', verifySession(undefined) === null);
assert('garbage token returns null, no throw', verifySession('not-a-real-token') === null);

// --- Cookie parsing -------------------------------------------------------
const cookies = parseCookies('dash_session=abc123; dash_oauth_state=xyz');
assert('cookie parsing splits multiple cookies correctly', cookies['dash_session'] === 'abc123' && cookies['dash_oauth_state'] === 'xyz');
assert('missing cookie header returns empty object, no throw', Object.keys(parseCookies(undefined)).length === 0);

// --- Permission bit checks (the actual access-control decision) ---------
assert('ADMINISTRATOR (0x8) grants access', hasManageAccess('8') === true);
assert('MANAGE_GUILD (0x20) grants access', hasManageAccess('32') === true);
assert('ADMINISTRATOR | MANAGE_GUILD combined still grants access', hasManageAccess(String(0x8 | 0x20)) === true);
assert('SEND_MESSAGES only (2048) does NOT grant access', hasManageAccess('2048') === false);
assert('zero permissions denied', hasManageAccess('0') === false);
assert('empty string denied', hasManageAccess('') === false);
assert('undefined denied', hasManageAccess(undefined) === false);
assert('non-numeric garbage denied, no throw', hasManageAccess('not-a-number') === false);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
