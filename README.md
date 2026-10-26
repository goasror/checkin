# Lecture check-in

Attendance for lecture halls. A host shows a QR code that changes every 10 seconds. Every student, every
time, types their name, takes a selfie with the front camera, then scans the code. When the lecture is over,
the host taps **End & download** and gets a PDF with a photo, name and time for everyone.

**Nothing is remembered.** There are no accounts and nothing is saved on the student's phone, so a student
who has no smartphone can borrow a friend's: each person goes through name, selfie and scan on it. The
host compares the names with the faces.

**Anyone can be a host, and many hosts can run at the same time.** There is no passcode. Each session has its
own secret, so a student only appears in the list of the host whose QR they scanned, and a host can only see
and download their own sessions.

It is a static site (`public/`) plus one Netlify Function (`netlify/functions/api.mjs`) that stores
check-ins in Netlify Blobs. GitHub Pages cannot run it, because it has nowhere to store anything. Push the
repo to GitHub and let Netlify deploy it from there.

## Deploy

1. Push this folder to a GitHub repository.
2. In Netlify: **Add new site, Import an existing project**, pick the repository. The build settings
   come from `netlify.toml`, so there is nothing to fill in and no environment variables are needed.
3. Open `https://YOUR-SITE.netlify.app/host.html` on the host's phone or laptop and tap **Start session**.

Netlify Drop (dragging a folder into the dashboard) does not build functions. Use Git, or the CLI:
`npx netlify-cli deploy --prod`.

## How a lecture goes

- The host opens `/host.html`, optionally types a session name, and taps **Start session**.
  Show the QR to the room (the page switches to a two-column layout on a projector).
- A student opens the site and goes through three steps: name, front-camera selfie, scan the screen.
  Then a confirmation appears. **Check in someone else** starts again for the next person on the same phone.
- The host sees the count and the latest check-ins with photos, and glances at them against the room.
- The host taps **End & download** (twice, so it cannot happen by accident). A PDF downloads: two columns,
  each with photo, name and time. Earlier sessions stay on the host page, each with its own download button.

## How hosts are identified

A host is a random key the browser creates the first time `/host.html` opens and keeps in local storage.
The server stores only a hash of it. That means:

- No sign-up, no passcode. Opening the page is enough.
- Sessions belong to that browser. Clearing the browser data loses access to earlier downloads.
- The host page has **Use on another device**: a link containing the key. Anyone who has that link can
  download the host's files, so treat it like a password.

## What it guards against, and what it does not

- A photographed or screen-shared QR stops working after about 20 seconds, and stops completely when the host ends the session.
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
- **Names in the PDF** render in Latin, Cyrillic and Greek. Other scripts show as `?`.

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
public/host.html,  host.js       host pages: live QR, end and download, earlier sessions
public/style.css                 shared styles
public/vendor/                   qrcode-generator (MIT) and jsQR (Apache-2.0), copied from npm
netlify/functions/api.mjs        all server logic, including the PDF report
netlify/functions/font-data.mjs  DejaVu Sans subset used in the PDF (free licence, see DEJAVU-LICENSE.txt)
tests/api.test.mjs               tests
```
