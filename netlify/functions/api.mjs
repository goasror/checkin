// Lecture check-in API (Netlify Functions v2 + Netlify Blobs).
//
// Student:  POST /api/enroll   { name, photo }      -> { id }
//           POST /api/checkin  { id, code }         -> { name, time, already }
// Host:     (all need the x-host-passcode header)
//           GET  /api/host/state?have=<ids>          -> live session, QR token, latest check-ins
//           POST /api/host/start | /api/host/end
//           GET  /api/host/sessions                  -> finished sessions
//           GET  /api/host/csv?s=<sessionId>&tz=<IANA zone>
//           POST /api/host/unenroll { name }         -> lets a student enroll again
//           POST /api/host/wipe { confirm: "DELETE" } -> deletes every stored name and selfie

import { createHmac, createHash, timingSafeEqual, randomBytes } from 'node:crypto';

const WINDOW_MS = 10_000; // QR code rotation
const MAX_NAME = 80;
const MAX_PHOTO = 40_000; // characters of the base64 data URL
const LATEST = 12;

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers },
  });
const fail = (status, error) => json({ error }, status);

const normName = (s) => s.normalize('NFKC').trim().replace(/\s+/g, ' ');
const nameKey = (s) => encodeURIComponent(normName(s).toLowerCase());

const sha = (s) => createHash('sha256').update(String(s)).digest();
const safeEq = (a, b) => timingSafeEqual(sha(a), sha(b));

const tokenFor = (passcode, sid, win) =>
  createHmac('sha256', `${passcode}:${sid}`).update(String(win)).digest('base64url').slice(0, 12);

const readJson = async (req) => {
  try {
    const body = await req.json();
    return body && typeof body === 'object' ? body : {};
  } catch {
    return {};
  }
};

// ---------------------------------------------------------------------------

