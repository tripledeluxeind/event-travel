// Node.js port of serve.ps1 - same static file server + events proxy, just
// on a runtime that can actually be deployed somewhere (HttpListener needs
// Windows, which is why the original was PowerShell in the first place).
//
// Zero npm dependencies on purpose: Node 18+ ships a global fetch(), and
// everything else here is http/fs/path from the standard library - so
// deploying this anywhere just needs `node server.js`, no `npm install`.

const http = require("http");
const fs = require("fs");
const path = require("path");

const root = __dirname;
const port = process.env.PORT || 8838;

const MIME = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
};

// Fills in Sports/Food listings (thin-to-nonexistent on every primary
// source below, which are all nightlife/concert calendars) from Eventbrite.
// This fetch is kicked off in parallel with each primary source's own
// fetch (see getEventbriteBackfillPromise's callers) rather than after it,
// so it adds roughly max(primary, eventbrite) to a cold-cache page load
// instead of the sum of the two - flip to false to skip it entirely.
const ENABLE_EVENTBRITE_BACKFILL = true;

// ---- DoStuff Media events proxy (their JSON/HTML isn't CORS-enabled, so we
// fetch + parse it server-side). Same markup/URL pattern across every city on
// the network - only the domain changes. Keep this whitelist in sync with the
// CITIES list in app.js.

const CITY_DOMAINS = {
  sea: "do206.com", // Seattle
  pdx: "dopdx.com", // Portland
  atx: "do512.com", // Austin
  nyc: "donyc.com", // New York
  chi: "do312.com", // Chicago
  den: "do303.com", // Denver
  bna: "do615.com", // Nashville
  lax: "dolosangeles.com", // Los Angeles
  bay: "dothebay.com", // SF Bay Area
  // Cities with no DoStuff Media presence (reno, phx) are intentionally left
  // out - the request handler below returns an empty list for them rather
  // than silently substituting a different city's events.
};

// IANA timezones per city - kept in sync with the CITIES list in app.js.
// Used only to compute correct, DST-aware UTC offsets for Eventbrite's
// date-only entries.
const CITY_TZ = {
  sea: "America/Los_Angeles", pdx: "America/Los_Angeles", atx: "America/Chicago",
  nyc: "America/New_York", chi: "America/Chicago", den: "America/Denver",
  bna: "America/Chicago", lax: "America/Los_Angeles", bay: "America/Los_Angeles",
  reno: "America/Los_Angeles", phx: "America/Phoenix", // Arizona - no daylight saving
};

const eventsCache = new Map();
const eventsCacheTime = new Map();
const eventsCacheFailed = new Set();

// A cache entry from a fetch that failed (timeout, network error) is only
// trusted for a minute, instead of the source's normal 15-20 minute TTL.
// Sites like dothebay.com are usually fast but occasionally spike past the
// fetch timeout - without this, one slow response gets its resulting empty
// list cached for the full window, making that city look broken/stuck-empty
// for up to 20 minutes even though the site itself recovers within seconds.
function isCacheFresh(cacheKey, ttlMinutes) {
  if (!eventsCache.has(cacheKey)) return false;
  const effectiveTtl = eventsCacheFailed.has(cacheKey) ? 1 : ttlMinutes;
  const ageMs = Date.now() - eventsCacheTime.get(cacheKey);
  return ageMs < effectiveTtl * 60 * 1000;
}

function setEventsCache(cacheKey, parsed, fetchSucceeded) {
  eventsCache.set(cacheKey, parsed);
  eventsCacheTime.set(cacheKey, Date.now());
  if (fetchSucceeded) eventsCacheFailed.delete(cacheKey);
  else eventsCacheFailed.add(cacheKey);
}

// Fetches multiple URLs concurrently instead of one at a time. Every source
// below needs several fetches per request (DoStuff's today+tomorrow, dtphx's
// per-tag AJAX calls, the Eventbrite backfill's sports+food pages) - doing
// those sequentially was adding 3-7 SECONDS to a cold-cache page load, since
// each one is a full network round trip. Node's fetch() is non-blocking, so
// Promise.all is all that's needed here (the PowerShell original needed a
// whole runspace pool to get the same effect).
async function fetchUrlsParallel(urls) {
  const results = new Map();
  await Promise.all(
    urls.map(async (url) => {
      try {
        const res = await fetch(url, {
          headers: { "User-Agent": "Mozilla/5.0", Accept: "text/html" },
          signal: AbortSignal.timeout(15000),
        });
        results.set(url, res.ok ? await res.text() : null);
      } catch {
        results.set(url, null);
      }
    })
  );
  return results;
}

