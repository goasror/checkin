import test from 'node:test';
import assert from 'node:assert/strict';
import { handle, cleanup } from '../netlify/functions/api.mjs';

// Minimal in-memory stand-in for a Netlify Blobs store.
class MemStore {
  constructor() { this.m = new Map(); }
  async get(key, opts) {
    if (!this.m.has(key)) return null;
    const v = this.m.get(key);
    return opts?.type === 'json' ? JSON.parse(v) : v;
  }
  async set(key, value, opts) {
    if (opts?.onlyIfNew && this.m.has(key)) return { modified: false };
    this.m.set(key, String(value));
    return { modified: true };
  }
  async setJSON(key, data, opts) { return this.set(key, JSON.stringify(data), opts); }
  async delete(key) { this.m.delete(key); }
  async list({ prefix = '' } = {}) {
    return { blobs: [...this.m.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })), directories: [] };
  }
}

// A real (tiny) JPEG.
const JPEG_B64 =
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAAAP/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';
const PHOTO = `data:image/jpeg;base64,${JPEG_B64}`;
const KEY_A = 'A'.repeat(32);
const KEY_B = 'B'.repeat(32);

function setup() {
  const db = { sessions: new MemStore(), checkins: new MemStore() };
  const clock = { t: Date.UTC(2026, 9, 26, 9, 0, 0) };
  const call = (method, path, body, headers = {}) =>
    handle(
      new Request(`https://example.test${path}`, {
        method,
        headers: { 'content-type': 'application/json', ...headers },
        body: body ? JSON.stringify(body) : undefined,
      }),
      { db, now: () => clock.t },
    );
  const as = (key) => (method, path, body) => call(method, path, body, { 'x-host-key': key });
  const state = async (hostCall, sid, after = '') =>
    (await hostCall('GET', `/api/host/state?s=${sid}&after=${after}`)).json();
  const end = async (hostCall, sid) => (await hostCall('POST', '/api/host/end', { sessionId: sid })).json();
  // what a host page does: start a session, then ask for its state
  const startAs = async (hostCall, title) => {
    const { sessionId } = await (await hostCall('POST', '/api/host/start', { title })).json();
    const s = await state(hostCall, sessionId);
    return { ...s, code: `${s.sessionId}.${s.tokens[0]}` };
  };
  const checkin = (name, code, photo = PHOTO) => call('POST', '/api/checkin', { name, photo, code });
  const report = async (hostCall, sid) => {
    let all = null;
    let after = '';
    do {
      const res = await hostCall('GET', `/api/host/report?s=${sid}&after=${after}`);
      if (res.status !== 200) return { status: res.status };
      const page = await res.json();
      if (all) all.entries.push(...page.entries);
      else all = { status: 200, ...page };
      after = page.next;
    } while (after);
    return all;
  };
  const runCleanup = () => cleanup({ db, now: () => clock.t });
  return { call, hostA: as(KEY_A), hostB: as(KEY_B), startAs, state, end, checkin, clock, report, runCleanup };
}

test('host endpoints need a well-formed key, any key works', async () => {
  const { call, hostA } = setup();
  assert.equal((await call('POST', '/api/host/start', {})).status, 401);
  assert.equal((await call('POST', '/api/host/start', {}, { 'x-host-key': 'short' })).status, 401);
  assert.equal((await hostA('POST', '/api/host/start', {})).status, 200); // no sign-up needed
  assert.equal((await hostA('GET', '/api/host/state?s=../../x')).status, 400);
});

test('check-in validates name, photo and code', async () => {
  const { hostA, startAs, checkin, clock } = setup();
  const s = await startAs(hostA);
  assert.equal((await checkin('A', s.code)).status, 400);
  assert.equal((await checkin('Ada Lovelace', s.code, 'data:text/html;base64,AAAA')).status, 400);
  assert.equal((await checkin('Ada Lovelace', `${s.sessionId}.bogus`)).status, 410);
  assert.equal((await checkin('Ada Lovelace', 'nope.nope')).status, 410);
  assert.equal((await checkin('Ada Lovelace', 'garbage')).status, 410);
  clock.t += 3000;
  assert.equal((await checkin('Ada Lovelace', s.code)).status, 200); // same window
  clock.t += 3000; // 6 s in: the code was replaced 1 s ago, a scan in flight still lands
  assert.equal((await checkin('Alan Turing', s.code)).status, 200);
  clock.t += 3000; // 9 s in: replaced 4 s ago, past the grace period
  const late = await checkin('Grace Hopper', s.code);
  assert.equal(late.status, 410);
  assert.equal((await late.json()).error, 'expired');
  clock.t += 25000; // a screenshot from half a minute ago
  assert.equal((await checkin('Grace Hopper', s.code)).status, 410);
});

