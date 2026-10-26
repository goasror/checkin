(() => {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const screens = [...document.querySelectorAll('main[data-screen]')];
  const ls = {
    get: (k) => { try { return localStorage.getItem(k) || ''; } catch { return ''; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
    del: (k) => { try { localStorage.removeItem(k); } catch { /* ignore */ } },
  };

  const PASS_KEY = 'ci_host_pass';
  let pass = ls.get(PASS_KEY);
  let pollTimer = 0;
  let lastToken = '';
  const photos = new Map(); // student id -> data URL, so each photo is downloaded once
  let shownIds = [];

  function show(name) {
    screens.forEach((s) => { s.hidden = s.dataset.screen !== name; });
    document.body.dataset.screen = name;
  }

  // ---- api ------------------------------------------------------------------

  async function api(path, options = {}) {
    const res = await fetch('/api/host/' + path, {
      ...options,
      headers: { ...(options.headers || {}), 'x-host-passcode': pass, 'content-type': 'application/json' },
    });
    if (res.status === 401) {
      pass = '';
      ls.del(PASS_KEY);
      showGate('That passcode is not right.');
      throw new Error('auth');
    }
    return res;
  }
  const post = (path, body) => api(path, { method: 'POST', body: JSON.stringify(body || {}) });

  const fmtTime = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const fmtDay = (ms) => new Date(ms).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });

  // ---- passcode gate --------------------------------------------------------

  function showGate(message = '') {
    clearTimeout(pollTimer);
    $('#gateErr').textContent = message;
    show('gate');
    $('#pass').focus({ preventScroll: true });
  }

  async function submitGate() {
    const value = $('#pass').value;
    if (!value) return;
    pass = value;
    $('#gateErr').textContent = '';
    try {
      const res = await api('sessions');
      if (res.status === 500) { showGate('Set the HOST_PASSCODE environment variable in Netlify, then redeploy.'); return; }
      ls.set(PASS_KEY, pass);
      route();
    } catch { /* auth error already shown */ }
  }
  $('#gateGo').addEventListener('click', submitGate);
  $('#gateForm').addEventListener('submit', (e) => { e.preventDefault(); submitGate(); });

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
      li.append(img, box);
      ul.append(li);
    }
    $('#latestEmpty').hidden = latest.length > 0;
  }

  function renderLive(s) {
    $('#count').textContent = s.count;
    $('#enrolled').textContent = s.enrolled;
    $('#bar').style.width = s.enrolled ? Math.min(100, (s.count / s.enrolled) * 100) + '%' : '0';
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
    } catch (e) {
      if (e.message === 'auth') return;
      setOnline(false);
    }
    pollTimer = setTimeout(poll, delay);
  }

  // End & download: first tap arms the button, second tap ends the session.
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
    } catch { /* auth handled */ }
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
    const res = await api(`csv?s=${encodeURIComponent(sessionId)}&tz=${encodeURIComponent(tz)}`);
    if (!res.ok) throw new Error('csv');
    const blob = await res.blob();
    const match = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') || '');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = match ? match[1] : 'attendance.csv';
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    return a.download;
  }

  // ---- home: start a session, earlier sessions ------------------------------

  async function showHome(justEnded) {
    clearTimeout(pollTimer);
    lastToken = '';
    shownIds = [];
    $('#homeErr').textContent = '';
    const ended = $('#endedBlock');
    ended.hidden = !justEnded;
    $('#startBlock').hidden = !!justEnded;
    if (justEnded) {
      $('#endedMeta').textContent = `${fmtDay(justEnded.startedAt)} · ${justEnded.count} checked in`;
      $('#endedFile').textContent = 'A CSV with names and check-in times';
      $('#endedDownload').onclick = () => download(justEnded.sessionId).catch(() => { $('#homeErr').textContent = 'Download failed. Try again.'; });
    }
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
        const day = document.createElement('div');
        day.className = 'name';
        day.textContent = `${fmtDay(s.startedAt)}, ${fmtTime(s.startedAt)}`;
        const sub = document.createElement('div');
        sub.className = 'sub';
        sub.textContent = `${s.count} checked in`;
        box.append(day, sub);
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'icon-btn';
        btn.setAttribute('aria-label', `Download attendance for ${fmtDay(s.startedAt)}`);
        btn.innerHTML = '<svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#0f172a" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11"/><path d="M7.5 11l4.5 4.5 4.5-4.5"/><path d="M5 19h14"/></svg>';
        btn.addEventListener('click', () => download(s.id).catch(() => { $('#homeErr').textContent = 'Download failed. Try again.'; }));
        row.append(box, btn);
        list.append(row);
      }
      $('#pastEmpty').hidden = sessions.length > 0;
    } catch { /* auth handled */ }
  }

  $('#startBtn').addEventListener('click', async () => {
    $('#startBtn').disabled = true;
    try {
      await post('start');
      poll();
    } catch { /* auth handled */ }
    $('#startBtn').disabled = false;
  });

  // ---- manage students ------------------------------------------------------

  $('#resetForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('#resetName').value.trim();
    if (!name) return;
    try {
      const res = await post('unenroll', { name });
      const data = await res.json();
      $('#resetStatus').textContent = res.ok ? `Removed ${data.removed}. They can enroll again.` : 'No student with that name.';
      if (res.ok) $('#resetName').value = '';
    } catch { /* auth handled */ }
  });

  $('#wipeForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const res = await post('wipe', { confirm: $('#wipeConfirm').value.trim() });
      const data = await res.json();
      $('#wipeStatus').textContent = res.ok ? `Deleted ${data.removed} students.` : 'Type DELETE to confirm.';
      if (res.ok) $('#wipeConfirm').value = '';
    } catch { /* auth handled */ }
  });

  // ---- start ----------------------------------------------------------------

  function route() {
    if (!pass) return showGate();
    poll();
  }

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && document.body.dataset.screen === 'live') poll();
  });

  route();
})();