function htmlDecode(str) {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function parseDoStuffHtml(html) {
  const events = [];
  const startRe = /<div class="ds-listing event-card ds-event-category-(?<cat>[a-z-]+)" data-ds-ga-label="[^"]*" data-permalink="(?<permalink>[^"]+)"/g;
  const starts = [...html.matchAll(startRe)];
  for (let i = 0; i < starts.length; i++) {
    const m = starts[i];
    const blockStart = m.index;
    const blockEnd = i + 1 < starts.length ? starts[i + 1].index : Math.min(html.length, blockStart + 6000);
    const block = html.slice(blockStart, blockEnd);

    const titleMatch = block.match(/<span class="ds-listing-event-title-text" itemprop="name">(?<t>[^<]+)<\/span>/);
    if (!titleMatch) continue;

    const venueMatch = block.match(/<a href="\/venues\/[^"]*" itemprop="url"><span itemprop="name">(?<v>[^<]+)<\/span><\/a>/);
    const cityMatch = block.match(/<meta itemprop="addressLocality" content="(?<c>[^"]+)"/);
    const dateMatch = block.match(/<meta itemprop="startDate" datetime="(?<d>[^"]+)"/);
    const latMatch = block.match(/<meta itemprop="latitude" content="(?<lat>[^"]+)"/);
    const lonMatch = block.match(/<meta itemprop="longitude" content="(?<lon>[^"]+)"/);
    // DoStuff's own "Buy Tickets" button already points straight at the real
    // vendor (Ticketmaster, AXS, Dice, the venue's own site, etc., often via
    // an affiliate redirect) - it's embedded as a schema.org Offer right in
    // this same page, so linking to it costs nothing extra to fetch. Free/
    // RSVP events have no Offer at all, hence the fallback to the DoStuff
    // page elsewhere.
    const offerMatch = block.match(/<span itemprop="offers"[^>]*>\s*<meta itemprop="url" content="(?<u>[^"]+)"/);

    events.push({
      title: htmlDecode(titleMatch.groups.t.trim()),
      permalink: m.groups.permalink,
      venue: venueMatch ? htmlDecode(venueMatch.groups.v.trim()) : null,
      city: cityMatch ? cityMatch.groups.c : null,
      startDate: dateMatch ? dateMatch.groups.d : null,
      category: m.groups.cat,
      lat: latMatch ? parseFloat(latMatch.groups.lat) : null,
      lon: lonMatch ? parseFloat(lonMatch.groups.lon) : null,
      ticketUrl: offerMatch ? htmlDecode(offerMatch.groups.u) : null,
    });
  }
  return events;
}

