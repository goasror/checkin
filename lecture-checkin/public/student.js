(() => {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const screens = [...document.querySelectorAll('[data-screen]')].filter((el) => el.tagName === 'MAIN');

  // ---- tiny helpers ---------------------------------------------------------

  const ls = {
    get: (k) => { try { return localStorage.getItem(k) || ''; } catch { return ''; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
    del: (k) => { try { localStorage.removeItem(k); } catch { /* ignore */ } },
  };

  const MSG = {
    bad_name: 'Enter your full name.',
    bad_photo: 'The selfie did not upload. Try again.',
    expired: 'That code expired. Scan the screen again.',
    wrong_session: 'That is not a current check-in code.',
    ended: 'That session has ended.',
    name_in_use: 'Someone with the same name has already checked in to this session. Tell the lecturer.',
    network: 'No connection. Check your internet and try again.',
  };

  function show(name) {
    screens.forEach((s) => { s.hidden = s.dataset.screen !== name; });
    document.body.dataset.screen = name;
    window.scrollTo(0, 0);
  }

  async function post(path, body) {
    try {
      const r = await fetch('/api/' + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      let data = {};
      try { data = await r.json(); } catch { /* not json */ }
      return { ok: r.ok, status: r.status, data };
    } catch {
      return { ok: false, status: 0, data: { error: 'network' } };
    }
  }

  const stopStream = (stream) => stream && stream.getTracks().forEach((t) => t.stop());

  // ---- state ----------------------------------------------------------------

  let pendingCode = '';  // code from a native-camera scan (?c=...)
  let draft = null;      // { name, photo } waiting to be enrolled
  let busy = false;

  const params = new URLSearchParams(location.search);
  if (params.get('c')) {
    pendingCode = params.get('c');
    history.replaceState(null, '', location.pathname); // do not keep a stale code in the address bar
  }

  const me = () => ({ id: ls.get('ci_id'), name: ls.get('ci_name'), photo: ls.get('ci_photo') });

  // ---- screen 1: name -------------------------------------------------------

  const nameInput = $('#name');
  const nameErr = $('#nameErr');

  function showName(message = '') {
    nameErr.textContent = message;
    show('name');
    nameInput.focus({ preventScroll: true });
  }

  function submitName() {
    const name = nameInput.value.normalize('NFKC').trim().replace(/\s+/g, ' ');
    if (name.length < 2) { nameErr.textContent = MSG.bad_name; nameInput.focus(); return; }
    nameErr.textContent = '';
    draft = { name, photo: '' };
    showSelfie();
  }

  $('#nameNext').addEventListener('click', submitName);
  $('#nameForm').addEventListener('submit', (e) => { e.preventDefault(); submitName(); });
  nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submitName(); } });

  // ---- screen 2: front camera ----------------------------------------------

  const selfieVideo = $('#selfieVideo');
  const shoot = $('#shoot');
  const selfieErr = $('#selfieErr');
  const camNote = $('#camNote');
  let selfieStream = null;

  async function showSelfie() {
    selfieErr.textContent = '';
    shoot.disabled = true;
    camNote.textContent = 'Starting the front camera…';
    show('selfie');
    try {
      selfieStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 640 } },
        audio: false,
      });
      selfieVideo.srcObject = selfieStream;
      await selfieVideo.play();
      camNote.textContent = 'Front camera is on';
      shoot.disabled = false;
    } catch {
      camNote.textContent = '';
      selfieErr.textContent = 'Allow camera access in your browser to take the selfie, then reload this page.';
    }
  }

  shoot.addEventListener('click', async () => {
    if (busy || !selfieVideo.videoWidth) return;
    busy = true;
    shoot.disabled = true;
    // Crop the centre square and shrink it: ~160 px at low JPEG quality is a few KB.
    const side = Math.min(selfieVideo.videoWidth, selfieVideo.videoHeight);
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 160;
    canvas.getContext('2d').drawImage(
      selfieVideo,
      (selfieVideo.videoWidth - side) / 2, (selfieVideo.videoHeight - side) / 2, side, side,
      0, 0, 160, 160,
    );
    draft.photo = canvas.toDataURL('image/jpeg', 0.5);
    stopStream(selfieStream);
    selfieStream = null;
    busy = false;
    await enroll();
  });

  async function enroll() {
    if (!draft || !draft.photo) return showName();
    busy = true;
    const res = await post('enroll', draft);
    busy = false;
    if (res.ok) {
      ls.set('ci_id', res.data.id);
      ls.set('ci_name', res.data.name);
      ls.set('ci_photo', draft.photo);
      draft = null;
      return pendingCode ? checkIn(pendingCode) : startScan();
    }
    const err = res.data.error;
    if (err === 'network') return showWait(MSG.network);
    if (err === 'bad_name') { draft = null; return showName(MSG[err]); }
    draft.photo = '';
    selfieErr.textContent = MSG[err] || 'Something went wrong. Try again.';
    return showSelfie();
  }

  // ---- screen 3: scan -------------------------------------------------------

  const scanVideo = $('#scanVideo');
  const scanMsg = $('#scanMsg');
  const scanCanvas = document.createElement('canvas');
  const scanCtx = scanCanvas.getContext('2d', { willReadFrequently: true });
  let scanStream = null;
  let scanning = false;

  function codeFromQr(text) {
    try {
      const url = new URL(text);
      if (url.origin !== location.origin) return '';
      return url.searchParams.get('c') || '';
    } catch {
      return '';
    }
  }

  async function startScan(message = '') {
    const who = me();
    $('#scanName').textContent = who.name;
    if (who.photo) $('#scanThumb').src = who.photo;
    scanMsg.textContent = message;
    show('scan');
    if (scanStream) stopStream(scanStream);
    try {
      scanStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } },
        audio: false,
      });
      scanVideo.srcObject = scanStream;
      await scanVideo.play();
    } catch {
      scanMsg.textContent = 'Allow the camera, or scan the code with your phone’s own camera app.';
      return;
    }
    scanning = true;
    tick();
  }

  function stopScan() {
    scanning = false;
    stopStream(scanStream);
    scanStream = null;
  }

  function tick() {
    if (!scanning) return;
    if (scanVideo.readyState >= 2 && scanVideo.videoWidth && window.jsQR) {
      const scale = Math.min(1, 480 / Math.max(scanVideo.videoWidth, scanVideo.videoHeight));
      scanCanvas.width = Math.round(scanVideo.videoWidth * scale);
      scanCanvas.height = Math.round(scanVideo.videoHeight * scale);
      scanCtx.drawImage(scanVideo, 0, 0, scanCanvas.width, scanCanvas.height);
      const img = scanCtx.getImageData(0, 0, scanCanvas.width, scanCanvas.height);
      const hit = window.jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
      const code = hit && codeFromQr(hit.data);
      if (code) {
        stopScan();
        checkIn(code);
        return;
      }
    }
    setTimeout(tick, 120);
  }

  // ---- check in -------------------------------------------------------------

  async function checkIn(code) {
    if (busy) return;
    busy = true;
    stopScan();
    const who = me();
    $('#scanName').textContent = who.name;
    if (who.photo) $('#scanThumb').src = who.photo;
    scanMsg.textContent = 'Checking in…';
    show('scan');
    const res = await post('checkin', { id: who.id, code });
    busy = false;
    pendingCode = '';
    if (res.ok) return showDone(res.data);
    const err = res.data.error;
    if (err === 'unknown_student') {
      // The lecturer reset this enrollment (or storage was cleared on the server).
      ['ci_id', 'ci_name', 'ci_photo'].forEach(ls.del);
      return showName('Your enrollment was reset. Enter your name again.');
    }
    if (err === 'ended' || err === 'name_in_use') return showWait(MSG[err], err === 'ended' ? 'Session ended' : 'Name already used');
    if (err === 'network') return showWait(MSG.network, 'No connection');
    return startScan(MSG[err] || 'Could not check in. Try again.');
  }

  // ---- screen 4: done / wait -----------------------------------------------

  function showDone({ name, time }) {
    stopScan();
    $('#doneName').textContent = name;
    $('#doneTime').textContent = 'Today at ' + new Date(time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    show('done');
  }

  function showWait(text, title = 'No connection') {
    stopScan();
    $('#waitTitle').textContent = title;
    $('#waitText').textContent = text;
    show('wait');
  }

  // Students can remove their own name and selfie from the server at any time.
  $('#forget').addEventListener('click', async () => {
    const { id } = me();
    if (id) await post('forget', { id });
    ['ci_id', 'ci_name', 'ci_photo'].forEach(ls.del);
    showWait('Your name and selfie were deleted from this site. Enroll again to check in next time.', 'Deleted');
  });

  $('#waitRetry').addEventListener('click', () => {
    if (draft && draft.photo) return enroll();
    route();
  });

  // ---- start ----------------------------------------------------------------

  function route() {
    const who = me();
    if (!who.id) return showName();
    if (pendingCode) return checkIn(pendingCode);
    return startScan();
  }

  document.addEventListener('visibilitychange', () => {
    // Free the camera when the tab is hidden; resume scanning when it comes back.
    if (document.hidden) { if (scanning) stopScan(); }
    else if (document.body.dataset.screen === 'scan' && !scanning && !busy) startScan();
  });

  route();
})();
