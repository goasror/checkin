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

const PHOTO = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==';
const KEY_A = 'A'.repeat(32);
const KEY_B = 'B'.repeat(32);

function setup() {
  const db = { students: new MemStore(), sessions: new MemStore(), checkins: new MemStore() };
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
  const enroll = async (name) => (await (await call('POST', '/api/enroll', { name, photo: PHOTO })).json()).id;
  const startAs = async (hostCall, title) => {
    await hostCall('POST', '/api/host/start', { title });
    const s = await (await hostCall('GET', '/api/host/state')).json();
    return { ...s, code: `${s.sessionId}.${s.token}` };
  };
  return { call, hostA: as(KEY_A), hostB: as(KEY_B), enroll, startAs, clock };
}

test('host endpoints need a well-formed key, any key works', async () => {
  const { call, hostA } = setup();
  assert.equal((await call('GET', '/api/host/state')).status, 401);
  assert.equal((await call('GET', '/api/host/state', null, { 'x-host-key': 'short' })).status, 401);
  assert.equal((await hostA('GET', '/api/host/state')).status, 200); // no sign-up needed
});

test('enrolling validates input and allows the same name for different people', async () => {
  const { call } = setup();
  assert.equal((await call('POST', '/api/enroll', { name: 'A', photo: PHOTO })).status, 400);
  assert.equal((await call('POST', '/api/enroll', { name: 'Ada Lovelace', photo: 'data:text/html;base64,AAAA' })).status, 400);
  assert.equal((await call('POST', '/api/enroll', { name: 'John Smith', photo: PHOTO })).status, 200);
  assert.equal((await call('POST', '/api/enroll', { name: 'John Smith', photo: PHOTO })).status, 200);
});

test('rotating code, one check-in per student, CSV and history for one host', async () => {
  const { call, hostA, enroll, startAs, clock } = setup();
  const id = await enroll('Ada Lovelace');
  const id2 = await enroll('=cmd|calc');
  const s = await startAs(hostA, 'Physics 101');
  assert.equal(s.count, 0);

  assert.equal((await call('POST', '/api/checkin', { id, code: `${s.sessionId}.bogus` })).status, 410);
  assert.equal((await call('POST', '/api/checkin', { id: 'unknown', code: s.code })).status, 404);
  assert.equal((await call('POST', '/api/checkin', { id, code: 'nope.nope' })).status, 410);

  clock.t += 3000;
  const first = await (await call('POST', '/api/checkin', { id, code: s.code })).json();
  assert.equal(first.already, false);
  clock.t += 4000; // still within the current + previous window
  const again = await (await call('POST', '/api/checkin', { id, code: s.code })).json();
  assert.equal(again.already, true);
  assert.equal(again.time, first.time);

  clock.t += 20000; // that code is now two windows old
  assert.equal((await call('POST', '/api/checkin', { id: id2, code: s.code })).status, 410);
  const s2 = await startAs(hostA);
  assert.equal(s2.sessionId, s.sessionId); // starting again returns the live session
  assert.equal((await call('POST', '/api/checkin', { id: id2, code: s2.code })).status, 200);

  let state = await (await hostA('GET', '/api/host/state')).json();
  assert.equal(state.count, 2);
  assert.equal(state.title, 'Physics 101');
  assert.equal(state.latest[0].name, '=cmd|calc'); // newest first
  assert.ok(state.latest[0].photo);
  state = await (await hostA('GET', `/api/host/state?have=${id2}`)).json();
  assert.equal(state.latest[0].photo, undefined); // client already holds this photo

  const ended = await (await hostA('POST', '/api/host/end')).json();
  assert.equal(ended.count, 2);
  assert.equal((await (await hostA('GET', '/api/host/state')).json()).active, false);
  assert.equal((await call('POST', '/api/checkin', { id, code: s2.code })).status, 410); // session over

  const csv = await hostA('GET', `/api/host/csv?s=${ended.sessionId}&tz=Europe/Berlin`);
  assert.match(csv.headers.get('content-disposition'), /attendance-2026-10-26-Physics-101\.csv/);
  const text = await csv.text();
  assert.match(text, /"Ada Lovelace","2026-10-26 10:00:03"/); // 09:00 UTC = 10:00 Berlin (CET, DST ended 25 Oct)
  assert.match(text, /"'=cmd\|calc"/); // formula neutralised

  const hist = await (await hostA('GET', '/api/host/sessions')).json();
  assert.equal(hist.sessions.length, 1);
  assert.equal(hist.sessions[0].count, 2);
});

test('hosts run side by side: lists, codes and downloads stay separate', async () => {
  const { call, hostA, hostB, enroll, startAs } = setup();
  const ada = await enroll('Ada Lovelace');
  const alan = await enroll('Alan Turing');
  const a = await startAs(hostA, 'Hall A');
  const b = await startAs(hostB, 'Hall B');
  assert.notEqual(a.sessionId, b.sessionId);

  assert.equal((await call('POST', '/api/checkin', { id: ada, code: a.code })).status, 200);
  assert.equal((await call('POST', '/api/checkin', { id: alan, code: b.code })).status, 200);
  // Hall A's token does not unlock Hall B's session.
  assert.equal((await call('POST', '/api/checkin', { id: alan, code: `${b.sessionId}.${a.token}` })).status, 410);

  const stateA = await (await hostA('GET', '/api/host/state')).json();
  const stateB = await (await hostB('GET', '/api/host/state')).json();
  assert.deepEqual(stateA.latest.map((p) => p.name), ['Ada Lovelace']);
  assert.deepEqual(stateB.latest.map((p) => p.name), ['Alan Turing']);

  // Host A cannot end, list or download Host B's session.
  const endedB = await (await hostB('POST', '/api/host/end')).json();
  assert.equal((await hostA('GET', `/api/host/csv?s=${endedB.sessionId}`)).status, 404);
  assert.equal((await (await hostA('GET', '/api/host/sessions')).json()).sessions.length, 0);
  assert.equal((await hostB('GET', `/api/host/csv?s=${endedB.sessionId}`)).status, 200);
  assert.equal((await (await hostA('GET', '/api/host/state')).json()).active, true); // A is unaffected
});

test('two people cannot check in under the same name in one session', async () => {
  const { call, hostA, enroll, startAs } = setup();
  const one = await enroll('John Smith');
  const two = await enroll('  john   SMITH ');
  const s = await startAs(hostA);
  assert.equal((await call('POST', '/api/checkin', { id: one, code: s.code })).status, 200);
  const res = await call('POST', '/api/checkin', { id: two, code: s.code });
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error, 'name_in_use');
  // The first person can still re-scan freely.
  assert.equal((await (await call('POST', '/api/checkin', { id: one, code: s.code })).json()).already, true);
});

test('forget deletes a student', async () => {
  const { call, hostA, enroll, startAs } = setup();
  const id = await enroll('Ada Lovelace');
  const s = await startAs(hostA);
  assert.equal((await call('POST', '/api/forget', { id })).status, 200);
  assert.equal((await call('POST', '/api/checkin', { id, code: s.code })).status, 404);
});
