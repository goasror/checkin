import test from 'node:test';
import assert from 'node:assert/strict';
import { handle } from '../netlify/functions/api.mjs';

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
  const startAs = async (hostCall, title) => {
    await hostCall('POST', '/api/host/start', { title });
    const s = await (await hostCall('GET', '/api/host/state')).json();
    return { ...s, code: `${s.sessionId}.${s.token}` };
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
  return { call, hostA: as(KEY_A), hostB: as(KEY_B), startAs, checkin, clock, report };
}

test('host endpoints need a well-formed key, any key works', async () => {
  const { call, hostA } = setup();
  assert.equal((await call('GET', '/api/host/state')).status, 401);
  assert.equal((await call('GET', '/api/host/state', null, { 'x-host-key': 'short' })).status, 401);
  assert.equal((await hostA('GET', '/api/host/state')).status, 200); // no sign-up needed
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
  clock.t += 8000; // 11 s in: the code was replaced 1 s ago, a scan in flight still lands
  assert.equal((await checkin('Alan Turing', s.code)).status, 200);
  clock.t += 3000; // 14 s in: replaced 4 s ago, past the grace period
  const late = await checkin('Grace Hopper', s.code);
  assert.equal(late.status, 410);
  assert.equal((await late.json()).error, 'expired');
  clock.t += 25000; // a screenshot from half a minute ago
  assert.equal((await checkin('Grace Hopper', s.code)).status, 410);
});

test('nothing is remembered: each check-in brings its own name and photo', async () => {
  const { hostA, startAs, checkin, clock } = setup();
  const s = await startAs(hostA);
  // one phone passed around: three different people, no accounts or enrollment involved
  for (const name of ['Ada Lovelace', 'Alan Turing', 'Grace Hopper']) {
    assert.equal((await checkin(name, s.code)).status, 200);
    clock.t += 1000;
  }
  const state = await (await hostA('GET', '/api/host/state')).json();
  assert.equal(state.count, 3);
  assert.deepEqual(state.latest.map((p) => p.name), ['Grace Hopper', 'Alan Turing', 'Ada Lovelace']);
  assert.ok(state.latest.every((p) => p.photo && !p.dup));
});

test('the same name twice is flagged, not blocked, and counted once', async () => {
  const { hostA, startAs, checkin, clock } = setup();
  const s = await startAs(hostA);
  const first = await (await checkin('John Smith', s.code)).json();
  clock.t += 1000;
  const second = await (await checkin('  john   SMITH ', s.code)).json();
  assert.equal(first.dup, false);
  assert.equal(second.dup, true);
  const state = await (await hostA('GET', '/api/host/state')).json();
  assert.equal(state.count, 1); // one person...
  assert.equal(state.latest.length, 2); // ...two check-ins to compare
  assert.equal(state.latest[0].dup, true);
  const again = await (await hostA('GET', `/api/host/state?have=${state.latest[0].id}`)).json();
  assert.equal(again.latest[0].photo, undefined); // the host already holds this photo
});

test('hosts run side by side: lists, codes and downloads stay separate', async () => {
  const { hostA, hostB, startAs, checkin } = setup();
  const a = await startAs(hostA, 'Hall A');
  const b = await startAs(hostB, 'Hall B');
  assert.notEqual(a.sessionId, b.sessionId);
  assert.equal((await checkin('Ada Lovelace', a.code)).status, 200);
  assert.equal((await checkin('Alan Turing', b.code)).status, 200);
  assert.equal((await checkin('Alan Turing', `${b.sessionId}.${a.token}`)).status, 410); // A's token is useless in B

  const stateA = await (await hostA('GET', '/api/host/state')).json();
  const stateB = await (await hostB('GET', '/api/host/state')).json();
  assert.deepEqual(stateA.latest.map((p) => p.name), ['Ada Lovelace']);
  assert.deepEqual(stateB.latest.map((p) => p.name), ['Alan Turing']);

  const endedB = await (await hostB('POST', '/api/host/end')).json();
  assert.equal((await hostA('GET', `/api/host/report?s=${endedB.sessionId}`)).status, 404); // not A's session
  assert.equal((await hostB('GET', `/api/host/report?s=${endedB.sessionId}`)).status, 200);
  assert.equal((await (await hostA('GET', '/api/host/state')).json()).active, true); // A is unaffected
});

test('ending a session closes it and the report data has every check-in with its photo', async () => {
  const { call, hostA, startAs, checkin, report, clock } = setup();
  const s = await startAs(hostA, 'Физика 101');
  await checkin('Анна Иванова', s.code);
  clock.t += 1000;
  await checkin('Ada Lovelace', s.code);
  clock.t += 1000;
  await checkin('Ada Lovelace', s.code); // duplicate on purpose
  const ended = await (await hostA('POST', '/api/host/end')).json();
  assert.equal(ended.count, 2);
  assert.equal((await (await hostA('GET', '/api/host/state')).json()).active, false);
  assert.equal((await checkin('Alan Turing', s.code)).status, 410); // session over

  const r = await report(hostA, ended.sessionId);
  assert.equal(r.status, 200);
  assert.equal(r.title, 'Физика 101');
  assert.equal(r.count, 2);
  assert.deepEqual(r.entries.map((e) => e.name), ['Анна Иванова', 'Ada Lovelace', 'Ada Lovelace']);
  assert.ok(r.entries.every((e) => e.photo === PHOTO && typeof e.time === 'number'));
  assert.equal((await call('GET', '/api/host/report?s=../../x', null, { 'x-host-key': KEY_A })).status, 400);
});

test('a large session comes back complete, in pages', async () => {
  const { hostA, startAs, checkin, clock, report } = setup();
  const s = await startAs(hostA, 'Big lecture');
  for (let i = 1; i <= 130; i++) {
    await checkin(`Student Number ${i}`, s.code);
    if (i % 3 === 0) clock.t += 1; // several check-ins can share a millisecond
  }
  const ended = await (await hostA('POST', '/api/host/end')).json();
  assert.equal(ended.count, 130);
  const first = await (await hostA('GET', `/api/host/report?s=${ended.sessionId}`)).json();
  assert.equal(first.entries.length, 50);
  assert.ok(first.next);
  const r = await report(hostA, ended.sessionId);
  assert.equal(r.entries.length, 130);
  assert.equal(new Set(r.entries.map((e) => e.id)).size, 130); // no repeats, nothing missing
});

test('sessions that ended more than a week ago are purged when the host starts a new one', async () => {
  const { hostA, hostB, startAs, checkin, clock, report } = setup();
  const old = await startAs(hostA, 'Last month');
  await checkin('Ada Lovelace', old.code);
  const endedOld = await (await hostA('POST', '/api/host/end')).json();
  const other = await startAs(hostB, 'Other host');
  await checkin('Alan Turing', other.code);
  const endedOther = await (await hostB('POST', '/api/host/end')).json();
  clock.t += 2 * 24 * 3600 * 1000;
  await hostA('POST', '/api/host/start', { title: 'Two days later' });
  assert.equal((await report(hostA, endedOld.sessionId)).status, 200); // still kept
  await hostA('POST', '/api/host/end');
  clock.t += 8 * 24 * 3600 * 1000;
  await hostA('POST', '/api/host/start', { title: 'Next week' });
  assert.equal((await report(hostA, endedOld.sessionId)).status, 404); // purged
  assert.equal((await report(hostB, endedOther.sessionId)).entries.length, 1); // other host untouched
});
