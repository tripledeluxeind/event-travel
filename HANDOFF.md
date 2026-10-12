# Handoff: Travel Conditions and Events dashboard

## 1. What it is

A personal dashboard that shows, for a chosen US city:

- **Weather card:** current conditions, forecast, and active alerts (alert banner at top).
- **Events card:** upcoming events for today + tomorrow (or any date picked with the date input), with category tabs: All, Live Music, EDM, Comedy, Community, Sports, Food. Each event has a link (direct ticket link when the source provides one), a venue button that opens Google/Waze/Apple Maps directions, and a checkbox "I've got tickets".
- **My Tickets card:** events the user checked. Persisted in `localStorage` (`ticketedEvents`), with add-to-calendar buttons (Google, Outlook, and a server-generated `.ics` via `/api/ics` so Apple Calendar works on iPhone). The next ticketed event gets a pulsing yellow glow.
- **Header:** city picker, clock, and "Now Playing / Next" ticker for the nearest events. Card titles share a "wavy hover" animation (`.wavy-text` class).
- **Landing page** (`landing.html`, `/`): a city grid (from the shared `CITIES` list in `cities.js`) plus a "Continue to <city>" shortcut if a city was previously picked. Every city has its own page/URL - see section 1a.

No required accounts, no required database and no required auth - the whole app works fully anonymously by design. There's now an *optional* Firebase-backed sign-in (Google + email/password) purely for visitors who want their default city and ticketed events synced across devices/browsers - see section 1b. Nothing about the anonymous path changes if Firebase is never configured, misconfigured, or the visitor never signs in.

## 1a. URL / page structure

- `/` -> `landing.html` (city picker + sign-in entry point).
- `/<cityKey>` (e.g. `/sea`, `/bos` - the same short keys from `CITIES`) -> `city.html`, the per-city dashboard (weather/events/tickets). This used to be `index.html`/`/` directly, single-page, with the city swapped in place via JS; it's now a real navigation so city pages are shareable/bookmarkable URLs.
- `city.html` resolves + validates the city from `location.pathname`'s first segment against `CITIES` (see `getCityFromPath()` in `app.js`); an unrecognized slug falls back to the last-saved city, and if neither resolves, redirects to `/`.
- `cities.js` holds the single shared `CITIES` array (city key/name/lat/lon/tz/domain/eventsUrl) used by both `landing.html` and `city.html` - it used to live only in `app.js`.
- **Why no backend city-key validation:** `server.js` has no single canonical list of valid city keys (routing to scrapers uses several separate config maps, not one array) - duplicating a key list there just to validate `/sea`-style paths would be a third place to keep in sync. Instead the routing rule in `server.js`/`serve.ps1` is purely mechanical: any path with no file extension that isn't an existing static file is served `city.html`, which does the actual slug validation client-side. This is real serving behavior (not Firebase-specific), so - unlike 1b below - it **is** covered by the "keep server.js/serve.ps1 in parity" rule, and both were changed together.

## 1b. Optional Firebase sync

Fully client-side: Firebase Auth (Google + email/password) + Firestore, both via the Firebase JS SDK loaded as real ES-module imports from Google's CDN (`firebase-sync.js`) - no `firebase-admin`, no new npm dependency, no secrets on Render, no changes to `server.js`/`serve.ps1`. All authorization is enforced by Firestore Security Rules (`firestore.rules`: a user may only read/write their own `users/{uid}` doc) - the web config in `firebase-sync.js` is a public client identifier by Firebase's own design, not a secret, so it's committed as-is (currently placeholder `REPLACE_ME` values - see the manual setup steps below).

