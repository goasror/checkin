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
//           GET  /api/host/sessions              -> this host's finished sessions
//           GET  /api/host/pdf?s=<id>&tz=<zone>  -> attendance report: photo, name and time

import { createHmac, createHash, randomBytes } from 'node:crypto';
import { PDFDocument, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { REGULAR, BOLD } from './font-data.mjs';

const WINDOW_MS = 10_000; // QR rotation
const GRACE_MS = 3_000; // how long the previous code still works after a rotation
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

  if (action === 'pdf' && method === 'GET') {
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
    const prefix = `${sid}/at/`;
    const { blobs } = await db.checkins.list({ prefix });
    const entries = (
      await Promise.all(blobs.map((b) => b.key).sort().map((k) => db.checkins.get(k, { type: 'json' })))
    ).filter(Boolean);
    const count = await uniqueCount(sid);

    const date = (ms) => new Date(ms).toLocaleString('sv-SE', { timeZone: tz });
    const day = new Date(session.startedAt).toLocaleDateString('sv-SE', { timeZone: tz });
    const slug = (session.title || '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30);
    const pdf = await buildPdf({
      title: session.title || 'Attendance',
      subtitle: `${date(session.startedAt)} (${tz})  ·  ${count} checked in`,
      entries,
      time: (ms) => new Date(ms).toLocaleTimeString('sv-SE', { timeZone: tz }),
    });
    return new Response(pdf, {
      status: 200,
      headers: {
        'content-type': 'application/pdf',
        'content-disposition': `attachment; filename="attendance-${day}${slug ? '-' + slug : ''}.pdf"`,
        'cache-control': 'no-store',
      },
    });
  }

  return fail(404, 'not_found');
}

// ---- PDF report -------------------------------------------------------------
// A4, two columns of cards: photo, name, time. Latin, Cyrillic and Greek names render;
// other scripts show as "?".

async function buildPdf({ title, subtitle, entries, time }) {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const font = await pdf.embedFont(Buffer.from(REGULAR, 'base64'), { subset: true });
  const bold = await pdf.embedFont(Buffer.from(BOLD, 'base64'), { subset: true });
  const known = new Set(font.getCharacterSet());
  const safe = (s) => [...String(s)].map((ch) => (known.has(ch.codePointAt(0)) ? ch : '?')).join('');
  const fit = (text, f, size, maxW) => {
    let s = safe(text);
    if (f.widthOfTextAtSize(s, size) <= maxW) return s;
    while (s.length > 1 && f.widthOfTextAtSize(s + '…', size) > maxW) s = s.slice(0, -1);
    return s + '…';
  };

  const W = 595.28;
  const H = 841.89;
  const M = 40;
  const GAP = 20;
  const COL_W = (W - 2 * M - GAP) / 2;
  const CELL_H = 60;
  const PHOTO = 48;
  const ink = rgb(0.059, 0.09, 0.165);
  const muted = rgb(0.357, 0.392, 0.459);
  const rule = rgb(0.875, 0.89, 0.925);
  const warn = rgb(0.71, 0.27, 0.07);

  const pages = [];
  const newPage = () => {
    const page = pdf.addPage([W, H]);
    pages.push(page);
    let top = H - M;
    if (pages.length === 1) {
      page.drawText(fit(title, bold, 22, W - 2 * M), { x: M, y: top - 22, size: 22, font: bold, color: ink });
      page.drawText(safe(subtitle), { x: M, y: top - 44, size: 11, font, color: muted });
      top -= 62;
    } else {
      page.drawText(fit(title, font, 10, W - 2 * M), { x: M, y: top - 10, size: 10, font, color: muted });
      top -= 22;
    }
    page.drawLine({ start: { x: M, y: top }, end: { x: W - M, y: top }, thickness: 1, color: rule });
    return { page, y: top - 14 };
  };

  // Flag every check-in that shares a name with another one, so both faces can be compared.
  const seen = new Map();
  for (const e of entries) seen.set(nameKey(e.name), (seen.get(nameKey(e.name)) ?? 0) + 1);

  let { page, y } = newPage();
  for (let i = 0; i < entries.length; i++) {
    const col = i % 2;
    if (col === 0 && i > 0) y -= CELL_H;
    if (y - CELL_H < M + 24) ({ page, y } = newPage());
    const e = entries[i];
    const x = M + col * (COL_W + GAP);
    const bottom = y - PHOTO;

    page.drawText(String(i + 1), { x, y: bottom + PHOTO / 2 - 4, size: 9, font, color: muted });
    try {
      const bytes = Buffer.from(e.photo.split(',')[1] ?? '', 'base64');
      const img = await pdf.embedJpg(bytes);
      page.drawImage(img, { x: x + 24, y: bottom, width: PHOTO, height: PHOTO });
    } catch {
      page.drawRectangle({ x: x + 24, y: bottom, width: PHOTO, height: PHOTO, color: rule });
    }
    const tx = x + 24 + PHOTO + 10;
    const maxW = COL_W - 24 - PHOTO - 10;
    page.drawText(fit(e.name, bold, 12.5, maxW), { x: tx, y: bottom + PHOTO - 14, size: 12.5, font: bold, color: ink });
    page.drawText(time(e.time), { x: tx, y: bottom + PHOTO - 30, size: 10.5, font, color: muted });
    if (seen.get(nameKey(e.name)) > 1) {
      page.drawText('Same name used more than once', { x: tx, y: bottom + PHOTO - 43, size: 8, font: bold, color: warn });
    }
  }

  pages.forEach((p, n) => {
    p.drawText(`Page ${n + 1} of ${pages.length}`, { x: W - M - 60, y: M - 12, size: 8.5, font, color: muted });
  });
  pdf.setTitle(safe(title));
  return pdf.save();
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