function ymd(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// Fetches one or more days' pages for a domain, running only the actual
// cache misses in parallel (a specific-date lookup needs just one page; the
// default view needs today+tomorrow).
async function getDoStuffDaysEvents(domain, dates) {
  const cacheKeyFor = (d) => `${domain}|${ymd(d)}`;
  const urlFor = (d) => `https://${domain}/events/${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;

  const missing = dates.filter((d) => !isCacheFresh(cacheKeyFor(d), 15));

  if (missing.length > 0) {
    const htmlByUrl = await fetchUrlsParallel(missing.map(urlFor));
    for (const d of missing) {
      const html = htmlByUrl.get(urlFor(d));
      const parsed = html ? parseDoStuffHtml(html) : [];
      setEventsCache(cacheKeyFor(d), parsed, Boolean(html));
    }
  }

  return dates.flatMap((d) => eventsCache.get(cacheKeyFor(d)) || []);
}

async function getUpcomingEventsJson(domain, cityKey, specificDate) {
  // A specific date was requested from the Events panel's date picker -
  // fetch just that one day and keep only events that actually land on it
  // (this also naturally drops the recurring-series debut-date artifact
  // below, since a stale date won't match the requested one).
  if (specificDate) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(specificDate)) return [];
    const target = new Date(`${specificDate}T00:00:00`);
    if (isNaN(target)) return [];

    const [dayEvents, ebAll, hzAll] = await Promise.all([
      getDoStuffDaysEvents(domain, [target]),
      getEventbriteBackfillPromise(cityKey),
      get19hzBackfillPromise(cityKey),
    ]);
    const unique = dedupeByPermalink(dayEvents);
    let matching = unique.filter((e) => e.startDate && dateOnly(e.startDate) === specificDate);
    matching = mergeBackfillResults(matching, ebAll, specificDate, specificDate);
    matching = mergeBackfillResults(matching, hzAll, specificDate, specificDate);
    return sortByStartDate(matching);
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today.getTime() + 24 * 60 * 60 * 1000);
  const todayStr = ymd(today);
  const tomorrowStr = ymd(tomorrow);

  const [all, ebAll, hzAll] = await Promise.all([
    getDoStuffDaysEvents(domain, [today, tomorrow]),
    getEventbriteBackfillPromise(cityKey),
    get19hzBackfillPromise(cityKey),
  ]);
  let unique = dedupeByPermalink(all);

  // Some recurring/series listings carry their original debut date instead of
  // today's occurrence (e.g. a weekly series shows its season-opener date) -
  // drop anything dated before today so the list only shows real upcoming times.
  unique = unique.filter((e) => !e.startDate || new Date(e.startDate).getTime() >= today.getTime());

  unique = mergeBackfillResults(unique, ebAll, todayStr, tomorrowStr);
  unique = mergeBackfillResults(unique, hzAll, todayStr, tomorrowStr);
  return sortByStartDate(unique);
}

function dedupeByPermalink(rows) {
  const seen = new Map();
  for (const e of rows) {
    if (e.permalink && !seen.has(e.permalink)) seen.set(e.permalink, e);
  }
  return [...seen.values()];
}

function sortByStartDate(rows) {
  return [...rows].sort((a, b) => {
    const ta = a.startDate ? new Date(a.startDate).getTime() : Infinity;
    const tb = b.startDate ? new Date(b.startDate).getTime() : Infinity;
    return ta - tb;
  });
}

// Extracts the "yyyy-MM-dd" calendar date an ISO string falls on IN ITS OWN
// embedded offset, without ever converting through this server's local
// timezone - every startDate here always carries an explicit offset, so the
// date portion is just the first 10 characters, no Date-object math needed.
function dateOnly(iso) {
  if (!iso) return null;
  return iso.slice(0, 10);
}

// ---- therenoscene.com (Reno has no DoStuff Media site, so this is a
// bespoke parser for a different, non-CORS-enabled source). Its concert
// listing is a single ungrouped page rather than per-day URLs like DoStuff,
// with events grouped under a "dateBar" that only appears when the date
// changes, so parsing has to carry the current date forward row by row.
// Note the "www." - the bare domain points to an unrelated placeholder page.

const MONTHS_FULL = {
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5, july: 6,
  august: 7, september: 8, october: 9, november: 10, december: 11,
};

function parseRenoDateTime(dateText, timeText) {
  const dm = dateText.match(/(\w+)\s+(\d{1,2}),\s*(\d{4})/);
  if (!dm) return null;
  const month = MONTHS_FULL[dm[1].toLowerCase()];
  if (month === undefined) return null;
  const day = parseInt(dm[2], 10);
  const year = parseInt(dm[3], 10);

  const tm = timeText.match(/(\d{1,2}):(\d{2})\s*([AP]M)/i);
  if (!tm) return null;
  let hour = parseInt(tm[1], 10);
  const minute = parseInt(tm[2], 10);
  const ap = tm[3].toUpperCase();
  if (ap === "PM" && hour !== 12) hour += 12;
  if (ap === "AM" && hour === 12) hour = 0;

  const pad = (n) => String(n).padStart(2, "0");
  return `${year}-${pad(month + 1)}-${pad(day)}T${pad(hour)}:${pad(minute)}-07:00`;
}

function parseRenoSceneHtml(html) {
  const events = [];
  let currentDateText = null;
  const rowRe = /<div class="row ">/g;
  const rows = [...html.matchAll(rowRe)];
  for (let i = 0; i < rows.length; i++) {
    const blockStart = rows[i].index;
    const blockEnd = i + 1 < rows.length ? rows[i + 1].index : Math.min(html.length, blockStart + 3000);
    const block = html.slice(blockStart, blockEnd);

    const dateMatch = block.match(/<div class="dateBar">(?<d>[^<]+)<\/div>/);
    if (dateMatch) currentDateText = dateMatch.groups.d.trim();
    if (!currentDateText) continue;

    const titleMatch = block.match(/<h2 class="loopbands"><a href="(?<url>[^"]+)">(?<t>[^<]+)<\/a><\/h2>/);
    if (!titleMatch) continue;

    const venueMatch = block.match(/<span class="loopvenuename"><a href="[^"]*"[^>]*>(?<v>[^<]+)<\/a><\/span>/);
    const showMatch = block.match(/(?<time>\d{1,2}:\d{2}\s*[AP]M)\s*\(Show\)/);
    const doorMatch = block.match(/(?<time>\d{1,2}:\d{2}\s*[AP]M)\s*\(Doors\)/);
    const timeText = showMatch ? showMatch.groups.time : doorMatch ? doorMatch.groups.time : null;

    const startDate = timeText ? parseRenoDateTime(currentDateText, timeText) : null;

    events.push({
      title: htmlDecode(titleMatch.groups.t.trim()),
      permalink: titleMatch.groups.url.replace(/^https:\/\/www\.therenoscene\.com/, ""),
      venue: venueMatch ? htmlDecode(venueMatch.groups.v.trim()) : null,
      city: "Reno",
      startDate,
      category: "music",
      lat: null,
      lon: null,
    });
  }
  return events;
}

async function getRenoSceneEventsJson(specificDate) {
  // Started before the cache-freshness check below (and awaited later,
  // alongside whatever that check decides to do) so this runs concurrently
  // with the primary fetch instead of after it.
  const ebPromise = getEventbriteBackfillPromise("reno");

  const cacheKey = "therenoscene";
  if (!isCacheFresh(cacheKey, 20)) {
    let succeeded = false;
    let parsed = [];
    try {
      const res = await fetch("https://www.therenoscene.com/concerts-all-ages/", {
        headers: { "User-Agent": "Mozilla/5.0", Accept: "text/html" },
        signal: AbortSignal.timeout(15000),
      });
      const html = await res.text();
      parsed = parseRenoSceneHtml(html);
      succeeded = true;
    } catch {
      parsed = [];
    }
    setEventsCache(cacheKey, parsed, succeeded);
  }
  const cached = eventsCache.get(cacheKey) || [];

  if (specificDate) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(specificDate)) return [];
    let matching = cached.filter((e) => e.startDate && dateOnly(e.startDate) === specificDate);
    matching = mergeBackfillResults(matching, await ebPromise, specificDate, specificDate);
    return sortByStartDate(matching);
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayStr = ymd(today);
  const tomorrowStr = ymd(new Date(today.getTime() + 24 * 60 * 60 * 1000));

  // Concerts don't happen every day here like DoStuff cities' daily listings
  // do, so "today + tomorrow" would come up empty most nights - show every
  // upcoming show on the page instead, whatever span of days that covers.
  let upcoming = cached.filter((e) => e.startDate && new Date(e.startDate).getTime() >= today.getTime());
  // Reno's own concert list can span weeks, but the Eventbrite backfill only
  // needs to cover the same near-term window every other city gets - it's
  // there to fill a Sports/Food gap, not to extend the horizon.
  upcoming = mergeBackfillResults(upcoming, await ebPromise, todayStr, tomorrowStr);
  return sortByStartDate(upcoming);
}

// ---- dtphx.org (Downtown Phoenix Inc.'s events calendar - Phoenix has no
// DoStuff Media presence either). The site's calendar page filters by
// category client-side only (a "picnic-tag" widget with no server-rendered
// per-event category in the page source), but clicking a tag revealed the
// AJAX endpoint it actually calls - _picnic_list_ajax.php?ds=...&de=...&ti=
// (date range + tag id) - which returns the same .pcrd card markup as the
// main calendar page. That's used directly here, both for date-range
// filtering (sidestepping the main page's unreliable "today") and for
// splitting events into Concerts/Sports/Community by tag id.

const MONTHS_ABBR = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

function parseDtphxHtml(html, category = "community") {
  const events = [];
  const startRe = /<a class="pcrd" href="(?<permalink>[^"]+)">/g;
  const starts = [...html.matchAll(startRe)];
  for (let i = 0; i < starts.length; i++) {
    const m = starts[i];
    const blockStart = m.index;
    const blockEnd = i + 1 < starts.length ? starts[i + 1].index : Math.min(html.length, blockStart + 2000);
    const block = html.slice(blockStart, blockEnd);

    const titleMatch = block.match(/<div class="pcrd-content-headline">(?<t>[^<]+)<\/div>/);
    if (!titleMatch) continue;

    const venueMatch = block.match(/<div class="pcrd-content-venue"><span>.*?<\/span>(?<v>[^<]+)<\/div>/);
    const timeMatch = block.match(/<div class="pcrd-content-time"><span>.*?<\/span>\s*(?<time>[^<]+)<\/div>/);
    const dayMatch = block.match(/<div class="pcrd-date-day">(?<day>\d+)<\/div>/);
    const monthMatch = block.match(/<div class="pcrd-date-month">(?<month>[A-Za-z]+)<\/div>/);

    let startDate = null;
    if (dayMatch && monthMatch) {
      const monthNum = MONTHS_ABBR[monthMatch.groups.month.toLowerCase().slice(0, 3)];
      const day = parseInt(dayMatch.groups.day, 10);
      if (monthNum !== undefined) {
        const now = new Date();
        let year = now.getFullYear();
        let eventDate = new Date(Date.UTC(year, monthNum, day));
        // Cards never include a year - if that lands more than a month in the
        // past (e.g. a next7 page spanning a Dec->Jan year boundary), it
        // actually belongs to next year.
        const nowUtc = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
        if (eventDate.getTime() < nowUtc.getTime() - 30 * 24 * 60 * 60 * 1000) {
          eventDate = new Date(Date.UTC(year + 1, monthNum, day));
        }

        let hour = 0;
        let minute = 0;
        if (timeMatch) {
          // Some cards show a range ("10am - 5pm") - only the start time matters.
          const timeParse = timeMatch.groups.time.match(/(?<h>\d{1,2})(:(?<m>\d{2}))?\s*(?<ap>[AaPp][Mm])/);
          if (timeParse) {
            hour = parseInt(timeParse.groups.h, 10);
            minute = timeParse.groups.m ? parseInt(timeParse.groups.m, 10) : 0;
            const ap = timeParse.groups.ap.toLowerCase();
            if (ap === "pm" && hour !== 12) hour += 12;
            if (ap === "am" && hour === 12) hour = 0;
          }
        }
        const pad = (n) => String(n).padStart(2, "0");
        // Arizona doesn't observe daylight saving, so -07:00 is correct year-round.
        startDate = `${eventDate.getUTCFullYear()}-${pad(eventDate.getUTCMonth() + 1)}-${pad(eventDate.getUTCDate())}T${pad(hour)}:${pad(minute)}-07:00`;
      }
    }

    events.push({
      title: htmlDecode(titleMatch.groups.t.trim()),
      permalink: m.groups.permalink,
      venue: venueMatch ? htmlDecode(venueMatch.groups.v.trim()) : null,
      city: "Phoenix",
      startDate,
      category,
      lat: null,
      lon: null,
    });
  }
  return events;
}

// Tag ids from the site's own category picker (data-tagid on its picnic-tag
// elements). Everything that isn't Concerts, Sports, or Culinary is bucketed
// as "community" by subtraction below - there's no single "everything else" tag.
const DTPHX_TAG_IDS = { concerts: "7", sports: "36", food: "10" };

// Fetches all four of dtphx's tag-filtered views (Concerts/Sports/Food/
// everything) for a date range in parallel, running only the cache misses.
async function getDtphxEventsForRange(startDate, endDate) {
  const tags = [
    { tagId: DTPHX_TAG_IDS.concerts, category: "concerts" },
    { tagId: DTPHX_TAG_IDS.sports, category: "sports" },
    { tagId: DTPHX_TAG_IDS.food, category: "food" },
    { tagId: "", category: "community" },
  ];
  const urlFor = (t) => `https://dtphx.org/_templates/_picnic_list_ajax.php?ds=${startDate}&de=${endDate}&ti=${t.tagId}`;
  const cacheKeyFor = (t) => `dtphx|${startDate}|${endDate}|${t.tagId}`;

  const missing = tags.filter((t) => !isCacheFresh(cacheKeyFor(t), 15));

  if (missing.length > 0) {
    const htmlByUrl = await fetchUrlsParallel(missing.map(urlFor));
    for (const t of missing) {
      const html = htmlByUrl.get(urlFor(t));
      const parsed = html ? parseDtphxHtml(html, t.category) : [];
      setEventsCache(cacheKeyFor(t), parsed, Boolean(html));
    }
  }

  const byCategory = {};
  for (const t of tags) byCategory[t.category] = eventsCache.get(cacheKeyFor(t)) || [];

  const taggedPermalinks = new Set();
  for (const e of [...byCategory.concerts, ...byCategory.sports, ...byCategory.food]) {
    if (e.permalink) taggedPermalinks.add(e.permalink);
  }
  const community = byCategory.community.filter((e) => e.permalink && !taggedPermalinks.has(e.permalink));

  const combined = [...byCategory.concerts, ...byCategory.sports, ...byCategory.food, ...community];
  return dedupeByPermalink(combined);
}

async function getDtphxEventsJson(specificDate) {
  if (specificDate) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(specificDate)) return [];
    const [dayEvents, ebAll] = await Promise.all([
      getDtphxEventsForRange(specificDate, specificDate),
      getEventbriteBackfillPromise("phx"),
    ]);
    let matching = dayEvents.filter((e) => e.startDate && dateOnly(e.startDate) === specificDate);
    matching = mergeBackfillResults(matching, ebAll, specificDate, specificDate);
    return sortByStartDate(matching);
  }

  // dtphx's own "today" concept turned out to run a day ahead of Phoenix for
  // a chunk of every evening (likely a UTC-vs-Arizona mixup on their end),
  // which would silently drop every remaining event tonight. Sidestep that
  // entirely by computing Phoenix's real date ourselves (fixed UTC-7, no
  // daylight saving) and requesting that exact range - the same approach
  // already used for the DoStuff cities above, which never trust a site's
  // own "today" either.
  //
  // Reading the -7h-shifted instant back out via the UTC getters (not the
  // local ones) is what makes this immune to whatever timezone the server
  // itself happens to run in - it yields Arizona's actual wall-clock Y/M/D
  // regardless of host tz. That wall-clock date is then re-anchored to a
  // true UTC instant (UTC-7 => +7 hours) to get a real instant to compare
  // event timestamps against - mixing the two (comparing a true instant
  // against a "local-looking" one that was never converted back) is exactly
  // the kind of Kind-mismatch bug called out in getEventDateOnly's comment.
  const phoenixWallClock = new Date(Date.now() - 7 * 60 * 60 * 1000);
  const azYear = phoenixWallClock.getUTCFullYear();
  const azMonth = phoenixWallClock.getUTCMonth();
  const azDay = phoenixWallClock.getUTCDate();

  const todayStr = ymdUTC(new Date(Date.UTC(azYear, azMonth, azDay)));
  const tomorrowStr = ymdUTC(new Date(Date.UTC(azYear, azMonth, azDay + 1)));
  const azMidnightTodayInstantMs = Date.UTC(azYear, azMonth, azDay, 7, 0, 0);

  const [all, ebAll] = await Promise.all([
    getDtphxEventsForRange(todayStr, tomorrowStr),
    getEventbriteBackfillPromise("phx"),
  ]);
  let upcoming = all.filter((e) => !e.startDate || new Date(e.startDate).getTime() >= azMidnightTodayInstantMs);
  upcoming = mergeBackfillResults(upcoming, ebAll, todayStr, tomorrowStr);
  return sortByStartDate(upcoming);
}

