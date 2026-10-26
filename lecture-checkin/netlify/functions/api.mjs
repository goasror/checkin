// Lecture check-in API (Netlify Functions v2 + Netlify Blobs).
//
// Anyone can host. A host is just a random key kept in their browser (sent as x-host-key);
// the server only stores a hash of it. Every session has its own secret, so many hosts can run
// sessions at the same time, and a student only appears in the list of the host whose QR they scanned.
//
// Student:  POST /api/enroll   { name, photo }   -> { id, name }
//           POST /api/checkin  { id, code }      -> { name, time, already }
//           POST /api/forget   { id }            -> deletes that student's name and selfie
// Host (x-host-key header):
//           POST /api/host/start { title? }      -> starts (or returns) this host's live session
//           GET  /api/host/state?have=<ids>      -> count, latest check-ins, current QR token
//           POST /api/host/end
//           GET  /api/host/sessions              -> this host's finished sessions
//           GET  /api/host/csv?s=<id>&tz=<zone>  -> attendance file

import { createHmac, createHash, randomBytes } from 'node:crypto';

const WINDOW_MS = 10_000; // QR rotation
const MAX_NAME = 80;
const MAX_TITLE = 60;
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
const hostIdFor = (key) => createHash('sha256').update(`host:${key}`).digest('hex').slice(0, 32);
const tokenFor = (secret, win) => createHmac('sha256', secret).update(String(win)).digest('base64url').slice(0, 12);
const tokenOk = (given, expected) => {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && createHash('sha256').update(a).digest().equals(createHash('sha256').update(b).digest());
};

const readJson = async (req) => {
  try {
    const body = await req.json();
    return body && typeof body === 'object' ? body : {};
  } catch {
    return {};
  }
};

// ---------------------------------------------------------------------------

