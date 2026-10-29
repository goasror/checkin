(() => {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const screens = [...document.querySelectorAll('main[data-screen]')];
  const KEY = 'ci_host_key';

  const ls = {
    get: (k) => { try { return localStorage.getItem(k) || ''; } catch { return ''; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
  };

  // ---- host identity: a random key kept in this browser ---------------------
  // Opening host.html#key=... on another device adopts the same key.

  let hostKey = '';
  const fromHash = /^#key=([A-Za-z0-9_-]{32,64})$/.exec(location.hash);
  if (fromHash) {
    hostKey = fromHash[1];
    ls.set(KEY, hostKey);
    history.replaceState(null, '', location.pathname);
  } else {
    hostKey = ls.get(KEY);
  }
  if (!/^[A-Za-z0-9_-]{32,64}$/.test(hostKey)) {
    const bytes = crypto.getRandomValues(new Uint8Array(24));
    hostKey = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    ls.set(KEY, hostKey);
  }

  const WINDOW_MS = 5000; // QR rotation, as in api.mjs
  const MAX_SESSION_MS = 3 * 3600 * 1000; // a session left running this long is deleted, as in api.mjs
  const LATEST = 12; // check-ins shown in the live list

  let pollTimer = 0;
  let pollGen = 0; // bumped to drop the answer of a poll still in flight
  let lastToken = '';
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

  const fmtTime = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const fmtDay = (ms) => new Date(ms).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });

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
        flag.textContent = 'Same name used more than once';
        box.append(flag);
      }
      li.append(img, box);
      ul.append(li);
    }
    $('#latestEmpty').hidden = latest.length > 0;
  }

  function renderLive(s) {
    $('#liveTitle').textContent = s.title || 'Scan to check in';
    // so a session left running from an earlier lecture is easy to spot
    $('#liveSince').textContent = `Started ${fmtTime(s.startedAt)} · ends on its own at ${fmtTime(s.startedAt + MAX_SESSION_MS)}`;
    $('#count').textContent = s.count;
    $('#joinUrl').textContent = location.host + '/';
    if (s.token !== lastToken) {
      lastToken = s.token;
      drawQr(`${location.origin}/?c=${s.sessionId}.${s.token}`);
      restartDrain(s.msLeft);
    }
    renderLatest();
  }

  function setOnline(ok) {
    $('#livePill').classList.toggle('off', !ok);
    $('#liveText').textContent = ok ? 'Live' : 'Offline';
    document.body.classList.toggle('is-offline', !ok); // dims the QR: it has stopped changing
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
      const sid = local ? local.sessionId : '';
      const res = await api(`state?s=${encodeURIComponent(sid)}&after=${encodeURIComponent(lastId())}`);
      if (!res.ok) throw new Error('state'); // a server error is not "no session": stay on the live screen
      const s = await res.json();
      if (gen !== pollGen) return;
      if (!s.active) return showHome();
      if (!local || local.sessionId !== s.sessionId) local = { sessionId: s.sessionId, entries: [], names: new Map() };
      Object.assign(local, { title: s.title, startedAt: s.startedAt, count: s.count });
      for (const p of s.entries) {
        local.entries.push(p);
        local.names.set(nameKey(p.name), (local.names.get(nameKey(p.name)) || 0) + 1);
      }
      setOnline(true);
      if (document.body.dataset.screen !== 'live') show('live');
      renderLive(s);
      keepAwake(true);
      // Catching up on a backlog: ask again soon. Otherwise once per code, right after it rotates
      // (one function call per 5 s); the check-in list refreshes along with it.
      delay = s.more ? 200 : s.msLeft + 80;
    } catch {
      if (gen !== pollGen) return;
      setOnline(false);
      if (!document.body.dataset.screen) {
        show('home');
        $('#homeErr').textContent = 'Cannot reach the server. Check your connection and reload.';
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
      $('#endLabel').textContent = 'Tap again to end';
      armTimer = setTimeout(disarm, 4000);
      return;
    }
    clearTimeout(armTimer);
    btn.disabled = true;
    try {
      const res = await post('end');
      const done = await res.json();
      showHome(res.ok ? done : undefined); // not ok: it was already ended, e.g. from another device
      if (res.ok) $('#endedDownload').click(); // same path as the button: shows progress and errors
    } catch {
      setOnline(false); // the session keeps running; the offline box offers a PDF of what is here
    }
    btn.disabled = false;
    disarm();
  });

  $('#offlineSave').addEventListener('click', async () => {
    if (!local) return;
    const btn = $('#offlineSave');
    btn.disabled = true;
    await localFile().then(save, () => {});
    btn.disabled = false;
  });
  function disarm() {
    $('#endBtn').classList.remove('armed');
    $('#endLabel').textContent = 'End & download';
  }

  // ---- download -------------------------------------------------------------

  // The page already holds the check-ins it polled; the server sends only the rest (in pages).
  async function makeReport(sessionId) {
    const mine = local && local.sessionId === sessionId ? local.entries : [];
    let data = null;
    let after = mine.length ? mine[mine.length - 1].id : '';
    do {
      const res = await api(`report?s=${encodeURIComponent(sessionId)}&after=${encodeURIComponent(after)}`);
      if (!res.ok) throw new Error('report');
      const page = await res.json();
      if (data) data.entries.push(...page.entries);
      else data = { ...page, entries: [...mine, ...page.entries] };
      after = page.next;
    } while (after);
    return makeFile(data);
  }

  // Without the server: a PDF of the check-ins this page holds, marked as possibly incomplete.
  const localFile = () => makeFile({ ...local, note: 'saved offline, may be incomplete' });

  // report.js draws the PDF here in the browser.
  async function makeFile(data) {
    const blob = await window.buildReport(data);
    const d = new Date(data.startedAt);
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const slug = (data.title || '').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 30);
    return { blob, filename: `attendance-${day}${slug ? '-' + slug : ''}.pdf` };
  }

  function save({ blob, filename }) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  }

  // ---- home: start a session, or download the one that just ended -----------

  function showHome(justEnded) {
    clearTimeout(pollTimer);
    pollGen++;
    keepAwake(false);
    lastToken = '';
    shownIds = null;
    $('#homeErr').textContent = '';
    $('#endedBlock').hidden = !justEnded;
    $('#startBlock').hidden = !!justEnded;
    if (justEnded) {
      const label = justEnded.title ? `${justEnded.title} · ` : '';
      $('#endedMeta').textContent = `${label}${fmtDay(justEnded.startedAt)} · ${justEnded.count} checked in`;
      // Once the PDF is made, the server copy is deleted and this page keeps the file, so
      // "Download" still works afterwards. If the delete fails, the daily cleanup removes it.
      let file = null;
      // Leaving before the PDF is made loses access to it, so that needs a second tap.
      const again = $('#newSession');
      let armed = false;
      again.textContent = 'Start another session';
      again.onclick = () => {
        if (!file && !armed) {
          armed = true;
          again.textContent = 'PDF not saved yet. Tap again to continue';
          return;
        }
        showHome();
      };
      $('#endedDownload').onclick = async () => {
        const btn = $('#endedDownload');
        const text = btn.querySelector('span');
        btn.disabled = true;
        text.textContent = 'Preparing PDF…';
        $('#homeErr').textContent = '';
        try {
          if (!file) {
            file = await makeReport(justEnded.sessionId);
            post('delete', { sessionId: justEnded.sessionId }).catch(() => {});
            local = null; // the PDF has it all now
          }
          save(file);
        } catch {
          // Offline after ending: save what this page has. The full report stays on the server.
          const mine = local && local.sessionId === justEnded.sessionId;
          $('#homeErr').textContent = mine
            ? 'No connection. Saved the check-ins this page had. Tap again when you are back online for the full report.'
            : 'Download failed. Try again.';
          if (mine) await localFile().then(save, () => {});
        }
        btn.disabled = false;
        text.textContent = 'Download PDF report';
      };
    }
    $('#linkBox').value = `${location.origin}${location.pathname}#key=${hostKey}`;
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
      $('#title').value = '';
      poll();
    } catch {
      $('#homeErr').textContent = 'Could not start the session. Check your connection and try again.';
    }
    btn.disabled = false;
  });

  // ---- use on another device --------------------------------------------------

  $('#linkForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const box = $('#linkBox');
    box.select();
    try {
      await navigator.clipboard.writeText(box.value);
      $('#linkStatus').textContent = 'Link copied.';
    } catch {
      $('#linkStatus').textContent = 'Press and hold the link to copy it.';
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && document.body.dataset.screen === 'live') poll();
  });

  poll();
})();
