# health-app

A small, no-build phone web app for logging a morning weigh-in and gym workouts into a private GitHub repo of plain-text log files.

- Reads `app/data.json` and exercise photos from the private repo through the GitHub API.
- Writes plain-text workout and weight files back with the GitHub Contents API.
- Saves every tap in the browser first (works offline), then syncs. Mid-workout commits carry `[skip ci]`.
- No data lives in this repo. The repo name and a fine-grained token (Contents read/write on one repo) are entered on the device and kept in its local storage.

Files: `index.html`, `style.css`, `app.js`, `sw.js` (offline shell), `manifest.webmanifest`, icons. Served by GitHub Pages from the repo root.
