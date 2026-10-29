// Lecture check-in API (Netlify Functions v2 + Netlify Blobs).
//
// Nothing about a student is remembered. Every check-in carries a name, a fresh selfie and the
// code from the host's screen, so the host gets a new name + face + time each time.
//
// Anyone can host. A host is just a random key kept in their browser (sent as x-host-key); the
// server only stores a hash of it. Every session has its own secret, so any number of sessions can run
// at the same time (each host page starts its own), and a student only appears in the list of the
// session whose QR they scanned.
//
// Student:  POST /api/checkin  { name, photo, code }  -> { name, time, dup }
// Host (x-host-key header):
//           POST /api/host/start { title? }      -> starts a new session
//           GET  /api/host/state?s=<id>&after=<entry> -> count, check-ins newer than <entry> (oldest
//                                                   first, up to 50), the next 6 QR tokens
//           POST /api/host/end { sessionId }
//           GET  /api/host/report?s=<id>&after=<entry>  -> report data in pages of 50: name, time, photo
//           POST /api/host/delete { sessionId }  -> removes an ended session and its photos (PDF is made)
//
// The PDF itself is drawn by the host's browser (public/report.js) from this data, with the same
// photos the host already sees on screen. The server never builds files.

import { createHmac, createHash, randomBytes } from 'node:crypto';

const WINDOW_MS = 5_000; // QR rotation
const GRACE_MS = 3_000; // how long the previous code still works after a rotation
const TOKENS_AHEAD = 6; // codes sent to the host per call (30 s), so it rotates the QR itself
const MAX_NAME = 80;
const MAX_TITLE = 60;
const MAX_PHOTO = 40_000; // characters of the base64 data URL
const KEEP_MS = 7 * 24 * 3600 * 1000; // how long an ended session whose PDF was never made is kept
// Sessions end only when the host taps End. One that never was (its tab was closed) is deleted by the
// daily cleanup this long after it started; no lecture runs that long.
const ABANDONED_MS = 24 * 3600 * 1000;
const REPORT_PAGE = 50; // check-ins per state/report response, keeps each response well under 6 MB

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

// One listing gives both the number of distinct names (n/) and the sorted check-in ids (at/).
// A check-in id starts with its zero-padded time, so sorting the ids sorts by time.
async function listSession(db, sid) {
  const { blobs } = await db.checkins.list({ prefix: `${sid}/` });
  let count = 0;
  const at = [];
  for (const { key } of blobs) {
    if (key.startsWith(`${sid}/n/`)) count++;
    else if (key.startsWith(`${sid}/at/`)) at.push(key.slice(`${sid}/at/`.length));
  }
  return { count, at: at.sort() };
}

const readEntries = async (db, sid, ids) =>
  (
    await Promise.all(
      ids.map(async (id) => {
        const e = await db.checkins.get(`${sid}/at/${id}`, { type: 'json' });
        return e && { id, name: e.name, time: e.time, dup: !!e.dup, photo: e.photo };
      }),
    )
  ).filter(Boolean);

// Remove a session, its check-ins and the pointers to it. The record goes last, so a cleanup that is
// cut short leaves the record behind and the next run finishes the job.
async function removeSession(db, s) {
  // pointers written by earlier versions (one live session per host, session history)
  const active = await db.sessions.get(`active/${s.hostId}`, { type: 'json' });
  if (active?.id === s.id) await db.sessions.delete(`active/${s.hostId}`);
  await db.sessions.delete(`h/${s.hostId}/${s.id}`);
  const { blobs } = await db.checkins.list({ prefix: `${s.id}/` });
  await Promise.all(blobs.map((b) => db.checkins.delete(b.key)));
  await db.sessions.delete(`sess/${s.id}`);
}

// Photos are not kept forever. Runs daily (netlify/functions/cleanup.mjs) over every host's sessions
// and removes those that ended more than KEEP_MS ago without a PDF being made, and those never ended
// that started more than ABANDONED_MS ago (the host closed the tab instead of tapping End).
export async function cleanup({ db, now = Date.now }) {
  const t = now();
  const { blobs } = await db.sessions.list({ prefix: 'sess/' });
  let removed = 0;
  for (const { key } of blobs) { // one session at a time, to stay clear of rate limits
    const s = await db.sessions.get(key, { type: 'json' });
    if (!s) continue;
    const old = s.endedAt ? t - s.endedAt > KEEP_MS : t - s.startedAt > ABANDONED_MS;
    if (!old) continue;
    await removeSession(db, s);
    removed++;
  }
  return removed;
}

// ---------------------------------------------------------------------------