function ymdUTC(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

// ---- Eventbrite backfill for Sports/Food ----
//
// Every primary source above is fundamentally a nightlife/concert calendar,
// so on any given day-or-two window Sports and Food listings are thin to
// nonexistent - that's real event density, not a scraping bug. Eventbrite's
// per-city, per-category browse pages ("/d/<state>--<city>/sports--events/")
// embed a JSON-LD ItemList with real event data (title, url, venue, lat/lon)
// that fills a lot of that gap. The one real limitation: that embedded data
// is date-only, with no time-of-day - so these entries are flagged
// hasTime=false and the client shows just a date for them, omitting a
// fabricated or misleading time.

const EVENTBRITE_CITY_SLUGS = {
  sea: "wa--seattle", pdx: "or--portland", atx: "tx--austin", nyc: "ny--new-york",
  chi: "il--chicago", den: "co--denver", bna: "tn--nashville", lax: "ca--los-angeles",
  bay: "ca--san-francisco", reno: "nv--reno", phx: "az--phoenix",
};

// Computes a real UTC offset (DST-aware) for a given IANA timezone at a
// given instant, using Intl - no external tz library needed.
function getUtcOffsetString(tz, date) {
  if (!tz) return "+00:00";
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "shortOffset" }).formatToParts(date);
    const tzName = parts.find((p) => p.type === "timeZoneName")?.value || "GMT+0";
    const m = tzName.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
    if (!m) return "+00:00";
    const hh = m[2].padStart(2, "0");
    const mm = (m[3] || "0").padStart(2, "0");
    return `${m[1]}${hh}:${mm}`;
  } catch {
    return "+00:00";
  }
}

