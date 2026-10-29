(() => {
  'use strict';

  // Nothing is remembered between check-ins: every time, a student gives a name, takes a fresh
  // selfie, then scans the host's screen. That also means a phone can be passed around the room.

  const $ = (sel) => document.querySelector(sel);
  const screens = [...document.querySelectorAll('main[data-screen]')];

  const MSG = {
    bad_name: 'Enter your full name.',
    bad_photo: 'The selfie did not upload. Take it again.',
    expired: 'That code expired. Scan the screen again.',
    wrong_session: 'That is not a current check-in code.',
    ended: 'That session has ended.',
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

  // ---- state: lives in memory only ------------------------------------------

  let draft = { name: '', photo: '' };
  let busy = false;

  // The QR is also a link. If someone opened the site by scanning it with their camera app, that
  // code is already stale by the time they have typed a name, so just explain the order.
  const cameFromLink = new URLSearchParams(location.search).has('c');
  if (cameFromLink) history.replaceState(null, '', location.pathname);

  // ---- step 1: name -----------------------------------------------------------

  const nameInput = $('#name');
  const nameErr = $('#nameErr');

  function showName(message = '') {
    draft = { name: '', photo: '' };
    nameInput.value = '';
    nameErr.textContent = message;
    $('#linkHint').hidden = !cameFromLink;
    show('name');
    nameInput.focus({ preventScroll: true });
  }

  function submitName() {
    const name = nameInput.value.normalize('NFKC').trim().replace(/\s+/g, ' ');
    if (name.length < 2) { nameErr.textContent = MSG.bad_name; nameInput.focus(); return; }
    nameErr.textContent = '';
    draft.name = name;
    showSelfie();
  }

  $('#nameNext').addEventListener('click', submitName);
  $('#nameForm').addEventListener('submit', (e) => { e.preventDefault(); submitName(); });

  // ---- step 2: front camera ---------------------------------------------------

  const selfieVideo = $('#selfieVideo');
  const shoot = $('#shoot');
  const selfieErr = $('#selfieErr');
  const camNote = $('#camNote');
  let selfieStream = null;

  async function showSelfie(message = '') {
    selfieErr.textContent = message;
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

  shoot.addEventListener('click', () => {
    if (!selfieVideo.videoWidth) return;
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
    startScan();
  });

  // ---- step 3: scan -----------------------------------------------------------

  const scanVideo = $('#scanVideo');
  const scanMsg = $('#scanMsg');
  const scanCanvas = document.createElement('canvas');
  const scanCtx = scanCanvas.getContext('2d', { willReadFrequently: true });
  let scanStream = null;
  let scanning = false;
  let rejected = ''; // a code the server already turned down: not sent again while it is still in view

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
    $('#scanName').textContent = draft.name;
    $('#scanThumb').src = draft.photo;
    scanMsg.textContent = message;
    show('scan');
    if (!scanStream) { // after a failed check-in the camera is still on: keep using it
      try {
        scanStream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } },
          audio: false,
        });
        scanVideo.srcObject = scanStream;
        await scanVideo.play();
      } catch {
        scanMsg.textContent = 'Allow camera access in your browser to scan the code, then reload this page.';
        return;
      }
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
      const w = Math.round(scanVideo.videoWidth * scale);
      const h = Math.round(scanVideo.videoHeight * scale);
      if (scanCanvas.width !== w || scanCanvas.height !== h) { // resizing reallocates the canvas
        scanCanvas.width = w;
        scanCanvas.height = h;
      }
      scanCtx.drawImage(scanVideo, 0, 0, w, h);
      const img = scanCtx.getImageData(0, 0, w, h);
      const hit = window.jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
      const code = hit && codeFromQr(hit.data);
      if (code && code !== rejected) {
        scanning = false; // pause; the camera stays on in case the code is turned down
        checkIn(code);
        return;
      }
    }
    setTimeout(tick, 120);
  }

  // ---- check in ---------------------------------------------------------------

  async function checkIn(code) {
    if (busy) return;
    busy = true;
    scanMsg.textContent = 'Checking in…';
    const res = await post('checkin', { name: draft.name, photo: draft.photo, code });
    busy = false;
    if (res.ok) return showDone(res.data);
    // Never resend this exact code: if it was turned down it will not work later either, and after a
    // network error a fresh code is on screen within 5 seconds (this avoids a tight retry loop offline).
    rejected = code;
    const err = res.data.error;
    if (err === 'bad_name') { stopScan(); return showName(MSG.bad_name); }
    if (err === 'bad_photo') { stopScan(); return showSelfie(MSG.bad_photo); }
    if (err === 'ended') return showWait(MSG.ended, 'Session ended');
    return startScan(MSG[err] || 'Could not check in. Try again.');
  }

  // ---- done / wait ------------------------------------------------------------

  function showDone({ name, time }) {
    stopScan();
    draft = { name: '', photo: '' }; // forget everything: the next person starts from scratch
    $('#scanThumb').removeAttribute('src');
    $('#doneName').textContent = name;
    $('#doneTime').textContent = 'Today at ' + new Date(time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    show('done');
  }

  function showWait(text, title) {
    stopScan();
    $('#waitTitle').textContent = title;
    $('#waitText').textContent = text;
    show('wait');
  }

  $('#another').addEventListener('click', () => showName());
  $('#waitRetry').addEventListener('click', () => showName());

  document.addEventListener('visibilitychange', () => {
    // Free the camera when the tab is hidden; turn it back on when the tab comes back.
    const screen = document.body.dataset.screen;
    if (document.hidden) {
      stopScan();
      stopStream(selfieStream);
      selfieStream = null;
    } else if (screen === 'scan' && !scanning && !busy) startScan();
    else if (screen === 'selfie' && !selfieStream) showSelfie();
  });

  showName();
})();