export async function handle(req, { db, now = Date.now } = {}) {
  const url = new URL(req.url);
  const route = url.pathname.replace(/^\/api\/?/, '').replace(/\/$/, '');
  const method = req.method;
  const t = now();

  const getSession = (sid) => db.sessions.get(`sess/${sid}`, { type: 'json' });

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
    // rotation (a scan that was in flight), so a code is good for 5 s plus GRACE_MS, not 10 s.
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

  // Sessions are addressed by id, and a host can run any number at once (one per host page). Only
  // the host who started a session can see or change it: its id is in the QR, its key is not.
  const ownSession = async (sid) => {
    const s = await getSession(sid);
    return s && s.hostId === hostId ? s : null;
  };
  const validId = (sid) => /^[A-Za-z0-9-]{1,40}$/.test(sid);

  if (action === 'start' && method === 'POST') {
    const body = await readJson(req);
    const title = normName(String(body.title ?? '')).slice(0, MAX_TITLE);
    const id = `${new Date(t).toISOString().slice(0, 10)}-${randomBytes(5).toString('hex')}`;
    const session = { id, hostId, title, secret: randomBytes(24).toString('base64url'), startedAt: t, endedAt: null, count: 0 };
    await db.sessions.setJSON(`sess/${id}`, session);
    return json({ sessionId: id, startedAt: t });
  }

  if (action === 'state' && method === 'GET') {
    const sid = url.searchParams.get('s') ?? '';
    if (!validId(sid)) return fail(400, 'bad_session');
    const session = await ownSession(sid);
    if (!session || session.endedAt) return json({ active: false });
    // `after` is the newest check-in the host page already holds: it gets only newer ones, so each
    // photo travels once and the page ends up with every check-in (for an offline PDF).
    const after = url.searchParams.get('after') ?? '';
    const { count, at } = await listSession(db, session.id);
    const newer = at.filter((id) => id > after);
    const entries = await readEntries(db, session.id, newer.slice(0, REPORT_PAGE));
    const win = Math.floor(t / WINDOW_MS);
    return json({
      active: true,
      sessionId: session.id,
      title: session.title,
      startedAt: session.startedAt,
      count,
      entries,
      more: newer.length > REPORT_PAGE,
      // The current code and the next ones, so the host page can rotate the QR on its own and call
      // only every ~20 s. Only the host gets them, and each still works only in its own 5 s (+ grace).
      tokens: Array.from({ length: TOKENS_AHEAD }, (_, i) => tokenFor(session.secret, win + i)),
      msLeft: WINDOW_MS - (t % WINDOW_MS), // until tokens[0] is replaced by tokens[1]
    });
  }

  if (action === 'end' && method === 'POST') {
    const body = await readJson(req);
    const sid = String(body.sessionId ?? '');
    if (!validId(sid)) return fail(400, 'bad_session');
    const session = await ownSession(sid);
    if (!session) return fail(404, 'no_such_session');
    if (session.endedAt) return fail(409, 'already_ended');
    const done = { ...session, endedAt: t, count: (await listSession(db, session.id)).count };
    await db.sessions.setJSON(`sess/${session.id}`, done);
    return json({ sessionId: done.id, title: done.title, startedAt: done.startedAt, endedAt: done.endedAt, count: done.count });
  }

  if (action === 'delete' && method === 'POST') {
    // The host's browser has made the PDF: nothing about the session is kept any longer.
    const body = await readJson(req);
    const sid = String(body.sessionId ?? '');
    if (!validId(sid)) return fail(400, 'bad_session');
    const session = await ownSession(sid);
    if (!session) return fail(404, 'no_such_session');
    if (!session.endedAt) return fail(409, 'not_ended');
    await removeSession(db, session);
    return json({ deleted: true });
  }

  if (action === 'report' && method === 'GET') {
    const sid = url.searchParams.get('s') ?? '';
    if (!validId(sid)) return fail(400, 'bad_session');
    const session = await ownSession(sid);
    if (!session) return fail(404, 'no_such_session');
    const after = url.searchParams.get('after') ?? '';
    const { count, at } = await listSession(db, sid);
    const ids = at.filter((id) => id > after);
    const pageIds = ids.slice(0, REPORT_PAGE);
    const entries = await readEntries(db, sid, pageIds);
    return json({
      title: session.title,
      startedAt: session.startedAt,
      endedAt: session.endedAt,
      count,
      entries,
      next: ids.length > REPORT_PAGE ? pageIds[pageIds.length - 1] : null,
    });
  }

  return fail(404, 'not_found');
}

// ---------------------------------------------------------------------------

let realDb;
export async function realStores() {
  if (realDb) return realDb;
  const { getStore } = await import('@netlify/blobs');
  const open = (name) => getStore({ name, consistency: 'strong' });
  realDb = { sessions: open('sessions'), checkins: open('checkins') };
  return realDb;
}

export default async (req) => handle(req, { db: await realStores() });

export const config = { path: '/api/*' };