export async function handle(req, { db, now = Date.now } = {}) {
  const url = new URL(req.url);
  const route = url.pathname.replace(/^\/api\/?/, '').replace(/\/$/, '');
  const method = req.method;
  const t = now();

  const getSession = (sid) => db.sessions.get(`sess/${sid}`, { type: 'json' });

  const getStudent = async (id) => {
    db.cache ??= new Map();
    if (db.cache.has(id)) return db.cache.get(id);
    const s = await db.students.get(id, { type: 'json' });
    if (s) db.cache.set(id, s);
    return s;
  };

  // ---- student endpoints --------------------------------------------------

  if (route === 'enroll' && method === 'POST') {
    const body = await readJson(req);
    const name = normName(String(body.name ?? ''));
    const photo = String(body.photo ?? '');
    if (name.length < 2 || name.length > MAX_NAME) return fail(400, 'bad_name');
    if (!/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(photo) || photo.length > MAX_PHOTO) {
      return fail(400, 'bad_photo');
    }
    const id = randomBytes(12).toString('base64url');
    await db.students.setJSON(id, { id, name, photo, createdAt: t });
    return json({ id, name });
  }

  if (route === 'forget' && method === 'POST') {
    const body = await readJson(req);
    const id = String(body.id ?? '');
    if (id) {
      await db.students.delete(id);
      db.cache?.delete(id);
    }
    return json({ ok: true });
  }

  if (route === 'checkin' && method === 'POST') {
    const body = await readJson(req);
    const code = String(body.code ?? '');
    const dot = code.lastIndexOf('.');
    const sid = code.slice(0, dot);
    const token = code.slice(dot + 1);
    if (dot < 1 || !/^[A-Za-z0-9-]{1,40}$/.test(sid)) return fail(410, 'wrong_session');
    const session = await getSession(sid);
    if (!session) return fail(410, 'wrong_session');
    if (session.endedAt) return fail(410, 'ended');
    const win = Math.floor(t / WINDOW_MS);
    if (!tokenOk(token, tokenFor(session.secret, win)) && !tokenOk(token, tokenFor(session.secret, win - 1))) {
      return fail(410, 'expired');
    }
    const id = String(body.id ?? '');
    const student = id ? await getStudent(id) : null;
    if (!student) return fail(404, 'unknown_student');

    const byKey = `${sid}/by/${id}`;
    const before = await db.checkins.get(byKey);
    if (before) return json({ name: student.name, time: Number(before) || t, already: true });

    // One person per name in a session, so nobody can sit under someone else's name.
    const claim = `${sid}/name/${nameKey(student.name)}`;
    const claimed = await db.checkins.set(claim, id, { onlyIfNew: true });
    if (!claimed.modified && (await db.checkins.get(claim)) !== id) return fail(409, 'name_in_use');

    const first = await db.checkins.set(byKey, String(t), { onlyIfNew: true });
    if (first.modified) {
      await db.checkins.set(`${sid}/at/${String(t).padStart(13, '0')}-${id}`, '1');
      return json({ name: student.name, time: t, already: false });
    }
    return json({ name: student.name, time: Number(await db.checkins.get(byKey)) || t, already: true });
  }

  // ---- host endpoints -------------------------------------------------------

  if (!route.startsWith('host/')) return fail(404, 'not_found');
  const key = req.headers.get('x-host-key') ?? '';
  if (!/^[A-Za-z0-9_-]{32,64}$/.test(key)) return fail(401, 'bad_key');
  const hostId = hostIdFor(key);
  const action = route.slice(5);

  const activeSession = async () => {
    const a = await db.sessions.get(`active/${hostId}`, { type: 'json' });
    const s = a ? await getSession(a.id) : null;
    return s && !s.endedAt ? s : null;
  };

  if (action === 'start' && method === 'POST') {
    const existing = await activeSession();
    if (existing) return json({ sessionId: existing.id, startedAt: existing.startedAt });
    const body = await readJson(req);
    const title = normName(String(body.title ?? '')).slice(0, MAX_TITLE);
    const id = `${new Date(t).toISOString().slice(0, 10)}-${randomBytes(5).toString('hex')}`;
    const session = { id, hostId, title, secret: randomBytes(24).toString('base64url'), startedAt: t, endedAt: null, count: 0 };
    await db.sessions.setJSON(`sess/${id}`, session);
    await db.sessions.set(`h/${hostId}/${id}`, '1');
    await db.sessions.setJSON(`active/${hostId}`, { id });
    return json({ sessionId: id, startedAt: t });
  }

  if (action === 'state' && method === 'GET') {
    const session = await activeSession();
    if (!session) return json({ active: false });
    const have = new Set((url.searchParams.get('have') ?? '').split(',').filter(Boolean));
    const byPrefix = `${session.id}/by/`;
    const atPrefix = `${session.id}/at/`;
    const [by, at] = await Promise.all([db.checkins.list({ prefix: byPrefix }), db.checkins.list({ prefix: atPrefix })]);
    const keys = at.blobs.map((b) => b.key).sort().slice(-LATEST).reverse();
    const latest = (
      await Promise.all(
        keys.map(async (k) => {
          const rest = k.slice(atPrefix.length);
          const id = rest.slice(14);
          const s = await getStudent(id);
          if (!s) return null;
          return { id, name: s.name, time: Number(rest.slice(0, 13)), photo: have.has(id) ? undefined : s.photo };
        }),
      )
    ).filter(Boolean);
    const win = Math.floor(t / WINDOW_MS);
    return json({
      active: true,
      sessionId: session.id,
      title: session.title,
      startedAt: session.startedAt,
      count: by.blobs.length,
      latest,
      token: tokenFor(session.secret, win),
      msLeft: WINDOW_MS - (t % WINDOW_MS),
    });
  }

  if (action === 'end' && method === 'POST') {
    const session = await activeSession();
    if (!session) return fail(409, 'no_session');
    const by = await db.checkins.list({ prefix: `${session.id}/by/` });
    const done = { ...session, endedAt: t, count: by.blobs.length };
    await db.sessions.setJSON(`sess/${session.id}`, done);
    await db.sessions.delete(`active/${hostId}`);
    return json({ sessionId: done.id, title: done.title, startedAt: done.startedAt, endedAt: done.endedAt, count: done.count });
  }

  if (action === 'sessions' && method === 'GET') {
    const prefix = `h/${hostId}/`;
    const { blobs } = await db.sessions.list({ prefix });
    const ids = blobs.map((b) => b.key.slice(prefix.length)).sort().slice(-30);
    const all = await Promise.all(ids.map(getSession));
    const sessions = all
      .filter((s) => s && s.endedAt)
      .sort((a, b) => b.startedAt - a.startedAt)
      .map(({ id, title, startedAt, endedAt, count }) => ({ id, title, startedAt, endedAt, count }));
    return json({ sessions });
  }

  if (action === 'csv' && method === 'GET') {
    const sid = url.searchParams.get('s') ?? '';
    if (!/^[A-Za-z0-9-]{1,40}$/.test(sid)) return fail(400, 'bad_session');
    const session = await getSession(sid);
    if (!session || session.hostId !== hostId) return fail(404, 'no_such_session'); // only the host who ran it
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
        return { name: s?.name ?? '(deleted by student)', time: Number(at) || 0 };
      }),
    );
    rows.sort((a, b) => a.time - b.time);
    // Quote every field; neutralise spreadsheet formulas in names.
    const cell = (v) => `"${String(/^[=+\-@\t\r]/.test(v) ? `'${v}` : v).replace(/"/g, '""')}"`;
    const header = [['Session', session.title || sid], ['Started', local(session.startedAt)]];
    const lines = [
      ...header.map((r) => r.map(cell).join(',')),
      '',
      ['Name', `Checked in (${tz})`, 'Checked in (UTC)'].map(cell).join(','),
      ...rows.map((r) => [r.name, local(r.time), new Date(r.time).toISOString()].map(cell).join(',')),
    ];
    const day = new Date(session.startedAt).toLocaleDateString('sv-SE', { timeZone: tz });
    const slug = (session.title || '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30);
    return new Response('﻿' + lines.join('\r\n') + '\r\n', {
      status: 200,
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="attendance-${day}${slug ? '-' + slug : ''}.csv"`,
        'cache-control': 'no-store',
      },
    });
  }

  return fail(404, 'not_found');
}

// ---------------------------------------------------------------------------

let realDb;
async function realStores() {
  if (realDb) return realDb;
  const { getStore } = await import('@netlify/blobs');
  const open = (name) => getStore({ name, consistency: 'strong' });
  realDb = { students: open('students'), sessions: open('sessions'), checkins: open('checkins') };
  return realDb;
}

export default async (req) => handle(req, { db: await realStores() });

export const config = { path: '/api/*' };