- `firebase-sync.js` - pure Firebase SDK wrapper, no DOM. Dynamically `import()`-ed (works from a plain classic script, no `type="module"` tag needed) so a missing/unconfigured/broken Firebase setup never breaks anything else - every failure is caught and the sign-in UI just doesn't render.
- `auth-ui.js` - the shared sign-in popover + header button, used by both `landing.html` and `city.html`. Owns the merge/reconcile logic on sign-in and exposes `window.EventTravelSync` (only once Firebase has actually loaded) for `app.js` to push local changes - every call site in `app.js` uses `window.EventTravelSync?.foo?.()`, so it's a no-op on a page with no signed-in user or no Firebase at all.
- **Data model:** one Firestore doc per user, `users/{uid}` = `{ defaultCity, defaultCityUpdatedAt, ticketedEvents: [...same shape as localStorage...], updatedAt }`.
- **Sync behavior:** on sign-in (including the session Firebase restores automatically on a fresh load), pull the cloud doc, union `ticketedEvents` by `key`, last-write-wins on `defaultCity` via the explicit `defaultCityUpdatedAt` timestamp (bumped in `app.js`'s `persistCity()` only on an actual city change, not every reload), write the merged result back to both `localStorage` and Firestore, and reload the page once if that merge actually changed anything locally. Sign-out leaves `localStorage` untouched; cloud writes just stop until signing back in.
- **Accepted limitation - no tombstones:** a ticket removed on device A while device B is offline (and still has it locally) can resurrect once B reconnects. Self-heals automatically once the event is in the past (the existing expiry prune in `renderTicketsCard()` already runs everywhere), but not if it's still upcoming. Deliberately not engineered around - whole-array sync has no concept of "this was deliberately deleted" without a change log, which wasn't worth building for a personal-scale app.
- **Manual Firebase Console setup needed (not automatable - no API access to provision this):** create/select a project; Project settings -> General -> "Your apps" -> add a Web app -> copy the `firebaseConfig` object into `firebase-sync.js` in place of the `REPLACE_ME` placeholders; Authentication -> Sign-in method -> enable Google and Email/Password; Authentication -> Settings -> Authorized domains -> add `event-travel.onrender.com` (localhost is included by default for any port, so both local servers work without extra entries); Firestore Database -> Create database -> production mode -> paste `firestore.rules` into the Rules tab -> Publish.

## 2. Stack

- **Frontend:** plain HTML/CSS/vanilla JS (`landing.html`, `city.html`, `cities.js`, `landing.js`, `app.js`, `auth-ui.js`, `firebase-sync.js`, `style.css`). No framework, no build step, no bundler.
- **Backend:** one Node.js file, `server.js`, using only built-ins (`http`, `fs`, `path`, global `fetch`). **Zero npm dependencies**; `package.json` only declares `node >=18` and `npm start` = `node server.js`.
- **Weather:** the US National Weather Service API (`api.weather.gov`: `/points`, forecast, nearest station observations, `/alerts/active`), called **directly from the browser** (CORS-enabled, no key). Refreshes every 10 min; events every 20 min.
- **Events:** scraped server-side (the sources are not CORS-enabled) and cached in memory. See section 5.
- **Local-dev mirror:** `serve.ps1` is a PowerShell re-implementation of `server.js` (the project started as PowerShell and was ported to Node so it could be deployed). It is **only** for local Windows testing - and, since this machine has no Node.js install, it's currently the only way this project gets tested locally at all.

## 3. Deployment

- **Where:** Render (free tier) at https://event-travel.onrender.com/ .
- **How:** the GitHub repo https://github.com/tripledeluxeind/event-travel.git is connected to Render; **every push to `main` auto-deploys** in roughly 1-3 minutes. Render runs `server.js` (`npm start`) and supplies `PORT`; the code reads `process.env.PORT`, defaulting to 8838. Render's dashboard settings (build/start command, plan) were set up earlier outside this session and were not re-checked; confirm there if something looks off.
- **Server timezone is UTC** (that mattered, see section 6). The server also serves `landing.html`/`city.html`/`app.js`/`style.css`/etc with `no-cache` headers.
- **Free-tier behavior to expect:** Render free instances normally spin down when idle, so the first request after a quiet period can be slow, and the in-memory event cache starts empty after each spin-up or deploy.
- **Verifying a deploy:** poll the live site for something unique to the change (e.g. a new city's `/api/events?city=xxx` or a changed value), not just a 200.
- **Local:** `node server.js` -> http://localhost:8838 ; or `serve.ps1` -> http://localhost:8837 (`start-server.ps1` / `stop-server.ps1` wrap it).
- **Git:** commits are authored as `Mike Bowen <tripledeluxeindustries@gmail.com>` (commits before Oct 12, 2026 used `mikeb@tacotimenw.com`). Commit trailer convention: `Co-Authored-By: Claude ...`. Git prints harmless LF/CRLF warnings on Windows.

## 4. Current status

Everything below is shipped and live; working tree was clean as of the last commit.

**17 cities** (defined in `CITIES` in `cities.js`; keys are used everywhere):

| Group | Cities | Primary event source | Also merged in |
|---|---|---|---|
| DoStuff Media | sea, pdx, atx, nyc, chi, den, bna, lax, bay, bos | `do206.com`, `dopdx.com`, `do512.com`, `donyc.com`, `do312.com`, `do303.com`, `do615.com`, `dolosangeles.com`, `dothebay.com`, `do617.com` | Eventbrite; 19hz (all except nyc, bna) |
| Bespoke primary | reno, phx | `therenoscene.com` (concerts only), `dtphx.org` | Eventbrite (reno); Eventbrite + 19hz (phx) |
| **No primary yet** | atl, mia, dc, det, oma | none | Eventbrite + 19hz only |

Recent history (newest first): landing page + per-city URLs (`/<key>`) + optional Firebase sign-in/sync (Google + email/password, Firestore-backed); `7285e87` fix evening "today's events vanished" bug; `9d3d3df` add Boston/Atlanta/Miami/DC/Detroit/Omaha; `b3383d8` extend 19hz EDM to all existing cities it covers; `37ed02a` EDM tab (Seattle); earlier: iOS calendar fix, tickets card, Comedy tab, direct ticket links, Eventbrite real-time parsing.

## 5. Architecture and how events are built

`/api/events?city=KEY[&date=YYYY-MM-DD]` returns a JSON **array** of `{title, permalink, venue, city, startDate (ISO with offset), category, lat, lon, ticketUrl?, hasTime?}`.

1. **DoStuff Media** (`CITY_DOMAINS`): per-day pages `/events/YYYY/M/D`, markup `ds-listing event-card ds-event-category-{cat}`. Default view fetches today+tomorrow; a picked date fetches that day.
2. **Eventbrite backfill** (`EVENTBRITE_CITY_SLUGS`, e.g. `ma--boston`): the Sports and Food-and-drink browse pages. Parsed from `window.__SERVER_DATA__` (real start times + per-event timezone). Events with no time get `hasTime:false` and show date only.
3. **19hz.info backfill** (`NINETEEN_HZ_PAGES`): the EDM tab. Each city page lists dated one-offs and recurring club nights; only dated one-offs are parsed.
4. **Merge/de-dupe** (`mergeBackfillResults`): drops a backfill event if lowercase title + calendar date already exists. Order is primary, then Eventbrite, then 19hz.
5. **Domainless cities** (`getBackfillOnlyEventsJson`): Eventbrite and 19hz are the only sources and are de-duped against each other. In `app.js`, a city with `eventsUrl` but no `domain` still fetches events; only a city with neither is treated as having no feed. `eventsUrl` is used for the "Browse..." link-out and footer link.
6. **Caching:** in-memory `Map`, 15-20 min TTL per source. A failed fetch is only trusted for 1 minute (`isCacheFresh`) so a transient failure (dothebay.com is occasionally slow) self-heals instead of showing an empty city for 20 minutes.
7. **Routing in `/api/events`:** reno -> Reno parser; phx -> dtphx parser; city has a domain -> generic DoStuff path; city has a 19hz/Eventbrite config -> backfill-only; else `[]`.

## 6. Decisions and why

- **Node port of the PowerShell server:** HttpListener only runs on Windows; Render needs a Linux-friendly runtime. PowerShell was kept as a local fallback, hence the "change both" rule.
- **Scrape server-side:** none of the event sites send CORS headers. Weather (NWS) does, so it stays in the browser.
- **Event-source strategy** (also in the project memory note): before adding a source, check real overlap and real data depth. DoStuff (nightlife/concerts) and Eventbrite (sports/food/community) are complementary tiers, not redundant. Time Out Chicago was evaluated and rejected on that basis.
- **Eventbrite via `__SERVER_DATA__`, not JSON-LD:** JSON-LD only has a date; the hydration blob has real times and timezones.
- **19hz recurring nights skipped:** they are dated only by phrases like "1st Mondays"; supporting them needs a recurrence-rule parser. Skipped deliberately.
- **19hz `cityFilter` rule:** filter only pages that combine a place with a wider region (Texas -> Austin, Oregon -> Portland, LosAngeles/SoCal -> Los Angeles, DC/MD/VA -> Washington, Massachusetts -> Boston+Cambridge, "Iowa" -> Omaha+Lincoln). Single-city pages are left unfiltered and a little suburb bleed (e.g. Tacoma in Seattle) is accepted. The filter accepts a string or an array (Cambridge is nearly as big as Boston, so a single string would have dropped half the data).
- **Omaha as the Iowa/Nebraska city:** the 19hz page is titled "Iowa" but mixes Des Moines, Lincoln and Omaha roughly evenly. Omaha is the largest metro, Lincoln is ~55 mi away (kept), Des Moines is ~130 mi and another state (dropped).
- **Ship new cities with 19hz + Eventbrite only:** guessed DoStuff domains for DC, Detroit, Miami, Des Moines and Omaha were all parked/for-sale (a 200 whose title is "The domain name X.COM." or that redirects to `/lander`). Only `do617.com` was real. `doatlanta.com` is real but uses a different template (no day pages, no `ds-listing` markup) and would need its own parser. The user chose "build them with 19hz and we'll add more sources later".
- **Canada deferred:** Toronto/Vancouver are on 19hz but NWS has no Canadian data. User said "US cities first, Canada later" (see next steps).
- **`.ics` built server-side:** iOS Safari ignores `<a download>` on data: URIs, so a real same-origin URL with proper headers is the only reliable way.
- **Timezone handling:** all `startDate` values carry an explicit offset. Offsets are computed DST-aware per city (`getUtcOffsetString`, `CITY_TZ`; `$CityWindowsTz` in PowerShell). Phoenix uses `America/Phoenix` (no DST). Windows has no separate Detroit zone, so `det` uses "Eastern Standard Time" in PowerShell.

## 7. Known bugs, quirks and gotchas

**Fixed but easy to reintroduce:**
- **"Today" must be the city's date, not the server's.** Render is UTC, so evenings in US cities were already "tomorrow" server-side and today's events disappeared. Use `getCityTodayTomorrow` / `Get-CityTodayTomorrow`, anchored at the city's real local midnight (anchoring at UTC midnight lets "yesterday evening" leak in). Build day URLs/cache keys with UTC getters (`ymdUTC`, `getUTC*`); JS local getters break on any non-UTC machine (this dev box is Pacific).
- **PowerShell single-result unwrapping:** a one-item pipeline result loses its array, `.Count` is `$null`, and the `[...]` JSON wrap never fires, so the client gets an object and crashes. Wrap sorts in `@(...)`. Node is unaffected.

**Open / known-minor:**
- Reno titles differ between backends by HTML-entity decoding (`&#8211;` in Node vs a real en dash in PowerShell). Cosmetic; Node output is the one users see and may show the raw entity.
- Phoenix (`dtphx.org` AJAX) occasionally returns different times for the same event between two fetches; looks like site-side drift.
- **Eventbrite results are never city-filtered** (only 19hz is), so nearby suburbs appear (e.g. Arlington under DC, La Vista under Omaha).
- The 19hz `cityFilter` for DC is just "Washington", so legit close suburbs (Arlington, Silver Spring) from 19hz are dropped. Accepted simplification.
- New domainless cities are thin: often 0-5 events on a given day and mostly EDM/sports. That is expected until real primary sources exist, not a bug.
- `app.js` line ~730: the "events failed to load" hint still mentions `serve.ps1`/port 8837; stale wording for the deployed site.
- Free-tier cold starts (see section 3).

**Dev-environment gotchas:**
- Stale processes hold ports 8837/8838: `netstat -ano | grep LISTENING`, then `Stop-Process -Id`.
- `grep -c` counts lines, not occurrences; these HTML files are often one line. Use `grep -o ... | wc -l`.
- To parity-test: fetch `/api/events?city=X` from both servers for all 17 cities and compare `title|startDate` sets. Restart both first so caches are equally fresh, otherwise Eventbrite listings drift and look like diffs.
- Tool note: bash `/tmp` paths are not visible to Windows `node`; write temp files inside the project (and delete them) or use absolute Windows paths.

## 8. Next steps

1. **Primary sources for atl, mia, dc, det, oma.** Research per city using the strategy in section 6. Atlanta: `doatlanta.com` needs a bespoke parser. Each new source follows the Reno/Phoenix pattern (parser in both backends, add a `domain` in `CITIES`, route by `cityKey`).
2. **Toronto + Vancouver:** needs a Canadian weather backend first. Environment and Climate Change Canada's `citypage_weather` datamart (dd.weather.gc.ca) is feasible and structured (current conditions, warnings, forecast periods; Toronto site code `s0000458`). Files live in a rolling date/hour archive (`.../{date}/WXO-DD/citypage_weather/ON/{hour}/{timestamp}_MSC_CitypageWeather_s0000458_en.xml`, or a `/today/` alias), so it needs directory listing + latest-file selection instead of one stable URL. `siteList.xml` maps codes. `app.js`'s weather code is NWS-shaped and needs a provider switch. 19hz pages exist for both cities.
3. Small cleanups from section 7 (Reno entity decode, stale 8837 hint, optional Eventbrite city filtering).

## 9. How the owner likes to work

- Keep `server.js` and `serve.ps1` in behavioral parity; test both before deploying.
- Verify before building (real overlap, real data depth); report real findings, including when something turns out not to work.
- After pushing, poll the live site for a marker unique to the new deploy before calling it live.
- Commit messages explain the "why" and mention bugs found and fixed along the way.
- For large scope questions the owner gives short directional answers ("US cities first, Canada later", "build them with 19hz and we'll add more sources later"); follow those rather than re-asking.