// Finds `{...}` immediately after the first occurrence of `afterMarker`,
// scanning for the matching closing brace by depth-counting rather than a
// regex - the object is hundreds of KB of arbitrarily nested data, so a
// regex can't reliably tell where it actually ends. String contents are
// tracked (respecting \" escapes) so a stray { or } inside a title or
// description doesn't throw the count off.
function extractBalancedJson(text, afterMarker) {
  const markerIdx = text.indexOf(afterMarker);
  if (markerIdx === -1) return null;
  const start = text.indexOf("{", markerIdx + afterMarker.length);
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

// The page's SEO-facing JSON-LD only gives a bare date, no time - but the
// same page also embeds window.__SERVER_DATA__, the actual data its React
// frontend hydrates from, which carries the real start_time/end_time and
// each event's own IANA timezone directly (discovered by noticing an
// event's own Eventbrite page showed a specific time the browse page's
// JSON-LD didn't have). That eliminates the need for the hasTime=false
// date-only fallback for anything this shape covers.
function parseEventbriteJson(html, category, cityKey) {
  const jsonStr = extractBalancedJson(html, "__SERVER_DATA__");
  if (!jsonStr) return [];
  let data;
  try {
    data = JSON.parse(jsonStr);
  } catch {
    return [];
  }
  const results = data?.search_data?.events?.results;
  if (!Array.isArray(results)) return [];

  const events = [];
  const seenUrls = new Set();
  for (const item of results) {
    if (!item.start_date || !item.name || !item.url) continue;
    if (seenUrls.has(item.url)) continue;
    seenUrls.add(item.url);

    const tz = item.timezone || CITY_TZ[cityKey];
    const venue = item.primary_venue;
    const address = venue?.address;
    let startDate;
    let hasTime = true;
    if (item.start_time && /^\d{4}-\d{2}-\d{2}$/.test(item.start_date) && /^\d{2}:\d{2}/.test(item.start_time)) {
      const offsetStr = getUtcOffsetString(tz, new Date(`${item.start_date}T${item.start_time.slice(0, 5)}:00Z`));
      startDate = `${item.start_date}T${item.start_time.slice(0, 5)}${offsetStr}`;
    } else if (/^\d{4}-\d{2}-\d{2}$/.test(item.start_date)) {
      // Defensive fallback - every event sampled while building this had a
      // start_time, but fall back to date-only rather than dropping the
      // event entirely if a future one somehow doesn't.
      const offsetStr = getUtcOffsetString(tz, new Date(`${item.start_date}T00:00:00Z`));
      startDate = `${item.start_date}T00:00${offsetStr}`;
      hasTime = false;
    } else {
      continue;
    }

    events.push({
      title: item.name,
      permalink: item.url,
      venue: venue?.name || null,
      city: address?.city || null,
      startDate,
      category,
      lat: address?.latitude != null ? parseFloat(address.latitude) : null,
      lon: address?.longitude != null ? parseFloat(address.longitude) : null,
      ...(hasTime ? {} : { hasTime: false }),
    });
  }
  return events;
}

// Fetches the Sports and Food-and-drink browse pages for a city in
// parallel (only the ones not already cached).
async function getEventbriteEventsBatch(cityKey) {
  const slug = EVENTBRITE_CITY_SLUGS[cityKey];
  if (!slug) return [];

  const categories = [
    { slug: "sports", category: "sports" },
    { slug: "food-and-drink", category: "food" },
  ];
  const urlFor = (c) => `https://www.eventbrite.com/d/${slug}/${c.slug}--events/`;
  const cacheKeyFor = (c) => `eventbrite|${cityKey}|${c.slug}`;

  const missing = categories.filter((c) => !isCacheFresh(cacheKeyFor(c), 20));

  if (missing.length > 0) {
    const htmlByUrl = await fetchUrlsParallel(missing.map(urlFor));
    for (const c of missing) {
      const html = htmlByUrl.get(urlFor(c));
      const parsed = html ? parseEventbriteJson(html, c.category, cityKey) : [];
      setEventsCache(cacheKeyFor(c), parsed, Boolean(html));
    }
  }

  return categories.flatMap((c) => eventsCache.get(cacheKeyFor(c)) || []);
}

// Starts the Eventbrite fetch for a city. Call this *before* the primary
// source's own fetch (and await both together, e.g. via Promise.all) so the
// two run concurrently instead of back-to-back - awaiting this alone right
// away would serialize them again and reintroduce the doubled load time.
function getEventbriteBackfillPromise(cityKey) {
  if (!ENABLE_EVENTBRITE_BACKFILL) return Promise.resolve([]);
  if (!EVENTBRITE_CITY_SLUGS[cityKey]) return Promise.resolve([]);
  return getEventbriteEventsBatch(cityKey);
}

// Merges an already-fetched backfill source's events into a primary
// source's results for a given date range, skipping anything that's a
// same-title/same-day match for an event the primary source already has
// (cheap de-dup - permalinks never match across sources, so title+date is
// what's available). Shared by the Eventbrite Sports/Food backfill and the
// Seattle-only 19hz EDM backfill - safe to call more than once in a row
// (e.g. merge Eventbrite, then 19hz into the result of that), since each
// call recomputes existingKeys from whatever's been accumulated so far.
function mergeBackfillResults(existingEvents, freshAll, startDate, endDate) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) return existingEvents;

  const existingKeys = new Set();
  for (const e of existingEvents) {
    const d = dateOnly(e.startDate);
    if (e.title && d) existingKeys.add(`${e.title.toLowerCase().trim()}|${d}`);
  }

  const fresh = freshAll.filter((e) => {
    const d = dateOnly(e.startDate);
    if (!d) return false;
    if (d < startDate || d > endDate) return false;
    const key = `${e.title.toLowerCase().trim()}|${d}`;
    return !existingKeys.has(key);
  });

  return [...existingEvents, ...fresh];
}

