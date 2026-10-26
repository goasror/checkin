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

const PASS = 'letmein';
const PHOTO = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==';

function setup() {
  const db = { students: new MemStore(), names: new MemStore(), sessions: new MemStore(), checkins: new MemStore() };
  const clock = { t: Date.UTC(2026, 9, 26, 9, 0, 0) };
  const call = (method, path, body, headers = {}) =>
    handle(
      new Request(`https://example.test${path}`, {
        method,
        headers: { 'content-type': 'application/json', ...headers },
        body: body ? JSON.stringify(body) : undefined,
      }),
      { db, now: () => clock.t, passcode: PASS },
    );
  const host = (method, path, body) => call(method, path, body, { 'x-host-passcode': PASS });
  return { call, host, clock };
}

test('host endpoints need the passcode', async () => {
  const { call } = setup();
  assert.equal((await call('GET', '/api/host/state')).status, 401);
  assert.equal((await call('GET', '/api/host/state', null, { 'x-host-passcode': 'nope' })).status, 401);
});

test('enrolling needs an active session, rejects duplicate names and bad photos', async () => {
  const { call, host } = setup();
  assert.equal((await call('POST', '/api/enroll', { name: 'Ada Lovelace', photo: PHOTO })).status, 409);
  await host('POST', '/api/host/start');
  assert.equal((await call('POST', '/api/enroll', { name: 'A', photo: PHOTO })).status, 400);
  assert.equal((await call('POST', '/api/enroll', { name: 'Ada Lovelace', photo: 'data:text/html;base64,AAAA' })).status, 400);
  const ok = await call('POST', '/api/enroll', { name: 'Ada Lovelace', photo: PHOTO });
  assert.equal(ok.status, 200);
  const dup = await call('POST', '/api/enroll', { name: '  ada   LOVELACE ', photo: PHOTO });
  assert.equal(dup.status, 409);
  assert.equal((await dup.json()).error, 'name_taken');
});

test('full flow: rotating code, one check-in per student, CSV, history', async () => {
  const { call, host, clock } = setup();
  await host('POST', '/api/host/start');
  const { id } = await (await call('POST', '/api/enroll', { name: 'Ada Lovelace', photo: PHOTO })).json();
  const { id: id2 } = await (await call('POST', '/api/enroll', { name: '=cmd|calc', photo: PHOTO })).json();

  let state = await (await host('GET', '/api/host/state')).json();
  assert.equal(state.active, true);
  assert.equal(state.count, 0);
  assert.equal(state.enrolled, 2);
  const code = `${state.sessionId}.${state.token}`;

  // wrong code
  assert.equal((await call('POST', '/api/checkin', { id, code: `${state.sessionId}.bogus` })).status, 410);
  assert.equal((await call('POST', '/api/checkin', { id: 'unknown', code })).status, 404);

  // valid, then again (idempotent)
  clock.t += 3000;
  const first = await (await call('POST', '/api/checkin', { id, code })).json();
  assert.equal(first.name, 'Ada Lovelace');
  assert.equal(first.already, false);
  clock.t += 4000; // still inside current + previous window
  const again = await (await call('POST', '/api/checkin', { id, code })).json();
  assert.equal(again.already, true);
  assert.equal(again.time, first.time);

  // code from two windows ago is rejected
  clock.t += 20000;
  assert.equal((await call('POST', '/api/checkin', { id: id2, code })).status, 410);
  state = await (await host('GET', '/api/host/state')).json();
  assert.equal((await call('POST', '/api/checkin', { id: id2, code: `${state.sessionId}.${state.token}` })).status, 200);

  state = await (await host('GET', '/api/host/state')).json();
  assert.equal(state.count, 2);
  assert.equal(state.latest[0].name, '=cmd|calc'); // newest first
  assert.ok(state.latest[0].photo);
  const again2 = await (await host('GET', `/api/host/state?have=${id2}`)).json();
  assert.equal(again2.latest[0].photo, undefined); // client already has this photo

  // end + csv + history
  const ended = await (await host('POST', '/api/host/end')).json();
  assert.equal(ended.count, 2);
  assert.equal((await (await host('GET', '/api/host/state')).json()).active, false);
  assert.equal((await call('POST', '/api/checkin', { id, code })).status, 409);

  const csv = await host('GET', `/api/host/csv?s=${ended.sessionId}&tz=Europe/Berlin`);
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-disposition'), /attendance-2026-10-26\.csv/);
  const text = await csv.text();
  assert.match(text, /"Ada Lovelace","2026-10-26 10:00:03"/); // 09:00 UTC = 10:00 Berlin (CET, DST ended 25 Oct)
  assert.match(text, /"'=cmd\|calc"/); // formula neutralised

  const hist = await (await host('GET', '/api/host/sessions')).json();
  assert.equal(hist.sessions.length, 1);
  assert.equal(hist.sessions[0].count, 2);
});

test('unenroll lets a student enroll again', async () => {
  const { call, host } = setup();
  await host('POST', '/api/host/start');
  await call('POST', '/api/enroll', { name: 'Ada Lovelace', photo: PHOTO });
  assert.equal((await host('POST', '/api/host/unenroll', { name: 'ada lovelace' })).status, 200);
  assert.equal((await call('POST', '/api/enroll', { name: 'Ada Lovelace', photo: PHOTO })).status, 200);
  assert.equal((await host('POST', '/api/host/unenroll', { name: 'Nobody Here' })).status, 404);
});

test('wipe deletes students and names, and needs confirmation', async () => {
  const { call, host } = setup();
  await host('POST', '/api/host/start');
  await call('POST', '/api/enroll', { name: 'Ada Lovelace', photo: PHOTO });
  await call('POST', '/api/enroll', { name: 'Alan Turing', photo: PHOTO });
  assert.equal((await host('POST', '/api/host/wipe', { confirm: 'nope' })).status, 400);
  const res = await host('POST', '/api/host/wipe', { confirm: 'DELETE' });
  assert.equal((await res.json()).removed, 2);
  assert.equal((await call('POST', '/api/enroll', { name: 'Ada Lovelace', photo: PHOTO })).status, 200);
});
