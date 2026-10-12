# CLAUDE.md

Personal travel-conditions and events dashboard for one user (Mike). Live at https://event-travel.onrender.com/.

**Read `HANDOFF.md` before making changes.** It has the full architecture, the reasoning behind past decisions, known bugs, and next steps. Keep it up to date when something it describes changes.

## Layout

- `landing.html` + `landing.js`: the root page (`/`) - a city grid plus a "Continue to <city>" shortcut. `city.html` + `app.js`: the per-city dashboard, served at `/<cityKey>` (e.g. `/sea`). `cities.js`: the shared `CITIES` list both pages use. `style.css`: shared styles. No framework, no build step.
- `auth-ui.js` + `firebase-sync.js`: the optional Firebase sign-in (Google + email/password) and Firestore sync, used by both pages. Fully client-side - no backend involvement, no new npm dependency. See HANDOFF.md section 1b for the data model and manual Firebase Console setup steps, and `firestore.rules` for the security rules (paste into the Firebase console manually - no CLI deploy pipeline here).
- `server.js`: the Node backend (built-ins only, zero npm dependencies). This is what runs in production.
- `serve.ps1` (+ `start-server.ps1` / `stop-server.ps1`): PowerShell mirror of `server.js`, for local Windows testing only - and, absent a Node install on this machine, currently the only way to test locally at all.

## Run locally

- `node server.js` serves on http://localhost:8838 (uses `PORT` if set).
- `serve.ps1` serves on http://localhost:8837 (Windows only).

## Deploy

- Render web service `event-travel` (free tier, Ohio). **Every push to `main` auto-deploys** in about 1-3 minutes.
- Free tier spins down when idle: the first request after a quiet period is slow, and the in-memory event cache starts empty after each spin-up or deploy.
- After pushing, confirm the deploy is live in Render, then check the live site for something unique to the change (not just a 200) before calling it done.

## Rules

- **Keep `server.js` and `serve.ps1` in behavioral parity.** Change both, and before deploying compare `/api/events?city=X` from both servers across all cities (`title|startDate` sets). Restart both first so caches are equally fresh.
- **"Today" is the city's date, not the server's.** Render runs in UTC. Use `getCityTodayTomorrow` / `Get-CityTodayTomorrow`, and build day URLs and cache keys with UTC getters.
- In PowerShell, wrap sorted/filtered results in `@(...)` so one-item results stay arrays.
- Before adding an event source, verify real overlap with existing sources and real data depth, and report what you actually find, including when something doesn't work.
- Author commits as `Mike Bowen <tripledeluxeindustries@gmail.com>`.
- Commit messages explain the "why" and mention any bugs found and fixed along the way.
- For scope questions Mike tends to give short directional answers ("US cities first, Canada later"). Follow those rather than re-asking.
