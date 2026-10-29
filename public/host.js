(() => {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const screens = [...document.querySelectorAll('main[data-screen]')];
  const KEY = 'ci_host_key';

  const store = (area) => ({
    get: (k) => { try { return area().getItem(k) || ''; } catch { return ''; } },
    set: (k, v) => { try { area().setItem(k, v); } catch { /* private mode */ } },
    remove: (k) => { try { area().removeItem(k); } catch { /* private mode */ } },
  });
  const ls = store(() => localStorage);
  const ss = store(() => sessionStorage); // per tab, survives a reload of that tab

  // ---- host identity: a random key kept in this browser ---------------------

  let hostKey = ls.get(KEY);
  if (!/^[A-Za-z0-9_-]{32,64}$/.test(hostKey)) {
    const bytes = crypto.getRandomValues(new Uint8Array(24));
    hostKey = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    ls.set(KEY, hostKey);
  }

  const WINDOW_MS = 5000; // QR rotation, as in api.mjs
  const LATEST = 12; // check-ins shown in the live list
  // This page's live session. Every visit to /host asks for a name and starts its own, so several
  // can run at once; only a reload of the same tab picks it up again, so a refresh mid-lecture does
  // not lose it. A session ends only when End is tapped.
  const SESSION = 'ci_session';
  let sessionId = '';
  // Each call brings the next 30 s of codes, so the page rotates the QR itself and calls the server only
  // to refresh the list and count: every 5 s while check-ins are coming in (and when a session starts),
  // every 20 s once it has been quiet for BUSY_MS. Fewer function calls, without a slow list in the rush.
  const POLL_FAST_MS = 5000;
  const POLL_SLOW_MS = 20000;
  const BUSY_MS = 30000;
  const LAG_MS = 150; // show a new code a moment after the server switches, never before it

  let pollTimer = 0;
  let pollGen = 0; // bumped to drop the answer of a poll still in flight
  let lastToken = '';
  let codes = []; // [{ token, until }] still to show, `until` on the performance.now() clock
  let codeSession = '';
  let rotateTimer = 0;
  // Every check-in of the live session as it arrives, so a PDF can still be made if the connection
  // drops: { sessionId, title, startedAt, count, entries: [{ id, name, time, dup, photo }] }.
  let local = null;
  let shownIds = null; // ids currently in the list, to skip redrawing when nothing changed
  const lastId = () => (local && local.entries.length ? local.entries[local.entries.length - 1].id : '');
  // Same name rule as the server and the PDF: every check-in under a repeated name is flagged.
  const nameKey = (s) => String(s).normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
  const isDup = (p) => local.names.get(nameKey(p.name)) > 1;

  function show(name) {
    screens.forEach((s) => { s.hidden = s.dataset.screen !== name; });
    document.body.dataset.screen = name;
  }

  // ---- api ------------------------------------------------------------------

  const api = (path, options = {}) =>
    fetch('/api/host/' + path, {
      ...options,
      headers: { ...(options.headers || {}), 'x-host-key': hostKey, 'content-type': 'application/json' },
    });
  const post = (path, body) => api(path, { method: 'POST', body: JSON.stringify(body || {}) });

  // The interface is in Uzbek, in the reformed Latin alphabet: ş (sh), ç (ch), ó (oʻ), ǵ (gʻ). Dates
  // are numeric: the browser's Uzbek month and weekday names use the old spelling, if it has any.
  const two = (n) => String(n).padStart(2, '0');
  const fmtTime = (ms) => { const d = new Date(ms); return `${two(d.getHours())}:${two(d.getMinutes())}`; };
  const fmtDay = (ms) => { const d = new Date(ms); return `${two(d.getDate())}.${two(d.getMonth() + 1)}.${d.getFullYear()}`; };
  const DUP_FLAG = 'Bu ism bir neça marta işlatilgan';
  const END_LABEL = 'Tugatiş va yuklab oliş';
  const DOWNLOAD_LABEL = 'PDF va Excelni yuklab oliş';

  // ---- live session ---------------------------------------------------------

  function drawQr(text) {
    const qr = window.qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    const n = qr.getModuleCount();
    let d = '';
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) if (qr.isDark(y, x)) d += `M${x} ${y}h1v1h-1z`;
    }
    $('#qr').setAttribute('viewBox', `0 0 ${n} ${n}`);
    $('#qrPath').setAttribute('d', d);
  }

  function restartDrain(msLeft) {
    const el = $('#drain');
    el.style.transition = 'none';
    el.style.transform = `scaleX(${Math.max(0, Math.min(1, msLeft / WINDOW_MS))})`;
    void el.offsetWidth; // flush so the next transition starts from here
    el.style.transition = `transform ${msLeft}ms linear`;
    el.style.transform = 'scaleX(0)';
  }

  // tokens[0] is the current code, good for msLeft more; each next one for WINDOW_MS after that.
  function setCodes(sid, tokens, msLeft) {
    let until = performance.now() + msLeft + LAG_MS;
    codes = tokens.map((token, i) => ({ token, until: i ? (until += WINDOW_MS) : until }));
    codeSession = sid;
    rotate();
  }

  function rotate() {
    clearTimeout(rotateTimer);
    const now = performance.now();
    while (codes.length && codes[0].until <= now) codes.shift();
    // Out of codes (no connection for 30 s): the QR on screen no longer works, so dim it.
    document.body.classList.toggle('qr-stale', !codes.length);
    if (!codes.length) return;
    const { token, until } = codes[0];
    if (token !== lastToken) {
      lastToken = token;
      drawQr(`${location.origin}/?c=${codeSession}.${token}`);
      restartDrain(until - now);
    }
    rotateTimer = setTimeout(rotate, until - now);
  }

  function renderLatest() {
    const latest = local.entries.slice(-LATEST).reverse();
    const ids = latest.map((p) => p.id + (isDup(p) ? '!' : '')).join(','); // an earlier row can become a repeat
    if (ids === shownIds) return;
    shownIds = ids;
    const ul = $('#latest');
    ul.textContent = '';
    for (const p of latest) {
      const li = document.createElement('li');
      li.className = 'row';
      const img = document.createElement('img');
      img.className = 'avatar';
      img.alt = '';
      img.src = p.photo || '';
      const box = document.createElement('div');
      box.style.cssText = 'min-width:0;flex-grow:1';
      const name = document.createElement('div');
      name.className = 'name';
      name.textContent = p.name; // names are user input: never innerHTML
      const sub = document.createElement('div');
      sub.className = 'sub';
      sub.textContent = fmtTime(p.time);
      box.append(name, sub);
      if (isDup(p)) {
        const flag = document.createElement('div');
        flag.className = 'flag';
        flag.textContent = DUP_FLAG;
        box.append(flag);
      }
      li.append(img, box);
      ul.append(li);
    }
    $('#latestEmpty').hidden = latest.length > 0;
  }

  function renderLive(s) {
    $('#liveTitle').textContent = s.title || 'Qayd etiliş uçun skanerlang';
    $('#liveSince').textContent = `Boşlandi: ${fmtTime(s.startedAt)}`;
    $('#count').textContent = s.count;
    $('#joinUrl').textContent = location.host + '/';
    setCodes(s.sessionId, s.tokens, s.msLeft);
    renderLatest();
  }

  function setOnline(ok) {
    $('#livePill').classList.toggle('off', !ok);
    $('#liveText').textContent = ok ? 'Jonli' : 'Aloqa yóq';
    $('#offline').hidden = ok;
  }

  // Keep the screen on while a session is live: a sleeping screen hides the QR, and a hidden page
  // stops refreshing it. The browser drops the lock whenever the page is hidden, so the next poll
  // after it comes back asks again.
  let wakeLock = null; // a WakeLockSentinel, or the promise of one while it is being asked for
  function keepAwake(on) {
    if (!on) {
      Promise.resolve(wakeLock).then((l) => l && l.release()).catch(() => {});
      wakeLock = null;
      return;
    }
    if (wakeLock || !('wakeLock' in navigator) || document.hidden) return;
    const asked = navigator.wakeLock.request('screen').then(
      (l) => {
        if (wakeLock !== asked) { l.release(); return null; } // turned off while asking
        wakeLock = l;
        l.addEventListener('release', () => { if (wakeLock === l) wakeLock = null; });
        return l;
      },
      () => { if (wakeLock === asked) wakeLock = null; return null; }, // refused, e.g. battery saver
    );
    wakeLock = asked;
  }

  // Only the newest call keeps polling: a second call while a request is in flight (tab shown
  // again, session started) would otherwise leave two loops running.
  async function poll() {
    clearTimeout(pollTimer);
    const gen = ++pollGen;
    let delay = 3000;
    try {
      if (!local || local.sessionId !== sessionId) {
        local = { sessionId, entries: [], names: new Map(), lastNew: performance.now() };
      }
      const res = await api(`state?s=${encodeURIComponent(sessionId)}&after=${encodeURIComponent(lastId())}`);
      if (!res.ok) throw new Error('state'); // a server error is not "no session": stay on the live screen
      const s = await res.json();
      if (gen !== pollGen) return;
      if (!s.active) return showHome(); // ended, or deleted by the cleanup
      Object.assign(local, { title: s.title, startedAt: s.startedAt, count: s.count });
      for (const p of s.entries) {
        local.entries.push(p);
        local.names.set(nameKey(p.name), (local.names.get(nameKey(p.name)) || 0) + 1);
      }
      setOnline(true);
      if (document.body.dataset.screen !== 'live') show('live');
      renderLive(s);
      keepAwake(true);
      if (s.entries.length) local.lastNew = performance.now();
      const busy = performance.now() - local.lastNew < BUSY_MS;
      delay = s.more ? 200 : busy ? POLL_FAST_MS : POLL_SLOW_MS; // a backlog: ask again soon
    } catch {
      if (gen !== pollGen) return;
      setOnline(false);
      if (!document.body.dataset.screen) {
        show('home');
        $('#homeErr').textContent = 'Serverga ulanib bólmadi. Aloqani tekşirib, sahifani qayta yuklang.';
      }
    }
    pollTimer = setTimeout(poll, delay);
  }

  // End & download: the first tap arms the button, the second ends the session.
  let armTimer = 0;
  $('#endBtn').addEventListener('click', async () => {
    const btn = $('#endBtn');
    if (!btn.classList.contains('armed')) {
      btn.classList.add('armed');
      $('#endLabel').textContent = 'Tugatiş uçun yana bosing';
      armTimer = setTimeout(disarm, 4000);
      return;
    }
    clearTimeout(armTimer);
    btn.disabled = true;
    try {
      const res = await post('end', { sessionId });
      const done = await res.json();
      showHome(res.ok ? done : undefined); // not ok: it was already ended or deleted
      if (res.ok) $('#endedDownload').click(); // same path as the button: shows progress and errors
    } catch {
      setOnline(false); // the session keeps running; the offline box offers the files of what is here
    }
    btn.disabled = false;
    disarm();
  });

  $('#offlineSave').addEventListener('click', async () => {
    if (!local) return;
    const btn = $('#offlineSave');
    btn.disabled = true;
    await localFiles().then(save, () => {});
    btn.disabled = false;
  });
  function disarm() {
    $('#endBtn').classList.remove('armed');
    $('#endLabel').textContent = END_LABEL;
  }

  // ---- download -------------------------------------------------------------

  // The page already holds the check-ins it polled; the server sends only the rest (in pages).
  async function makeReport(sid) {
    const mine = local && local.sessionId === sid ? local.entries : [];
    let data = null;
    let after = mine.length ? mine[mine.length - 1].id : '';
    do {
      const res = await api(`report?s=${encodeURIComponent(sid)}&after=${encodeURIComponent(after)}`);
      if (!res.ok) throw new Error('report');
      const page = await res.json();
      if (data) data.entries.push(...page.entries);
      else data = { ...page, entries: [...mine, ...page.entries] };
      after = page.next;
    } while (after);
    return makeFiles(data);
  }

  // Without the server: the files from the check-ins this page holds, marked as possibly incomplete.
  const localFiles = () => makeFiles({ ...local, note: 'aloqasiz saqlangan, tóliq bólmasligi mumkin' });

  // Both are made here in the browser: the PDF with photos (report.js), the spreadsheet without (sheet.js).
  async function makeFiles(data) {
    const d = new Date(data.startedAt);
    const day = `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
    const slug = (data.title || '').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 30);
    const base = `davomat-${day}${slug ? '-' + slug : ''}`;
    return [
      { blob: await window.buildReport(data), filename: `${base}.pdf` },
      { blob: window.buildSheet(data), filename: `${base}.xlsx` },
    ];
  }

  // A short gap between the files: some browsers drop a second download started in the same instant.
  async function save(files) {
    for (const [i, { blob, filename }] of files.entries()) {
      if (i) await new Promise((r) => setTimeout(r, 400));
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 60000);
    }
  }

  // ---- home: start a session, or download the one that just ended -----------

  function showHome(justEnded) {
    clearTimeout(pollTimer);
    pollGen++;
    keepAwake(false);
    sessionId = '';
    ss.remove(SESSION);
    clearTimeout(rotateTimer);
    codes = [];
    lastToken = '';
    shownIds = null;
    $('#homeErr').textContent = '';
    $('#endedBlock').hidden = !justEnded;
    $('#startBlock').hidden = !!justEnded;
    if (justEnded) {
      const label = justEnded.title ? `${justEnded.title} · ` : '';
      $('#endedMeta').textContent = `${label}${fmtDay(justEnded.startedAt)} · ${justEnded.count} kişi qayd etildi`;
      // Once the files are made, the server copy is deleted and this page keeps them, so
      // "Download" still works afterwards. If the delete fails, the daily cleanup removes it.
      let files = null;
      // Leaving before the files are made loses access to them, so that needs a second tap.
      const again = $('#newSession');
      let armed = false;
      again.textContent = 'Yangi dars boşlaş';
      again.onclick = () => {
        if (!files && !armed) {
          armed = true;
          again.textContent = 'Fayllar hali saqlanmadi. Davom etiş uçun yana bosing';
          return;
        }
        showHome();
      };
      $('#endedDownload').onclick = async () => {
        const btn = $('#endedDownload');
        const text = btn.querySelector('span');
        btn.disabled = true;
        text.textContent = 'Fayllar tayyorlanmoqda…';
        $('#homeErr').textContent = '';
        try {
          if (!files) {
            files = await makeReport(justEnded.sessionId);
            post('delete', { sessionId: justEnded.sessionId }).catch(() => {});
            local = null; // the files have it all now
          }
          await save(files);
        } catch {
          // Offline after ending: save what this page has. The full report stays on the server.
          const mine = local && local.sessionId === justEnded.sessionId;
          $('#homeErr').textContent = mine
            ? 'Aloqa yóq. Bu sahifadagi qayd etilganlar saqlandi. Tóliq hisobot uçun aloqa tiklangaç yana bosing.'
            : 'Yuklab bólmadi. Qayta urinib kóring.';
          if (mine) await localFiles().then(save, () => {});
        }
        btn.disabled = false;
        text.textContent = DOWNLOAD_LABEL;
      };
    }
    show('home');
  }

  $('#startForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#startBtn');
    btn.disabled = true;
    $('#homeErr').textContent = '';
    try {
      const res = await post('start', { title: $('#title').value });
      if (!res.ok) throw new Error('start');
      sessionId = (await res.json()).sessionId;
      ss.set(SESSION, sessionId);
      $('#title').value = '';
      poll();
    } catch {
      $('#homeErr').textContent = 'Darsni boşlab bólmadi. Aloqani tekşirib, qayta urinib kóring.';
    }
    btn.disabled = false;
  });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && document.body.dataset.screen === 'live') poll();
  });

  // A reload of this tab carries on with its session; any other visit asks for a name.
  const nav = performance.getEntriesByType('navigation')[0];
  sessionId = nav && nav.type === 'reload' ? ss.get(SESSION) : '';
  if (sessionId) poll();
  else showHome();
})();