export async function handle(req, { db, now = Date.now, passcode = process.env.HOST_PASSCODE } = {}) {
  const url = new URL(req.url);
  const route = url.pathname.replace(/^\/api\/?/, '').replace(/\/$/, '');
  const method = req.method;
  const t = now();

  const activeSession = () => db.sessions.get('active', { type: 'json' });

  const getStudent = async (id) => {
    db.cache ??= new Map();
    if (db.cache.has(id)) return db.cache.get(id);
    const s = await db.students.get(id, { type: 'json' });
    if (s) db.cache.set(id, s);
    return s;
  };

  // ---- student endpoints --------------------------------------------------

  if (route === 'enroll' && method === 'POST') {
    if (!(await activeSession())) return fail(409, 'no_session');
    const body = await readJson(req);
    const name = normName(String(body.name ?? ''));
    const photo = String(body.photo ?? '');
    if (name.length < 2 || name.length > MAX_NAME) return fail(400, 'bad_name');
    if (!/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(photo) || photo.length > MAX_PHOTO) {
      return fail(400, 'bad_photo');
    }
    const id = randomBytes(12).toString('base64url');
    const claimed = await db.names.set(nameKey(name), id, { onlyIfNew: true });
    if (!claimed.modified) return fail(409, 'name_taken');
    await db.students.setJSON(id, { id, name, photo, createdAt: t });
    return json({ id, name });
  }

  if (route === 'checkin' && method === 'POST') {
    const session = await activeSession();
    if (!session) return fail(409, 'no_session');
    const body = await readJson(req);
    const code = String(body.code ?? '');
    const dot = code.lastIndexOf('.');
    const sid = code.slice(0, dot);
    const token = code.slice(dot + 1);
    if (dot < 1 || sid !== session.id) return fail(410, 'wrong_session');
    const win = Math.floor(t / WINDOW_MS);
    const valid = safeEq(token, tokenFor(passcode, sid, win)) || safeEq(token, tokenFor(passcode, sid, win - 1));
    if (!valid) return fail(410, 'expired');
    const id = String(body.id ?? '');
    const student = id ? await getStudent(id) : null;
    if (!student) return fail(404, 'unknown_student');

    const byKey = `${sid}/by/${id}`;
    const first = await db.checkins.set(byKey, String(t), { onlyIfNew: true });
    let time = t;
    if (first.modified) {
      await db.checkins.set(`${sid}/at/${String(t).padStart(13, '0')}-${id}`, '1');
    } else {
      time = Number(await db.checkins.get(byKey)) || t;
    }
    return json({ name: student.name, time, already: !first.modified });
  }

  // ---- host endpoints -------------------------------------------------------

  if (!route.startsWith('host/')) return fail(404, 'not_found');
  if (!passcode) return fail(500, 'host_not_configured');
  if (!safeEq(req.headers.get('x-host-passcode') ?? '', passcode)) return fail(401, 'bad_passcode');
  const action = route.slice(5);

  const startSession = async () => {
    const existing = await activeSession();
    if (existing) return existing;
    const id = `${new Date(t).toISOString().slice(0, 10)}-${randomBytes(3).toString('hex')}`;
    const session = { id, startedAt: t };
    await db.sessions.setJSON(`s/${id}`, { ...session, endedAt: null, count: 0 });
    await db.sessions.setJSON('active', session);
    return session;
  };

  if (action === 'start' && method === 'POST') {
    const s = await startSession();
    return json({ sessionId: s.id, startedAt: s.startedAt });
  }

  if (action === 'state' && method === 'GET') {
    const session = await activeSession();
    if (!session) return json({ active: false });
    const have = new Set((url.searchParams.get('have') ?? '').split(',').filter(Boolean));
    const byPrefix = `${session.id}/by/`;
    const atPrefix = `${session.id}/at/`;
    const [by, at, students] = await Promise.all([
      db.checkins.list({ prefix: byPrefix }),
      db.checkins.list({ prefix: atPrefix }),
      db.students.list(),
    ]);
    const keys = at.blobs.map((b) => b.key).sort().slice(-LATEST).reverse();
    const latest = (
      await Promise.all(
        keys.map(async (k) => {
          const rest = k.slice(atPrefix.length);
          const time = Number(rest.slice(0, 13));
          const id = rest.slice(14);
          const s = await getStudent(id);
          if (!s) return null;
          return { id, name: s.name, time, photo: have.has(id) ? undefined : s.photo };
        }),
      )
    ).filter(Boolean);
    const win = Math.floor(t / WINDOW_MS);
    return json({
      active: true,
      sessionId: session.id,
      startedAt: session.startedAt,
      count: by.blobs.length,
      enrolled: students.blobs.length,
      latest,
      token: tokenFor(passcode, session.id, win),
      msLeft: WINDOW_MS - (t % WINDOW_MS),
    });
  }

  if (action === 'end' && method === 'POST') {
    const session = await activeSession();
    if (!session) return fail(409, 'no_session');
    const by = await db.checkins.list({ prefix: `${session.id}/by/` });
    const done = { ...session, endedAt: t, count: by.blobs.length };
    await db.sessions.setJSON(`s/${session.id}`, done);
    await db.sessions.delete('active');
    return json({ sessionId: done.id, startedAt: done.startedAt, endedAt: done.endedAt, count: done.count });
  }

  if (action === 'sessions' && method === 'GET') {
    const { blobs } = await db.sessions.list({ prefix: 's/' });
    const keys = blobs.map((b) => b.key).sort().slice(-30);
    const all = await Promise.all(keys.map((k) => db.sessions.get(k, { type: 'json' })));
    const sessions = all
      .filter((s) => s && s.endedAt)
      .sort((a, b) => b.startedAt - a.startedAt)
      .map(({ id, startedAt, endedAt, count }) => ({ id, startedAt, endedAt, count }));
    const students = await db.students.list();
    return json({ sessions, enrolled: students.blobs.length });
  }

  if (action === 'csv' && method === 'GET') {
    const sid = url.searchParams.get('s') ?? '';
    if (!/^[A-Za-z0-9-]+$/.test(sid)) return fail(400, 'bad_session');
    const session = await db.sessions.get(`s/${sid}`, { type: 'json' });
    if (!session) return fail(404, 'no_such_session');
    let tz = url.searchParams.get('tz') || 'UTC';
    try {
      new Intl.DateTimeFormat('en', { timeZone: tz });
    } catch {
      tz = 'UTC';
    }
    const local = (ms) => new Date(ms).toLocaleString('sv-SE', { timeZone: tz });
    const prefix = `${sid}/by/`;
    const { blobs } = await db.checkins.list({ prefix });
    const rows = await Promise.all(
      blobs.map(async (b) => {
        const id = b.key.slice(prefix.length);
        const [s, at] = await Promise.all([getStudent(id), db.checkins.get(b.key)]);
        return { name: s?.name ?? '(removed student)', time: Number(at) || 0 };
      }),
    );
    rows.sort((a, b) => a.time - b.time);
    // Quote every field; neutralise spreadsheet formulas in names.
    const cell = (v) => `"${String(/^[=+\-@\t\r]/.test(v) ? `'${v}` : v).replace(/"/g, '""')}"`;
    const lines = [
      ['Name', `Checked in (${tz})`, 'Checked in (UTC)'].map(cell).join(','),
      ...rows.map((r) => [r.name, local(r.time), new Date(r.time).toISOString()].map(cell).join(',')),
    ];
    const day = new Date(session.startedAt).toLocaleDateString('sv-SE', { timeZone: tz });
    return new Response('﻿' + lines.join('\r\n') + '\r\n', {
      status: 200,
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="attendance-${day}.csv"`,
        'cache-control': 'no-store',
      },
    });
  }

  if (action === 'unenroll' && method === 'POST') {
    const body = await readJson(req);
    const name = normName(String(body.name ?? ''));
    if (!name) return fail(400, 'bad_name');
    const key = nameKey(name);
    const id = await db.names.get(key);
    if (!id) return fail(404, 'no_such_student');
    await Promise.all([db.names.delete(key), db.students.delete(id)]);
    db.cache?.delete(id);
    return json({ removed: name });
  }

  if (action === 'wipe' && method === 'POST') {
    const body = await readJson(req);
    if (body.confirm !== 'DELETE') return fail(400, 'confirm_required');
    const [studentKeys, nameKeys] = await Promise.all([db.students.list(), db.names.list()]);
    await Promise.all([
      ...studentKeys.blobs.map((b) => db.students.delete(b.key)),
      ...nameKeys.blobs.map((b) => db.names.delete(b.key)),
    ]);
    db.cache?.clear();
    return json({ removed: studentKeys.blobs.length });
  }

  return fail(404, 'not_found');
}

// ---------------------------------------------------------------------------

let realDb;
async function realStores() {
  if (realDb) return realDb;
  const { getStore } = await import('@netlify/blobs');
  const open = (name) => getStore({ name, consistency: 'strong' });
  realDb = {
    students: open('students'),
    names: open('names'),
    sessions: open('sessions'),
    checkins: open('checkins'),
  };
  return realDb;
}

export default async (req) => handle(req, { db: await realStores() });

export const config = { path: '/api/*' };