test('the host gets the next codes ahead, but each works only in its own 5 seconds', async () => {
  const { hostA, startAs, state, checkin, clock } = setup();
  const s = await startAs(hostA);
  assert.equal(s.tokens.length, 6);
  assert.equal(new Set(s.tokens).size, 6);
  const code = (i) => `${s.sessionId}.${s.tokens[i]}`;
  assert.equal((await checkin('Ada Lovelace', code(1))).status, 410); // not on screen yet
  clock.t += 5000;
  assert.equal((await checkin('Ada Lovelace', code(1))).status, 200); // its turn
  clock.t += 20000;
  assert.equal((await checkin('Alan Turing', code(5))).status, 200); // the last one, 25 s later
  const again = await state(hostA, s.sessionId);
  assert.equal(again.tokens[0], s.tokens[5]); // the next call carries on from there
});

test('nothing is remembered: each check-in brings its own name and photo', async () => {
  const { hostA, startAs, state, checkin, clock } = setup();
  const s = await startAs(hostA);
  // one phone passed around: three different people, no accounts or enrollment involved
  for (const name of ['Ada Lovelace', 'Alan Turing', 'Grace Hopper']) {
    assert.equal((await checkin(name, s.code)).status, 200);
    clock.t += 1000;
  }
  const st = await state(hostA, s.sessionId);
  assert.equal(st.count, 3);
  assert.deepEqual(st.entries.map((p) => p.name), ['Ada Lovelace', 'Alan Turing', 'Grace Hopper']);
  assert.ok(st.entries.every((p) => p.photo && !p.dup));
});

test('the same name twice is flagged, not blocked, and counted once', async () => {
  const { hostA, startAs, state, checkin, clock } = setup();
  const s = await startAs(hostA);
  const first = await (await checkin('John Smith', s.code)).json();
  clock.t += 1000;
  const second = await (await checkin('  john   SMITH ', s.code)).json();
  assert.equal(first.dup, false);
  assert.equal(second.dup, true);
  const st = await state(hostA, s.sessionId);
  assert.equal(st.count, 1); // one person...
  assert.equal(st.entries.length, 2); // ...two check-ins to compare
  assert.equal(st.entries[1].dup, true);
  const [a, b] = st.entries;
  const newer = await state(hostA, s.sessionId, a.id);
  assert.deepEqual(newer.entries.map((p) => p.id), [b.id]); // only what the host does not hold yet
  assert.deepEqual((await state(hostA, s.sessionId, b.id)).entries, []);
});

test('many sessions run at once, even from one host: lists, codes and downloads stay separate', async () => {
  const { hostA, hostB, startAs, state, end, checkin, report } = setup();
  const a1 = await startAs(hostA, 'Hall A');
  const a2 = await startAs(hostA, 'Hall A2'); // a second host page in the same browser
  const b = await startAs(hostB, 'Hall B');
  assert.equal(new Set([a1.sessionId, a2.sessionId, b.sessionId]).size, 3);
  assert.equal((await checkin('Ada Lovelace', a1.code)).status, 200);
  assert.equal((await checkin('Grace Hopper', a2.code)).status, 200);
  assert.equal((await checkin('Alan Turing', b.code)).status, 200);
  assert.equal((await checkin('Alan Turing', `${b.sessionId}.${a1.tokens[0]}`)).status, 410); // A's token is useless in B

  assert.deepEqual((await state(hostA, a1.sessionId)).entries.map((p) => p.name), ['Ada Lovelace']);
  assert.deepEqual((await state(hostA, a2.sessionId)).entries.map((p) => p.name), ['Grace Hopper']);
  assert.deepEqual((await state(hostB, b.sessionId)).entries.map((p) => p.name), ['Alan Turing']);
  assert.equal((await state(hostA, b.sessionId)).active, false); // A cannot see B's session

  assert.equal((await hostA('POST', '/api/host/end', { sessionId: b.sessionId })).status, 404); // nor end it
  const endedB = await end(hostB, b.sessionId);
  assert.equal((await report(hostA, endedB.sessionId)).status, 404); // not A's session
  assert.equal((await report(hostB, endedB.sessionId)).status, 200);
  await end(hostA, a1.sessionId);
  assert.equal((await state(hostA, a2.sessionId)).active, true); // ending one leaves the others running
});

test('a session ends only when the host ends it', async () => {
  const { hostA, startAs, state, end, checkin, clock } = setup();
  const s = await startAs(hostA, 'Long lecture');
  clock.t += 5 * 3600 * 1000;
  const later = await state(hostA, s.sessionId);
  assert.equal(later.active, true); // still running hours later
  assert.equal((await checkin('Ada Lovelace', `${s.sessionId}.${later.tokens[0]}`)).status, 200);
  await end(hostA, s.sessionId);
  assert.equal((await hostA('POST', '/api/host/end', { sessionId: s.sessionId })).status, 409); // already ended
});