// ---- 19hz.info (Seattle-only EDM/electronic backfill) ----
//
// Seattle's page lists two very different things in one table: real dated
// one-off shows (bare <tr>, with a hidden <div class='shrink'>YYYY/MM/DD</div>
// giving a clean machine-readable date) and recurring monthly/weekly club
// nights (<tr class='even'/'odd'>, dated only as text like "1st Mondays" -
// no calendar date at all). Only the former is usable here without building
// a whole recurrence-rule parser for informal English phrases, so rows
// without that shrink date (the recurring section) are simply skipped.
// Confirmed via a real overlap check that this is worth doing at all: some
// bigger shows (e.g. "Tape B") are already on do206.com too - mergeBackfillResults'
// title+date de-dup (already proven for the Eventbrite backfill) handles that.

const NINETEEN_HZ_SEATTLE_URL = "https://19hz.info/eventlisting_Seattle.php";

function parse19hzSeattleHtml(html) {
  const events = [];
  const startRe = /<tr><td>(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun): [A-Za-z]{3} \d{1,2}\s*<br\s*\/>\s*\(([^)]*)\)<\/td>/g;
  const starts = [...html.matchAll(startRe)];
  for (let i = 0; i < starts.length; i++) {
    const m = starts[i];
    const blockStart = m.index;
    const blockEnd = i + 1 < starts.length ? starts[i + 1].index : Math.min(html.length, blockStart + 2000);
    const block = html.slice(blockStart, blockEnd);

    const linkMatch = block.match(/<a href='(?<url>[^']+)'>(?<title>[^<]+)<\/a> @ (?<venue>[^<]+)<td>(?<genre>[^<]*)<\/td>/);
    if (!linkMatch) continue;

    // The recurring section (no shrink date) never reaches this far since
    // its rows have a different <tr> shape entirely, but skip defensively
    // if a row is somehow missing it rather than guessing a date.
    const dateMatch = block.match(/<div class='shrink'>(?<y>\d{4})\/(?<mo>\d{2})\/(?<d>\d{2})<\/div>/);
    if (!dateMatch) continue;

    let startDate = null;
    const timeParse = m[1].match(/(?<h>\d{1,2})(:(?<mn>\d{2}))?\s*(?<ap>[ap]m)/i);
    if (timeParse) {
      let hour = parseInt(timeParse.groups.h, 10);
      const minute = timeParse.groups.mn ? parseInt(timeParse.groups.mn, 10) : 0;
      const ap = timeParse.groups.ap.toLowerCase();
      if (ap === "pm" && hour !== 12) hour += 12;
      if (ap === "am" && hour === 12) hour = 0;
      const pad = (n) => String(n).padStart(2, "0");
      const { y, mo, d } = dateMatch.groups;
      // Anchored to a UTC instant on the right calendar day (not a naive
      // local-time string, which Node would parse using the *server's*
      // timezone rather than Seattle's) purely so getUtcOffsetString can
      // look up the correct PDT/PST offset for that date - same trick
      // already used for Eventbrite's date-only entries above.
      const referenceInstant = new Date(`${y}-${mo}-${d}T${pad(hour)}:${pad(minute)}:00Z`);
      const offsetStr = getUtcOffsetString("America/Los_Angeles", referenceInstant);
      startDate = `${y}-${mo}-${d}T${pad(hour)}:${pad(minute)}${offsetStr}`;
    }
    if (!startDate) continue;

    // "Venue Name (City, ST)" or "Venue Name (City)" - split when it
    // matches that shape, otherwise just use the whole thing as venue.
    let venue = linkMatch.groups.venue.trim();
    let city = null;
    const venueCityMatch = venue.match(/^(.*?)\s*\(([^,()]+)(?:,\s*[A-Z]{2})?\)$/);
    if (venueCityMatch) {
      venue = venueCityMatch[1].trim();
      city = venueCityMatch[2].trim();
    }

    events.push({
      title: htmlDecode(linkMatch.groups.title.trim()),
      permalink: linkMatch.groups.url,
      venue,
      city,
      startDate,
      category: "edm",
      lat: null,
      lon: null,
    });
  }
  return events;
}

