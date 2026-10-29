// Lecture check-in API (Netlify Functions v2 + Netlify Blobs).
//
// Nothing about a student is remembered. Every check-in carries a name, a fresh selfie and the
// code from the host's screen, so the host gets a new name + face + time each time.
//
// Anyone can host. A host is just a random key kept in their browser (sent as x-host-key); the
// server only stores a hash of it. Every session has its own secret, so many hosts can run sessions
// at the same time, and a student only appears in the list of the host whose QR they scanned.
//
// Student:  POST /api/checkin  { name, photo, code }  -> { name, time, dup }
// Host (x-host-key header):
//           POST /api/host/start { title? }      -> starts (or returns) this host's live session
//           GET  /api/host/state?have=<ids>      -> count, latest check-ins, current QR token
//           POST /api/host/end
//           GET  /api/host/report?s=<id>&after=<entry>  -> report data in pages of 50: name, time, photo
//
// The PDF itself is drawn by the host's browser (public/report.js) from this data, with the same
// photos the host already sees on screen. The server never builds files.

import { createHmac, createHash, randomBytes } from 'node:crypto';

const WINDOW_MS = 10_000; // QR rotation
const GRACE_MS = 3_000; // how long the previous code still works after a rotation
const MAX_NAME = 80;
const MAX_TITLE = 60;
const MAX_PHOTO = 40_000; // characters of the base64 data URL
const LATEST = 12;
const KEEP_MS = 7 * 24 * 3600 * 1000; // how long ended sessions (and their photos) are kept
const REPORT_PAGE = 50; // check-ins per report response, keeps each response well under 6 MB

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
  const h = (v) => createHash('sha256').update(String(v)).digest();
  return h(given).equals(h(expected));
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
  const uniqueCount = async (sid) => (await db.checkins.list({ prefix: `${sid}/n/` })).blobs.length;

  // ---- student endpoint ---------------------------------------------------

  if (route === 'checkin' && method === 'POST') {
    const body = await readJson(req);
    const name = normName(String(body.name ?? ''));
    const photo = String(body.photo ?? '');
    if (name.length < 2 || name.length > MAX_NAME) return fail(400, 'bad_name');
    if (!/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(photo) || photo.length > MAX_PHOTO) {
      return fail(400, 'bad_photo');
    }
    const code = String(body.code ?? '');
    const dot = code.lastIndexOf('.');
    const sid = code.slice(0, dot);
    const token = code.slice(dot + 1);
    if (dot < 1 || !/^[A-Za-z0-9-]{1,40}$/.test(sid)) return fail(410, 'wrong_session');
    const session = await getSession(sid);
    if (!session) return fail(410, 'wrong_session');
    if (session.endedAt) return fail(410, 'ended');
    const win = Math.floor(t / WINDOW_MS);
    // The current code is valid. The previous one is honoured only for a short grace period after a
    // rotation (a scan that was in flight), so a code is good for 10 s plus GRACE_MS, not 20 s.
    const current = tokenOk(token, tokenFor(session.secret, win));
    const justRotated = tokenOk(token, tokenFor(session.secret, win - 1)) && t % WINDOW_MS < GRACE_MS;
    if (!current && !justRotated) return fail(410, 'expired');

    // Every check-in is kept, with its own photo. A second check-in under the same name is flagged
    // (not blocked), so the host can compare the faces and decide.
    const first = await db.checkins.set(`${sid}/n/${nameKey(name)}`, String(t), { onlyIfNew: true });
    const entry = `${String(t).padStart(13, '0')}-${randomBytes(4).toString('hex')}`;
    const dup = !first.modified;
    await db.checkins.setJSON(`${sid}/at/${entry}`, { name, photo, time: t, dup });
    return json({ name, time: t, dup });
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

  // Remove a session, its check-ins and its history entry (hidden first, record last).
  const removeSession = async (sid) => {
    await db.sessions.delete(`h/${hostId}/${sid}`);
    const { blobs } = await db.checkins.list({ prefix: `${sid}/` });
    await Promise.all(blobs.map((b) => db.checkins.delete(b.key)));
    await db.sessions.delete(`sess/${sid}`);
    return blobs.length;
  };

  if (action === 'start' && method === 'POST') {
    // Photos are not kept forever: this host's sessions that ended more than a week ago are removed.
    const old = await db.sessions.list({ prefix: `h/${hostId}/` });
    for (const b of old.blobs) {
      const sid = b.key.slice(`h/${hostId}/`.length);
      const prev = await getSession(sid);
      if (!prev || (prev.endedAt && t - prev.endedAt > KEEP_MS)) await removeSession(sid);
    }
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
    const atPrefix = `${session.id}/at/`;
    const [count, at] = await Promise.all([uniqueCount(session.id), db.checkins.list({ prefix: atPrefix })]);
    const keys = at.blobs.map((b) => b.key).sort().slice(-LATEST).reverse();
    const latest = (
      await Promise.all(
        keys.map(async (k) => {
          const e = await db.checkins.get(k, { type: 'json' });
          if (!e) return null;
          const id = k.slice(atPrefix.length);
          return { id, name: e.name, time: e.time, dup: !!e.dup, photo: have.has(id) ? undefined : e.photo };
        }),
      )
    ).filter(Boolean);
    const win = Math.floor(t / WINDOW_MS);
    return json({
      active: true,
      sessionId: session.id,
      title: session.title,
      startedAt: session.startedAt,
      count,
      latest,
      token: tokenFor(session.secret, win),
      msLeft: WINDOW_MS - (t % WINDOW_MS),
    });
  }

  if (action === 'end' && method === 'POST') {
    const session = await activeSession();
    if (!session) return fail(409, 'no_session');
    const done = { ...session, endedAt: t, count: await uniqueCount(session.id) };
    await db.sessions.setJSON(`sess/${session.id}`, done);
    await db.sessions.delete(`active/${hostId}`);
    return json({ sessionId: done.id, title: done.title, startedAt: done.startedAt, endedAt: done.endedAt, count: done.count });
  }

  if (action === 'report' && method === 'GET') {
    const sid = url.searchParams.get('s') ?? '';
    if (!/^[A-Za-z0-9-]{1,40}$/.test(sid)) return fail(400, 'bad_session');
    const session = await getSession(sid);
    if (!session || session.hostId !== hostId) return fail(404, 'no_such_session'); // only the host who ran it
    const after = url.searchParams.get('after') ?? '';
    const prefix = `${sid}/at/`;
    const { blobs } = await db.checkins.list({ prefix });
    const ids = blobs.map((b) => b.key.slice(prefix.length)).sort().filter((id) => id > after);
    const pageIds = ids.slice(0, REPORT_PAGE);
    const entries = (
      await Promise.all(
        pageIds.map(async (id) => {
          const e = await db.checkins.get(prefix + id, { type: 'json' });
          return e && { id, name: e.name, time: e.time, photo: e.photo };
        }),
      )
    ).filter(Boolean);
    return json({
      title: session.title,
      startedAt: session.startedAt,
      endedAt: session.endedAt,
      count: await uniqueCount(sid),
      entries,
      next: ids.length > REPORT_PAGE ? pageIds[pageIds.length - 1] : null,
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
  realDb = { sessions: open('sessions'), checkins: open('checkins') };
  return realDb;
}

export default async (req) => handle(req, { db: await realStores() });

export const config = { path: '/api/*' };