test('ending a session closes it and the report data has every check-in with its photo', async () => {
  const { call, hostA, startAs, state, end, checkin, report, clock } = setup();
  const s = await startAs(hostA, 'Физика 101');
  await checkin('Анна Иванова', s.code);
  clock.t += 1000;
  await checkin('Ada Lovelace', s.code);
  clock.t += 1000;
  await checkin('Ada Lovelace', s.code); // duplicate on purpose
  const ended = await end(hostA, s.sessionId);
  assert.equal(ended.count, 2);
  assert.equal((await state(hostA, s.sessionId)).active, false);
  assert.equal((await checkin('Alan Turing', s.code)).status, 410); // session over

  const r = await report(hostA, ended.sessionId);
  assert.equal(r.status, 200);
  assert.equal(r.title, 'Физика 101');
  assert.equal(r.count, 2);
  assert.deepEqual(r.entries.map((e) => e.name), ['Анна Иванова', 'Ada Lovelace', 'Ada Lovelace']);
  assert.ok(r.entries.every((e) => e.photo === PHOTO && typeof e.time === 'number'));
  assert.equal((await call('GET', '/api/host/report?s=../../x', null, { 'x-host-key': KEY_A })).status, 400);
});

test('once the host has the PDF, the session and its photos are deleted', async () => {
  const { hostA, hostB, startAs, end, checkin, report } = setup();
  const s = await startAs(hostA, 'Delete me');
  await checkin('Ada Lovelace', s.code);
  const del = (host, sessionId) => host('POST', '/api/host/delete', { sessionId });
  assert.equal((await del(hostA, s.sessionId)).status, 409); // still running
  const ended = await end(hostA, s.sessionId);
  assert.equal((await del(hostB, ended.sessionId)).status, 404); // not B's session
  assert.equal((await report(hostA, ended.sessionId)).entries.length, 1);
  assert.equal((await del(hostA, ended.sessionId)).status, 200);
  assert.equal((await report(hostA, ended.sessionId)).status, 404); // gone
  assert.equal((await del(hostA, ended.sessionId)).status, 404);
});

test('a large session comes back complete, in pages', async () => {
  const { hostA, startAs, state, end, checkin, clock, report } = setup();
  const s = await startAs(hostA, 'Big lecture');
  for (let i = 1; i <= 130; i++) {
    await checkin(`Student Number ${i}`, s.code);
    if (i % 3 === 0) clock.t += 1; // several check-ins can share a millisecond
  }
  // a host page reloaded mid-lecture catches up in pages too
  const held = [];
  let more = true;
  while (more) {
    const st = await state(hostA, s.sessionId, held.length ? held[held.length - 1].id : '');
    assert.ok(st.entries.length <= 50);
    held.push(...st.entries);
    more = st.more;
  }
  assert.equal(new Set(held.map((e) => e.id)).size, 130);
  const ended = await end(hostA, s.sessionId);
  assert.equal(ended.count, 130);
  const first = await (await hostA('GET', `/api/host/report?s=${ended.sessionId}`)).json();
  assert.equal(first.entries.length, 50);
  assert.ok(first.next);
  const r = await report(hostA, ended.sessionId);
  assert.equal(r.entries.length, 130);
  assert.equal(new Set(r.entries.map((e) => e.id)).size, 130); // no repeats, nothing missing
});

test('the daily cleanup removes abandoned sessions, for every host', async () => {
  const { hostA, hostB, startAs, end, checkin, clock, report, runCleanup } = setup();
  const HOUR = 3600 * 1000;
  const ended = await startAs(hostA, 'Ended, PDF never made');
  await checkin('Ada Lovelace', ended.code);
  const endedA = await end(hostA, ended.sessionId);
  const left = await startAs(hostB, 'Never ended'); // B closes the tab without tapping End
  await checkin('Alan Turing', left.code);

  clock.t += 12 * HOUR;
  assert.equal(await runCleanup(), 0);
  clock.t += 13 * HOUR;
  assert.equal(await runCleanup(), 1); // B's session started over a day ago and was never ended
  assert.equal((await report(hostB, left.sessionId)).status, 404);
  assert.equal((await report(hostA, endedA.sessionId)).status, 200); // ended: kept a week for its PDF

  clock.t += 7 * 24 * HOUR;
  assert.equal(await runCleanup(), 1);
  assert.equal((await report(hostA, endedA.sessionId)).status, 404);
});