async function get19hzSeattleEventsBatch() {
  const cacheKey = "19hz|seattle";
  if (!isCacheFresh(cacheKey, 20)) {
    let succeeded = false;
    let parsed = [];
    try {
      const res = await fetch(NINETEEN_HZ_SEATTLE_URL, {
        headers: { "User-Agent": "Mozilla/5.0", Accept: "text/html" },
        signal: AbortSignal.timeout(15000),
      });
      const html = await res.text();
      parsed = parse19hzSeattleHtml(html);
      succeeded = true;
    } catch {
      parsed = [];
    }
    setEventsCache(cacheKey, parsed, succeeded);
  }
  return eventsCache.get(cacheKey) || [];
}

function get19hzBackfillPromise(cityKey) {
  if (cityKey !== "sea") return Promise.resolve([]);
  return get19hzSeattleEventsBatch();
}

// ---- Add-to-calendar (.ics) ----
//
// Google/Outlook have their own "quick add" URLs the client can link to
// directly, but there's no such URL scheme for Apple Calendar - the only
// reliable cross-platform mechanism is a real .ics file. That used to be
// built client-side as a data: URI opened via a throwaway <a download>,
// but iOS Safari doesn't support the download attribute at all (a
// long-standing, well-documented gap), so tapping it silently did
// nothing on an iPhone. A genuine same-origin URL serving real
// Content-Type/Content-Disposition headers is what actually works there,
// so this builds the .ics server-side instead and the client just links
// to it like any other URL.

