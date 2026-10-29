# Lecture check-in

Attendance for lecture halls. A host shows a QR code that changes every 5 seconds. Every student, every
time, types their name, takes a selfie with the front camera, then scans the code. When the lecture is over,
the host taps **End & download** and gets a PDF with a photo, name and time for everyone.

**Nothing is remembered.** There are no accounts and nothing is saved on the student's phone, so a student
who has no smartphone can borrow a friend's: each person goes through name, selfie and scan on it. The
host compares the names with the faces.

**Anyone can be a host, and any number of lessons can run at the same time.** There is no passcode. Every
visit to `/host` asks for a session name and starts its own session, even several from the same browser.
Each session has its own secret, so a student only appears in the list of the session whose QR they
scanned, and a host can only see and download their own sessions.

It is a static site (`public/`) plus one Netlify Function (`netlify/functions/api.mjs`) that stores
check-ins in Netlify Blobs, and a scheduled function (`netlify/functions/cleanup.mjs`) that deletes old
sessions once a day. GitHub Pages cannot run it, because it has nowhere to store anything. Push the
repo to GitHub and let Netlify deploy it from there.

The pages and the PDF are in Uzbek, written in the reformed Latin alphabet: **ş** for sh, **ç** for ch,
**ó** for oʻ and **ǵ** for gʻ. Dates and times are shown as numbers (29.10.2026, 09:15), because
browsers' built-in Uzbek month and weekday names use the old spelling.

## Deploy

1. Push this folder to a GitHub repository.
2. In Netlify: **Add new site, Import an existing project**, pick the repository. The build settings
   come from `netlify.toml`, so there is nothing to fill in and no environment variables are needed.
3. Open `https://YOUR-SITE.netlify.app/host` on the host's phone or laptop and tap **Start session**.

Netlify Drop (dragging a folder into the dashboard) does not build functions. Use Git, or the CLI:
`npx netlify-cli deploy --prod`.

## How a lecture goes

- The host opens `/host`, types a session name (optional), and taps **Start session**. Show the QR to
  the room (the page switches to a two-column layout on a projector). Opening `/host` again, in the same
  or another tab or browser, starts another session; reloading the same tab carries on with its session.
- A student opens the site and goes through three steps: name, front-camera selfie, scan the screen.
  Then a confirmation appears. **Check in someone else** starts again for the next person on the same phone.
- The host sees the count and the latest check-ins with photos, and glances at them against the room.
- The host page gets the next 30 seconds of codes with every call, so it rotates the QR itself. It calls
  the server every 5 seconds while check-ins are coming in (and for the first 30 seconds of a session),
  and every 20 seconds once nobody has checked in for 30 seconds. The count and the list refresh with it.
- If the host's connection drops, the live page stays up and offers **Save PDF of check-ins so far**,
  made from the check-ins the page already holds and marked as possibly incomplete. The QR keeps
  changing for up to 30 seconds, then fades: check-ins fail until the connection is back.
- The host taps **End & download** (twice, so it cannot happen by accident). Two files download: a PDF
  (two columns, each with photo, name and time) and an Excel file (`.xlsx`: number, name, time and the
  repeated-name flag, no photos). Both are made in the host's browser. As soon as they are made, the
  session and its photos are deleted from the server; the host page keeps the files, so the download
  button still works until the page is closed. Browsers may ask once to allow several downloads.
- A session ends only when the host taps **End**. As a safety net, a daily cleanup deletes sessions that
  were never ended (the tab was closed) a day after they started, and sessions that ended more than 7 days
  ago without a PDF being made.
- While a session is live, the host page keeps the screen awake (where the browser allows it), so the QR
  does not disappear when a phone or laptop would otherwise sleep.

## How hosts are identified

A host is a random key the browser creates the first time `/host` opens and keeps in local storage.
The server stores only a hash of it. That means:

- No sign-up, no passcode. Opening the page is enough.
- A session belongs to the tab that started it. Closing that tab before downloading the PDF loses access
  to it; the daily cleanup then deletes it.

## What it guards against, and what it does not

- A photographed or screen-shared QR stops working after about 8 seconds (5 s plus a 3 s grace for scans in flight), and stops completely when the host ends the session.
- Checking in for a friend puts the friend's own face (or yours) next to the name in a list the lecturer sees.
- If the same name is used twice in a session, both check-ins are kept and flagged ("Same name used more
  than once"), in the live list and in the PDF, so the faces can be compared.
- It does **not** stop someone using a friend's name when nobody looks at the photos, or a friend in the
  room scanning live for someone absent. Spot-check the list.

## Things to know before you open it to everyone

- **Anyone can start sessions and check in.** There is no limit, so a stranger could fill your storage.
  If that becomes a problem, add Netlify's rate limiting or a simple invite code in `api.mjs`.
- **Privacy.** A host sees the name and selfie of people who scanned their code, and the PDF contains them.
  Nothing is kept on the students' phones. Check what your institution requires before collecting photos.
- **The PDF is made in the host's browser** (`public/report.js`), from the same photos the host page shows.
  The server only sends the data. Names in any script come out right; the text in the PDF is not selectable.

## Develop

```
npm install
npm test                  # API tests with an in-memory store
npx netlify-cli dev       # runs the site and the function locally
```

Camera access needs HTTPS or `localhost`, which `netlify dev` and Netlify both provide.

## Files

```
public/index.html, student.js    student pages: name, selfie, scan, done
public/host.html,  host.js       host pages: live QR, end and download
public/style.css                 shared styles
public/vendor/                   qrcode-generator (MIT) and jsQR (Apache-2.0), copied from npm
netlify/functions/api.mjs        all server logic (the PDF data, not the file)
netlify/functions/cleanup.mjs    runs the daily cleanup from api.mjs
public/report.js                 draws the PDF in the host's browser
public/sheet.js                  writes the Excel file in the host's browser
tests/api.test.mjs               tests
```
