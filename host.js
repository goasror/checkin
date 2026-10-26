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

  let pollTimer = 0;
  let lastToken = '';
  const photos = new Map(); // student id -> data URL, so each photo is downloaded once
  let shownIds = [];

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
    el.style.transform = `scaleX(${Math.max(0, Math.min(1, msLeft / 10000))})`;
    void el.offsetWidth; // flush so the next transition starts from here
    el.style.transition = `transform ${msLeft}ms linear`;
    el.style.transform = 'scaleX(0)';
  }

  function renderLatest(latest) {
    const ul = $('#latest');
    ul.textContent = '';
    shownIds = [];
    for (const p of latest) {
      if (p.photo) photos.set(p.id, p.photo);
      shownIds.push(p.id);
      const li = document.createElement('li');
      li.className = 'row';
      const img = document.createElement('img');
      img.className = 'avatar';
      img.alt = '';
      img.src = photos.get(p.id) || '';
      const box = document.createElement('div');
      box.style.cssText = 'min-width:0;flex-grow:1';
      const name = document.createElement('div');
      name.className = 'name';
      name.textContent = p.name; // names are user input: never innerHTML
      const sub = document.createElement('div');
      sub.className = 'sub';
      sub.textContent = fmtTime(p.time);
      box.append(name, sub);
      if (p.dup) {
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
    $('#count').textContent = s.count;
    $('#joinUrl').textContent = location.host + '/';
    if (s.token !== lastToken) {
      lastToken = s.token;
      drawQr(`${location.origin}/?c=${s.sessionId}.${s.token}`);
      restartDrain(s.msLeft);
    }
    renderLatest(s.latest);
  }

  function setOnline(ok) {
    $('#livePill').classList.toggle('off', !ok);
    $('#liveText').textContent = ok ? 'Live' : 'Offline';
  }

  async function poll() {
    clearTimeout(pollTimer);
    let delay = 3000;
    try {
      const res = await api('state?have=' + encodeURIComponent(shownIds.join(',')));
      const s = await res.json();
      if (!s.active) return showHome();
      setOnline(true);
      if (document.body.dataset.screen !== 'live') show('live');
      renderLive(s);
      delay = Math.max(500, Math.min(3000, s.msLeft + 80)); // refresh right after the code rotates
    } catch {
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
      clearTimeout(pollTimer);
      await showHome(done);
      if (done.sessionId) await download(done.sessionId).catch(() => {});
    } catch { /* offline: leave the session running */ }
    btn.disabled = false;
    disarm();
  });
  function disarm() {
    $('#endBtn').classList.remove('armed');
    $('#endLabel').textContent = 'End & download';
  }

  // ---- download -------------------------------------------------------------

  async function download(sessionId) {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    const res = await api(`pdf?s=${encodeURIComponent(sessionId)}&tz=${encodeURIComponent(tz)}`);
    if (!res.ok) throw new Error('pdf');
    const blob = await res.blob();
    const match = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') || '');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = match ? match[1] : 'attendance.pdf';
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }

  // ---- home: start a session, earlier sessions ------------------------------

  async function showHome(justEnded) {
    clearTimeout(pollTimer);
    lastToken = '';
    shownIds = [];
    $('#homeErr').textContent = '';
    $('#endedBlock').hidden = !justEnded;
    $('#startBlock').hidden = !!justEnded;
    if (justEnded) {
      const label = justEnded.title ? `${justEnded.title} · ` : '';
      $('#endedMeta').textContent = `${label}${fmtDay(justEnded.startedAt)} · ${justEnded.count} checked in`;
      const failed = () => { $('#homeErr').textContent = 'Download failed. Try again.'; };
      $('#endedDownload').onclick = () => download(justEnded.sessionId).catch(failed);
    }
    $('#linkBox').value = `${location.origin}${location.pathname}#key=${hostKey}`;
    show('home');
    try {
      const res = await api('sessions');
      const { sessions } = await res.json();
      const list = $('#past');
      list.textContent = '';
      for (const s of sessions) {
        const row = document.createElement('div');
        row.className = 'row';
        const box = document.createElement('div');
        box.style.cssText = 'min-width:0;flex-grow:1';
        const top = document.createElement('div');
        top.className = 'name';
        top.textContent = s.title || `${fmtDay(s.startedAt)}, ${fmtTime(s.startedAt)}`;
        const sub = document.createElement('div');
        sub.className = 'sub';
        sub.textContent = `${s.title ? fmtDay(s.startedAt) + ' · ' : ''}${s.count} checked in`;
        box.append(top, sub);
        const label = s.title || fmtDay(s.startedAt);
        const failed = () => { $('#homeErr').textContent = 'Download failed. Try again.'; };
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'icon-btn';
        btn.setAttribute('aria-label', `Download PDF report for ${label}`);
        btn.innerHTML = '<svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#0f172a" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11"/><path d="M7.5 11l4.5 4.5 4.5-4.5"/><path d="M5 19h14"/></svg>';
        btn.addEventListener('click', () => download(s.id).catch(failed));
        row.append(box, btn);
        list.append(row);
      }
      $('#pastEmpty').hidden = sessions.length > 0;
    } catch {
      $('#homeErr').textContent = 'Could not load earlier sessions. Check your connection.';
    }
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