function icsUtcStamp(date) {
  return date.toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
}

function icsEscape(str) {
  return String(str).replace(/([,;\\])/g, "\\$1");
}

// Nothing tracks a real event *end* time (most sources never give one),
// so this assumes a 2-hour block from the known start - an approximation,
// but a far better default than a zero-length calendar event.
function buildIcsContent(params) {
  const title = params.get("title") || "Event";
  const venue = params.get("venue") || "";
  const key = params.get("key") || title;
  const start = new Date(params.get("start"));
  if (isNaN(start)) return null;
  const end = new Date(start.getTime() + 2 * 60 * 60 * 1000);

  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Travel Conditions and Events//EN",
    "BEGIN:VEVENT",
    `UID:${encodeURIComponent(key)}@travel-conditions-events`,
    `DTSTAMP:${icsUtcStamp(new Date())}`,
    `DTSTART:${icsUtcStamp(start)}`,
    `DTEND:${icsUtcStamp(end)}`,
    `SUMMARY:${icsEscape(title)}`,
    venue ? `LOCATION:${icsEscape(venue)}` : null,
    "END:VEVENT",
    "END:VCALENDAR",
  ].filter(Boolean).join("\r\n");
}

// ---- static file + API server ----

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;

    if (pathname === "/api/ics") {
      const ics = buildIcsContent(url.searchParams);
      if (!ics) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("Invalid event data");
        return;
      }
      const filename = `${(url.searchParams.get("title") || "event").replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.ics`;
      res.writeHead(200, {
        "Content-Type": "text/calendar; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
      });
      res.end(ics);
      return;
    }

    if (pathname === "/api/events") {
      const cityKey = url.searchParams.get("city");
      const specificDate = url.searchParams.get("date");
      const domain = CITY_DOMAINS[cityKey];

      let rows;
      if (cityKey === "reno") {
        rows = await getRenoSceneEventsJson(specificDate);
      } else if (cityKey === "phx") {
        rows = await getDtphxEventsJson(specificDate);
      } else if (domain) {
        rows = await getUpcomingEventsJson(domain, cityKey, specificDate);
      } else {
        rows = [];
      }

      const body = JSON.stringify(rows);
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      });
      res.end(body);
      return;
    }

    let filePath = pathname === "/" ? "/index.html" : pathname;
    filePath = path.join(root, filePath.replace(/^\/+/, ""));

    // Guard against path traversal escaping the project root.
    if (!filePath.startsWith(root)) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }

    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end(`Not found: ${pathname}`);
        return;
      }
      const ext = path.extname(filePath);
      res.writeHead(200, {
        "Content-Type": MIME[ext] || "application/octet-stream",
        // This is a dev server that gets edited often - never let the
        // browser cache index.html/app.js/style.css across reloads, or a
        // code change can look like it "didn't work" when it's just stale.
        "Cache-Control": "no-cache, no-store, must-revalidate",
        Pragma: "no-cache",
      });
      res.end(data);
    });
  } catch (err) {
    console.error(`Request error (${req.url}):`, err);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Internal server error");
    }
  }
});

server.listen(port, () => {
  console.log(`Serving ${root} on http://localhost:${port}/`);
});
