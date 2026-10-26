# Lecture check-in

Attendance for one lecture hall. The host screen shows a QR code that changes every 10 seconds.
Students enroll once (name, then a front-camera selfie) and after that only scan.
When the lecture is over, the host taps **End & download** and gets a CSV.

It is a static site (`public/`) plus one Netlify Function (`netlify/functions/api.mjs`) that stores
students and check-ins in Netlify Blobs. GitHub Pages cannot run it, because it has nowhere to store
anything. Push the repo to GitHub and let Netlify deploy it from there.

## Deploy

1. Push this folder to a GitHub repository.
2. In Netlify: **Add new site, Import an existing project**, pick the repository. The build settings
   come from `netlify.toml`, so there is nothing to fill in.
3. **Site configuration, Environment variables**: add `HOST_PASSCODE` with a passcode only you know,
   then trigger a redeploy. The passcode also signs the QR codes, so keep it private.
4. Open `https://YOUR-SITE.netlify.app/host.html` on the host phone or laptop, enter the passcode once,
   and tap **Start session**. Show the QR to the room (a projector works well: the page switches to a
   two-column layout on wide screens).

Netlify Drop (dragging a folder into the dashboard) does not build functions. Use Git, or the CLI:
`npx netlify-cli deploy --prod`.

## How a lecture goes

- Host opens `/host.html` and taps **Start session**.
- A student opens the site, types their name, takes a selfie. Next time they land straight on the scanner.
  Scanning with the phone's own camera app also works: the QR is a link that checks them in.
- The host sees the count and the latest names with photos, and glances at them against the room.
- Host taps **End & download** (twice, so it cannot happen by accident). The CSV downloads.
  Earlier sessions stay on the host page, each with its own download button.

## What it guards against, and what it does not

- A photographed or screen-shared QR stops working after about 20 seconds.
- Checking in for a friend puts your own face next to their name in a list the lecturer can see.
- Names are unique, so a second person cannot enroll under the same name.
- It does **not** stop someone who enrolls under a friend's name and nobody looks at the photo,
  or a friend in the room scanning live for someone who is absent. Spot-check the photo list.
- Enrollment and check-in only work while a session is running, which keeps strangers from filling storage.

## Host housekeeping

- **Manage students** (bottom of the host page when no session is running):
  *Reset* removes one student so they can enroll again (new phone, cleared browser);
  *Delete all* wipes every stored name and selfie at the end of the semester.
  Attendance rows stay, but a later CSV download shows "(removed student)" for deleted names,
  so download what you need first.
- The CSV has quoted fields and neutralises names that start with `=`, `+`, `-` or `@` so spreadsheets do not run them.
  Times are written in the host's time zone and in UTC.

## Develop

```
npm install
npm test                  # API tests with an in-memory store
npx netlify-cli dev       # runs the site and the function locally (set HOST_PASSCODE in .env)
```

Camera access needs HTTPS or `localhost`, which `netlify dev` and Netlify both provide.

## Files

```
public/index.html, student.js    student pages: name, selfie, scan, done
public/host.html,  host.js       host pages: passcode, live QR, end and download, earlier sessions
public/style.css                 shared styles
public/vendor/                   qrcode-generator (MIT) and jsQR (Apache-2.0), copied from npm
netlify/functions/api.mjs        all server logic
tests/api.test.mjs               tests
```
