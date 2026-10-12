# Handoff: Travel Conditions and Events dashboard

## 1. What it is

A personal, single-page dashboard for one user (Mike) that shows, for a chosen US city:

- **Weather card:** current conditions, forecast, and active alerts (alert banner at top).
- **Events card:** upcoming events for today + tomorrow (or any date picked with the date input), with category tabs: All, Live Music, EDM, Comedy, Community, Sports, Food. Each event has a link (direct ticket link when the source provides one), a venue button that opens Google/Waze/Apple Maps directions, and a checkbox "I've got tickets".
- **My Tickets card:** events the user checked. Persisted in `localStorage` (`ticketedEvents`), with add-to-calendar buttons (Google, Outlook, and a server-generated `.ics` via `/api/ics` so Apple Calendar works on iPhone). The next ticketed event gets a pulsing yellow glow.
- **Header:** city picker (last city saved in `localStorage` as `cityKey`), clock, and "Now Playing / Next" ticker for the nearest events. Card titles share a "wavy hover" animation (`.wavy-text` class).

There are no accounts, no database and no auth. Everything is public data scraped or fetched on demand.

## 2. Stack

- **Frontend:** plain HTML/CSS/vanilla JS (`index.html`, `style.css`, `app.js`). No framework, no build step, no bundler.
- **Backend:** one Node.js file, `server.js`, using only built-ins (`http`, `fs`, `path`, global `fetch`). **Zero npm dependencies**; `package.json` only declares `node >=18` and `npm start` = `node server.js`.
- **Weather:** the US National Weather Service API (`api.weather.gov`: `/points`, forecast, nearest station observations, `/alerts/active`), called **directly from the browser** (CORS-enabled, no key). Refreshes every 10 min; events every 20 min.
- **Events:** scraped server-side (the sources are not CORS-enabled) and cached in memory. See section 5.
- **Local-dev mirror:** `serve.ps1` is a PowerShell re-implementation of `server.js` (the project started as PowerShell and was ported to Node so it could be deployed). It is **only** for local Windows testing.

## 3. Deployment

- **Where:** Render (free tier) at https://event-travel.onrender.com/ .
- **How:** the GitHub repo https://github.com/tripledeluxeind/event-travel.git is connected to Render; **every push to `main` auto-deploys** in roughly 1-3 minutes. Render runs `server.js` (`npm start`) and supplies `PORT`; the code reads `process.env.PORT`, defaulting to 8838. Render's dashboard settings (build/start command, plan) were set up earlier outside this session and were not re-checked; confirm there if something looks off.
- **Server timezone is UTC** (that mattered, see section 6). The server also serves `index.html`/`app.js`/`style.css` with `no-cache` headers.
- **Free-tier behavior to expect:** Render free instances normally spin down when idle, so the first request after a quiet period can be slow, and the in-memory event cache starts empty after each spin-up or deploy.
- **Verifying a deploy:** poll the live site for something unique to the change (e.g. a new city's `/api/events?city=xxx` or a changed value), not just a 200.
- **Local:** `node server.js` -> http://localhost:8838 ; or `serve.ps1` -> http://localhost:8837 (`start-server.ps1` / `stop-server.ps1` wrap it).
- **Git:** commits are authored as `Mike Bowen <tripledeluxeindustries@gmail.com>` (commits before Oct 12, 2026 used `mikeb@tacotimenw.com`). Commit trailer convention: `Co-Authored-By: Claude ...`. Git prints harmless LF/CRLF warnings on Windows.

## 4. Current status (as of last commit `7285e87`)

Everything below is shipped and live; working tree was clean.

**17 cities** (defined in `CITIES` in `app.js`; keys are used everywhere):

| Group | Cities | Primary event source | Also merged in |
|---|---|---|---|
| DoStuff Media | sea, pdx, atx, nyc, chi, den, bna, lax, bay, bos | `do206.com`, `dopdx.com`, `do512.com`, `donyc.com`, `do312.com`, `do303.com`, `do615.com`, `dolosangeles.com`, `dothebay.com`, `do617.com` | Eventbrite; 19hz (all except nyc, bna) |
| Bespoke primary | reno, phx | `therenoscene.com` (concerts only), `dtphx.org` | Eventbrite (reno); Eventbrite + 19hz (phx) |
| **No primary yet** | atl, mia, dc, det, oma | none | Eventbrite + 19hz only |

Recent history (newest first): `7285e87` fix evening "today's events vanished" bug; `9d3d3df` add Boston/Atlanta/Miami/DC/Detroit/Omaha; `b3383d8` extend 19hz EDM to all existing cities it covers; `37ed02a` EDM tab (Seattle); earlier: iOS calendar fix, tickets card, Comedy tab, direct ticket links, Eventbrite real-time parsing.

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
