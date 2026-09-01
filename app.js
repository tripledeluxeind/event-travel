// Seattle Travel Conditions and Events — weather + events.
// All data comes from free public endpoints, fetched client-side (events go
// through the local proxy in serve.ps1 since do206.com has no CORS support).

// Keep `domain` in sync with $CityDomains in serve.ps1 for DoStuff Media
// cities. A city with no scrapable source at all can omit `domain` and set
// `eventsUrl` instead - the Events panel falls back to a link-out rather
// than pretending to have a live feed.
const CITIES = [
  { key: "sea",  name: "Seattle, WA",     lat: 47.6062, lon: -122.3321, tz: "America/Los_Angeles", domain: "do206.com" },
  { key: "pdx",  name: "Portland, OR",    lat: 45.5152, lon: -122.6784, tz: "America/Los_Angeles", domain: "dopdx.com" },
  { key: "atx",  name: "Austin, TX",      lat: 30.2672, lon: -97.7431,  tz: "America/Chicago",     domain: "do512.com" },
  { key: "nyc",  name: "New York, NY",    lat: 40.7128, lon: -74.0060,  tz: "America/New_York",    domain: "donyc.com" },
  { key: "chi",  name: "Chicago, IL",     lat: 41.8781, lon: -87.6298,  tz: "America/Chicago",     domain: "do312.com" },
  { key: "den",  name: "Denver, CO",      lat: 39.7392, lon: -104.9903, tz: "America/Denver",      domain: "do303.com" },
  { key: "bna",  name: "Nashville, TN",   lat: 36.1627, lon: -86.7816,  tz: "America/Chicago",     domain: "do615.com" },
  { key: "lax",  name: "Los Angeles, CA", lat: 34.0522, lon: -118.2437, tz: "America/Los_Angeles", domain: "dolosangeles.com" },
  { key: "bay",  name: "SF Bay Area, CA", lat: 37.7749, lon: -122.4194, tz: "America/Los_Angeles", domain: "dothebay.com" },
  { key: "reno", name: "Reno, NV",        lat: 39.5296, lon: -119.8138, tz: "America/Los_Angeles", domain: "www.therenoscene.com" },
  // Arizona doesn't observe daylight saving, so America/Phoenix is a fixed
  // UTC-7 year-round - unlike every other tz in this list.
  { key: "phx",  name: "Phoenix, AZ",     lat: 33.4484, lon: -112.0740, tz: "America/Phoenix",     domain: "dtphx.org" },
];

function loadSavedCity() {
  const savedKey = localStorage.getItem("cityKey");
  return CITIES.find(c => c.key === savedKey) || CITIES[0];
}

let currentCity = loadSavedCity();

// Switching cities aborts whatever's still in flight for the previous one -
// otherwise a slow, late-arriving response can land after the new city's
// data has already rendered and silently overwrite it.
let cityAbortController = new AbortController();

// Last fetched default-view (no specific date picked) events, re-filtered
// on a timer so the header teaser advances to the next event as time
// passes, without waiting for the next full events refresh.
let lastUpcomingRows = [];

// When set (via the date picker in the Events header), overrides the
// default "upcoming" window and asks the server for just that one day.
let selectedEventDate = null;

// The full set of events from the last successful fetch, before the
// category tab filter is applied - lets a tab click re-render instantly
// from what's already in memory instead of re-fetching.
let currentEventsRows = [];
let selectedCategory = "all";

// Every source reports its own raw category vocabulary (DoStuff's dozens of
// per-city genre slugs, dtphx's own tag ids already normalized server-side
// to "concerts"/"sports"/"food"/"community", Reno's single always-"music"
// value) - this collapses all of it down to the tabs in the Events card.
function normalizeCategory(raw) {
  const c = (raw || "").toLowerCase();
  if (c === "concerts" || c === "sports" || c === "food" || c === "comedy" || c === "community") return c;
  if (/sport/.test(c)) return "sports";
  if (/food|drink|culinary|happy-hour/.test(c)) return "food";
  if (/comedy|improv/.test(c)) return "comedy";
  if (/music|concert|\bdj\b/.test(c)) return "concerts";
  return "community";
}

function eventsEndpoint() {
  const url = `/api/events?city=${currentCity.key}`;
  return selectedEventDate ? `${url}&date=${selectedEventDate}` : url;
}

const REFRESH = {
  weather: 10 * 60 * 1000,
  events: 20 * 60 * 1000,
  clockTick: 1000,
  agoTick: 30 * 1000,
};

const lastUpdated = { weather: null, events: null };

function setUpdated(key) {
  lastUpdated[key] = new Date();
}

function relativeTime(date) {
  if (!date) return "—";
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 15) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

function refreshAgoLabels() {
  document.getElementById("weather-updated").textContent = relativeTime(lastUpdated.weather);
  document.getElementById("events-updated").textContent = relativeTime(lastUpdated.events);
  // Re-filter (no refetch) so the teasers advance as soon as an event's
  // start time passes, and the events list drops things that just aged
  // out, without waiting on the next data load.
  updateNowPlayingTeaser(lastUpcomingRows);
  updateNextEventTeaser(lastUpcomingRows);
  renderEventsList(currentEventsRows);
}

function tickClock() {
  const now = new Date();
  const tz = currentCity.tz;
  document.getElementById("date").textContent = now.toLocaleDateString("en-US", {
    timeZone: tz,
    weekday: "short",
    month: "short",
    day: "numeric",
  });
  document.getElementById("clock").textContent = now.toLocaleTimeString("en-US", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function showError(bodyId, message) {
  document.getElementById(bodyId).innerHTML = `<div class="error">${message}</div>`;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function parseWindMph(str) {
  if (!str) return null;
  const m = String(str).match(/(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

// Not an official road-conditions feed (WSDOT's has no CORS support for
// browser fetches) - this infers likely conditions from temperature,
// forecast text, precipitation chance, wind, and any active NWS alerts.
// Treat it as a heads-up, not a substitute for WSDOT/511.
function estimateRoadConditions({ tempF, forecastText, precipChance, windMph, alertEvents }) {
  const notes = [];
  const text = (forecastText || "").toLowerCase();
  const events = alertEvents || [];

  const iceAlert = events.find(ev => /ice|winter storm|winter weather|freezing rain/i.test(ev));
  const snowAlert = events.find(ev => /snow/i.test(ev));

  if (iceAlert) {
    notes.push({ level: "danger", text: `${iceAlert} in effect — expect icy, hazardous roads` });
  } else if (snowAlert) {
    notes.push({ level: "danger", text: `${snowAlert} in effect — snow-covered roads likely` });
  } else if (tempF != null && tempF <= 34 && (precipChance >= 30 || /rain|snow|sleet|drizzle/.test(text))) {
    notes.push({ level: "danger", text: "Near/below freezing with moisture in the forecast — icy or slick spots possible" });
  } else if (/snow/.test(text)) {
    notes.push({ level: "danger", text: "Snow expected — slushy or snow-covered roads possible" });
  } else if (/rain|showers|thunderstorm/.test(text) || (precipChance != null && precipChance >= 50)) {
    notes.push({ level: "warn", text: "Wet roads likely — reduced traction, allow extra stopping distance" });
  }

  const fogAlert = events.find(ev => /fog/i.test(ev));
  if (fogAlert || /fog/.test(text)) {
    notes.push({ level: "warn", text: "Patchy fog may reduce visibility" });
  }

  const windAlert = events.find(ev => /wind/i.test(ev));
  if (windAlert || (windMph != null && windMph >= 25)) {
    notes.push({ level: "warn", text: "High winds — use caution on bridges and open roadways" });
  }

  if (notes.length === 0) {
    notes.push({ level: "ok", text: "Roads likely dry — no weather-related hazards expected" });
  }
  return notes;
}

function worstLevel(notes) {
  if (notes.some(n => n.level === "danger")) return "danger";
  if (notes.some(n => n.level === "warn")) return "warn";
  return "ok";
}

function travelLevelLabel(level) {
  if (level === "danger") return "Hazardous travel conditions";
  if (level === "warn") return "Use caution";
  return "Good travel conditions";
}

// ---------- Weather ----------

async function loadWeather() {
  const signal = cityAbortController.signal;
  try {
    const { lat, lon } = currentCity;
    const point = await fetchJSON(
      `https://api.weather.gov/points/${lat},${lon}`,
      signal
    );
    const { forecast, observationStations } = point.properties;

    const [forecastData, stations, alertsData] = await Promise.all([
      fetchJSON(forecast, signal),
      fetchJSON(observationStations, signal),
      fetchJSON(`https://api.weather.gov/alerts/active?point=${lat},${lon}`, signal),
    ]);

    renderAlerts(alertsData);

    const periods = forecastData.properties.periods;
    const now = periods[0];
    const upcoming = periods.slice(1, 5);

    let current = null;
    const stationUrl = stations.features?.[0]?.id;
    if (stationUrl) {
      try {
        const obs = await fetchJSON(`${stationUrl}/observations/latest`, signal);
        current = obs.properties;
      } catch (e) {
        // fall back to forecast-only view below
      }
    }

    const tempF = current?.temperature?.value != null
      ? Math.round(current.temperature.value * 9 / 5 + 32)
      : now.temperature;

    const humidity = current?.relativeHumidity?.value != null
      ? Math.round(current.relativeHumidity.value)
      : null;

    const windSpeed = current?.windSpeed?.value != null
      ? Math.round(current.windSpeed.value * 2.237) // m/s -> mph
      : null;

    const windMph = windSpeed != null ? windSpeed : parseWindMph(now.windSpeed);
    const alertEvents = (alertsData?.features || []).map(f => f.properties.event);
    const roadNotes = estimateRoadConditions({
      tempF,
      forecastText: `${now.shortForecast} ${now.detailedForecast || ""}`,
      precipChance: now.probabilityOfPrecipitation?.value ?? null,
      windMph,
      alertEvents,
    });
    const travelLevel = worstLevel(roadNotes);
    const travelDetail = roadNotes.map(n => n.text).join(" · ");

    const html = `
      <div class="wx-now">
        <img class="wx-icon" src="${now.icon}" alt="${now.shortForecast}">
        <div>
          <div class="wx-temp">${tempF}°F</div>
          <div class="wx-desc">${now.shortForecast}</div>
        </div>
      </div>
      <div class="wx-meta">
        <div><span class="label">Wind</span>${windSpeed != null ? windSpeed + " mph" : now.windSpeed}</div>
        <div><span class="label">Humidity</span>${humidity != null ? humidity + "%" : "—"}</div>
        <div><span class="label">Direction</span>${current?.windDirection?.value != null ? current.windDirection.value + "°" : now.windDirection}</div>
      </div>
      <div class="wx-forecast">
        ${upcoming.map(p => `<div><strong>${p.name}:</strong> ${p.temperature}°${p.temperatureUnit} — ${p.shortForecast}</div>`).join("")}
      </div>
      <div class="wx-road">
        <div class="wx-road-title">Estimated Travel Conditions Right Now</div>
        <div class="travel-box level-${travelLevel}">
          <span class="travel-light level-${travelLevel}"></span>
          <div class="travel-box-text">
            <div class="travel-box-title">${travelLevelLabel(travelLevel)}</div>
            <div class="travel-box-detail">${escapeHtml(travelDetail)}</div>
          </div>
        </div>
        <div class="wx-road-disclaimer">Estimated from the forecast, not a live road sensor feed — check your local DOT/511 before you head out.</div>
      </div>
    `;
    document.getElementById("weather-body").innerHTML = html;
    setUpdated("weather");
    refreshAgoLabels();
  } catch (err) {
    if (err.name === "AbortError") return; // superseded by a city switch
    console.error(err);
    showError("weather-body", "Couldn't load weather right now. Retrying soon.");
  }
}

function renderAlerts(alertsData) {
  const banner = document.getElementById("alert-banner");
  const features = alertsData?.features || [];
  if (features.length === 0) {
    banner.classList.add("hidden");
    banner.textContent = "";
    return;
  }
  const headlines = features
    .slice(0, 3)
    .map(f => f.properties.headline)
    .join("  •  ");
  banner.textContent = `⚠ ${headlines}`;
  banner.classList.remove("hidden");
}

// ---------- Events ----------

// Event timestamps must always be read in the selected city's own timezone,
// not the browser's - otherwise a Denver event's time only matches the
// (correctly city-aware) clock if you happen to be sitting in Mountain time.
// hasTime=false is for sources that only give a date, no time-of-day (e.g.
// the Eventbrite backfill) - showing a fabricated or misleading time would
// be worse than just omitting it, so those just render the day.
function fmtEventWhen(iso, hasTime = true) {
  if (!iso) return "Time TBD";
  const tz = currentCity.tz;
  const d = new Date(iso);
  const now = new Date();
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const dateKey = date => date.toLocaleDateString("en-CA", { timeZone: tz });

  const isToday = dateKey(d) === dateKey(now);
  const isTomorrow = dateKey(d) === dateKey(tomorrow);

  const day = isToday
    ? "Today"
    : isTomorrow
      ? "Tomorrow"
      : d.toLocaleDateString("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric" });
  if (!hasTime) return day;

  const time = d.toLocaleTimeString("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" });
  return `${day} · ${time}`;
}

function fmtNextEventTime(iso, hasTime = true) {
  if (!iso || !hasTime) return "";
  return new Date(iso).toLocaleTimeString("en-US", { timeZone: currentCity.tz, hour: "numeric", minute: "2-digit" });
}

// Most sources give a permalink relative to the city's domain; the
// Eventbrite backfill gives a full absolute URL on a different domain, so
// this only prefixes when the permalink isn't already a complete URL.
function eventLink(e) {
  const baseUrl = `https://${currentCity.domain}`;
  if (!e.permalink) return `${baseUrl}/events`;
  return /^https?:\/\//i.test(e.permalink) ? e.permalink : `${baseUrl}${e.permalink}`;
}

// Renders a teaser row as a fixed-width viewport with a static label, so
// the row's footprint never grows into the header text on the left. If the
// content is too wide to fit, it's duplicated and scrolled as a looping
// ticker instead of being cut off with an ellipsis.
//
// Skips re-rendering (and thus restarting the animation) when the content
// hasn't actually changed - this function is called every 30s by the
// ago-label tick, and rebuilding the DOM each time would yank a scrolling
// ticker back to its start every 30s, making it look like it stutters.
function setTeaserContent(el, label, contentHtml) {
  if (el.dataset.content === (contentHtml || "")) return;
  el.dataset.content = contentHtml || "";
  el.classList.remove("scrolling");
  if (!contentHtml) {
    el.innerHTML = "";
    return;
  }
  el.innerHTML = `<span class="teaser-label">${label}</span><span class="teaser-viewport"><span class="teaser-track">${contentHtml}</span></span>`;

  requestAnimationFrame(() => {
    const viewport = el.querySelector(".teaser-viewport");
    const track = el.querySelector(".teaser-track");
    if (!viewport || !track) return;
    const overflow = track.scrollWidth - viewport.clientWidth;
    if (overflow > 4) {
      // The loop must jump from -50% back to 0% without a visible seam. That
      // only lines up if the track is exactly two identical (content + gap)
      // segments back to back, so 50% of the track's own width lands exactly
      // on the start of the second copy - a gap only between the two copies
      // (not after the second one too) would make 50% land short of that by
      // half a gap-width, causing a little jump every loop.
      const pxPerSecond = 40;
      track.innerHTML = `${contentHtml}<span class="teaser-gap"></span>${contentHtml}<span class="teaser-gap"></span>`;
      // The animation only travels 50% of the (now-doubled) track's width per
      // loop, so base the duration on half its width to keep a steady speed.
      track.style.animationDuration = `${Math.max(8, track.scrollWidth / 2 / pxPerSecond)}s`;
      el.classList.add("scrolling");
    }
  });
}

function teaserEventLink(e) {
  return `<a href="${eventLink(e)}" target="_blank" rel="noopener">${escapeHtml(e.title)}</a>`;
}

// Shows whichever event(s) most recently started (i.e. the latest startDate
// that's still <= now) - if more than one event shares that exact start
// time, they're all listed, comma-separated, rather than picking one.
function updateNowPlayingTeaser(rows) {
  const el = document.getElementById("now-playing");
  const now = new Date();
  const past = (rows || []).filter(row => row.startDate && new Date(row.startDate) <= now);
  if (!past.length) {
    el.innerHTML = "";
    return;
  }
  const latest = past.reduce((max, row) => Math.max(max, new Date(row.startDate).getTime()), -Infinity);
  const current = past.filter(row => new Date(row.startDate).getTime() === latest);

  const links = current.map(teaserEventLink).join(", ");
  const time = fmtNextEventTime(current[0].startDate, current[0].hasTime !== false);
  setTeaserContent(el, "Now Playing:", `${links}${time ? ` @ ${time}` : ""}`);
}

// The header teaser always reflects the true next upcoming event, so it
// only updates from the default (no specific date picked) events fetch -
// browsing a different day in the Events card shouldn't change it.
function updateNextEventTeaser(rows) {
  const el = document.getElementById("next-event");
  // rows includes today's full schedule (past and future) since the events
  // list filters by day, not by time - the teaser needs the first one that
  // hasn't actually started yet, not just the first item in the list.
  const now = new Date();
  const e = (rows || []).find(row => row.startDate && new Date(row.startDate) > now);
  if (!e) {
    el.innerHTML = "";
    return;
  }
  const time = fmtNextEventTime(e.startDate, e.hasTime !== false);
  setTeaserContent(el, "Next:", `${teaserEventLink(e)}${time ? ` @ ${time}` : ""}`);
}

function fmtSelectedDate(isoDate) {
  // isoDate is "YYYY-MM-DD" from <input type="date">; parse as local, not UTC.
  const [y, m, d] = isoDate.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function directionsLinks(e) {
  const place = [e.venue, e.city].filter(Boolean).join(", ");
  const hasCoords = typeof e.lat === "number" && typeof e.lon === "number";

  const fallbackPlace = place || currentCity.name;
  const gmapsUrl = hasCoords
    ? `https://www.google.com/maps/dir/?api=1&destination=${e.lat},${e.lon}`
    : `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(fallbackPlace)}`;

  const wazeUrl = hasCoords
    ? `https://waze.com/ul?ll=${e.lat},${e.lon}&navigate=yes`
    : `https://waze.com/ul?q=${encodeURIComponent(fallbackPlace)}&navigate=yes`;

  const appleUrl = hasCoords
    ? `https://maps.apple.com/?daddr=${e.lat},${e.lon}&dirflg=d`
    : `https://maps.apple.com/?daddr=${encodeURIComponent(fallbackPlace)}&dirflg=d`;

  return { gmapsUrl, wazeUrl, appleUrl, place };
}

// Once a today-dated event is over an hour past its start, it's clutter -
// drop it from the list rather than leaving the whole day's schedule
// visible forever. Skip this for anything without a real known time
// (Time TBD, or the Eventbrite backfill's date-only entries anchored at
// midnight) since there's no actual start time to judge staleness against.
function isStaleToday(e) {
  if (!e.startDate || e.hasTime === false) return false;
  const tz = currentCity.tz;
  const d = new Date(e.startDate);
  const now = new Date();
  const dateKey = date => date.toLocaleDateString("en-CA", { timeZone: tz });
  if (dateKey(d) !== dateKey(now)) return false;
  return now.getTime() - d.getTime() > 60 * 60 * 1000;
}

// Renders whatever's currently in currentEventsRows, filtered to the active
// category tab - called both after a fresh fetch and on a tab click, so a
// tab switch never needs to hit the network again.
function renderEventsList(rows) {
  const baseUrl = `https://${currentCity.domain}`;
  const current = rows.filter(e => !isStaleToday(e));
  const filtered = selectedCategory === "all"
    ? current
    : current.filter(e => normalizeCategory(e.category) === selectedCategory);

  if (!filtered.length) {
    const dateNote = selectedEventDate ? ` for ${fmtSelectedDate(selectedEventDate)}` : "";
    const activeTab = document.querySelector(`.events-tab[data-cat="${selectedCategory}"]`);
    const categoryNote = selectedCategory !== "all" && activeTab ? ` in ${activeTab.textContent}` : "";
    document.getElementById("events-body").innerHTML =
      `<div class="empty-state">No events found${dateNote}${categoryNote}. <a class="ext-link" href="${baseUrl}/events" target="_blank" rel="noopener">Browse ${escapeHtml(currentCity.domain)} ↗</a></div>`;
    return;
  }

  document.getElementById("events-body").innerHTML = filtered
    .map(e => {
      const { gmapsUrl, wazeUrl, appleUrl, place } = directionsLinks(e);

      return `
        <div class="list-item">
          <div class="title"><a class="ext-link" href="${eventLink(e)}" target="_blank" rel="noopener">${escapeHtml(e.title)}</a></div>
          <div class="sub">
            <span class="badge">${fmtEventWhen(e.startDate, e.hasTime !== false)}</span>
            <button type="button" class="badge accent2 venue-btn"
              data-gmaps="${escapeHtml(gmapsUrl)}"
              data-waze="${escapeHtml(wazeUrl)}"
              data-apple="${escapeHtml(appleUrl)}">
              📍 ${escapeHtml(place || currentCity.name)} ▾
            </button>
          </div>
        </div>`;
    })
    .join("");
}

async function loadEvents() {
  if (!currentCity.domain) {
    document.getElementById("events-body").innerHTML =
      `<div class="empty-state">No live event feed for ${escapeHtml(currentCity.name)} yet.<br><a class="ext-link" href="${currentCity.eventsUrl}" target="_blank" rel="noopener">Browse local events ↗</a></div>`;
    lastUpcomingRows = [];
    currentEventsRows = [];
    setTeaserContent(document.getElementById("now-playing"), "", "");
    setTeaserContent(document.getElementById("next-event"), "", "");
    setUpdated("events");
    refreshAgoLabels();
    return;
  }

  const signal = cityAbortController.signal;
  const baseUrl = `https://${currentCity.domain}`;
  try {
    const rows = await fetchJSON(eventsEndpoint(), signal);
    if (!selectedEventDate) {
      lastUpcomingRows = rows;
      updateNowPlayingTeaser(rows);
      updateNextEventTeaser(rows);
    }
    currentEventsRows = rows;
    renderEventsList(rows);
    setUpdated("events");
    refreshAgoLabels();
  } catch (err) {
    if (err.name === "AbortError") return; // superseded by a city switch
    console.error(err);
    const hint = location.protocol === "file:"
      ? `This page was opened as a local file (${location.href}). Events need serve.ps1 - open <strong>http://localhost:8837</strong> in your browser instead of double-clicking index.html.`
      : "Live event list needs the local server (serve.ps1) running. Start it, then reload this page.";
    document.getElementById("events-body").innerHTML =
      `<div class="empty-state">${hint}<br><a class="ext-link" href="${baseUrl}/events" target="_blank" rel="noopener">Browse events on ${escapeHtml(currentCity.domain)} ↗</a></div>`;
  }
}

// ---------- Popover helpers (shared by the nav picker and city picker) ----------

function positionPopoverNear(popoverEl, anchorEl) {
  const rect = anchorEl.getBoundingClientRect();
  const pw = popoverEl.offsetWidth;
  const ph = popoverEl.offsetHeight;
  let left = rect.left;
  let top = rect.bottom + 6;
  if (left + pw > window.innerWidth - 8) left = window.innerWidth - pw - 8;
  if (top + ph > window.innerHeight - 8) top = rect.top - ph - 6;
  popoverEl.style.left = `${Math.max(8, left)}px`;
  popoverEl.style.top = `${Math.max(8, top)}px`;
}

// ---------- Navigation app picker ----------

let navPickerEl = null;
let activeVenueBtn = null;

function initNavPicker() {
  navPickerEl = document.createElement("div");
  navPickerEl.id = "nav-picker";
  navPickerEl.className = "nav-picker hidden";
  navPickerEl.setAttribute("role", "menu");
  navPickerEl.innerHTML = `
    <button type="button" data-key="gmaps" role="menuitem">Google Maps</button>
    <button type="button" data-key="waze" role="menuitem">Waze</button>
    <button type="button" data-key="apple" role="menuitem">Apple Maps</button>
  `;
  document.body.appendChild(navPickerEl);

  navPickerEl.addEventListener("click", ev => {
    const btn = ev.target.closest("button[data-key]");
    if (!btn) return;
    const url = navPickerEl.dataset[btn.dataset.key];
    if (url) window.open(url, "_blank", "noopener");
    hideNavPicker();
  });

  document.getElementById("events-body").addEventListener("click", ev => {
    const btn = ev.target.closest(".venue-btn");
    if (!btn) return;
    ev.stopPropagation();
    toggleNavPicker(btn);
  });

  document.addEventListener("click", ev => {
    if (navPickerEl.classList.contains("hidden")) return;
    if (ev.target.closest("#nav-picker")) return;
    hideNavPicker();
  });

  document.addEventListener("keydown", ev => {
    if (ev.key === "Escape") hideNavPicker();
  });

  window.addEventListener("scroll", hideNavPicker, true);
  window.addEventListener("resize", hideNavPicker);
}

function hideNavPicker() {
  if (!navPickerEl) return;
  navPickerEl.classList.add("hidden");
  activeVenueBtn = null;
}

function toggleNavPicker(btn) {
  if (activeVenueBtn === btn && !navPickerEl.classList.contains("hidden")) {
    hideNavPicker();
    return;
  }
  activeVenueBtn = btn;
  navPickerEl.dataset.gmaps = btn.dataset.gmaps;
  navPickerEl.dataset.waze = btn.dataset.waze;
  navPickerEl.dataset.apple = btn.dataset.apple;
  navPickerEl.classList.remove("hidden");
  positionPopoverNear(navPickerEl, btn);
}

// ---------- City picker ----------

let cityPickerEl = null;

function renderWavyText(name) {
  const drips = [0, 1, 2].map(d => `<span class="drip" style="--d:${d}"></span>`).join("");
  return [...name]
    .map((ch, i) => {
      const display = ch === " " ? "&nbsp;" : escapeHtml(ch);
      return `<span class="letter" style="--i:${i}">${display}${drips}</span>`;
    })
    .join("");
}

function updateEventsSourceLink(city) {
  const sourceLink = document.getElementById("events-source-link");
  if (city.domain) {
    sourceLink.href = `https://${city.domain}/events`;
    sourceLink.textContent = `${city.domain} Events Calendar`;
  } else {
    sourceLink.href = city.eventsUrl;
    sourceLink.textContent = "Local Events Calendar";
  }
}

function initCityPicker() {
  const toggleBtn = document.getElementById("city-toggle");
  toggleBtn.innerHTML = renderWavyText(currentCity.name);
  document.title = `${currentCity.name} Travel Conditions and Events`;
  updateEventsSourceLink(currentCity);

  cityPickerEl = document.createElement("div");
  cityPickerEl.id = "city-picker";
  cityPickerEl.className = "nav-picker hidden";
  cityPickerEl.setAttribute("role", "menu");
  cityPickerEl.innerHTML = [...CITIES]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(c => `<button type="button" data-city-key="${c.key}" role="menuitem">${escapeHtml(c.name)}</button>`)
    .join("");
  document.body.appendChild(cityPickerEl);

  cityPickerEl.addEventListener("click", ev => {
    const btn = ev.target.closest("button[data-city-key]");
    if (!btn) return;
    selectCity(btn.dataset.cityKey);
    hideCityPicker();
  });

  toggleBtn.addEventListener("click", ev => {
    ev.stopPropagation();
    toggleCityPicker();
  });

  document.addEventListener("click", ev => {
    if (cityPickerEl.classList.contains("hidden")) return;
    if (ev.target.closest("#city-picker") || ev.target.closest("#city-toggle")) return;
    hideCityPicker();
  });

  document.addEventListener("keydown", ev => {
    if (ev.key === "Escape") hideCityPicker();
  });

  window.addEventListener("scroll", hideCityPicker, true);
  window.addEventListener("resize", hideCityPicker);
}

function hideCityPicker() {
  if (!cityPickerEl) return;
  cityPickerEl.classList.add("hidden");
}

function toggleCityPicker() {
  const toggleBtn = document.getElementById("city-toggle");
  if (!cityPickerEl.classList.contains("hidden")) {
    hideCityPicker();
    return;
  }
  cityPickerEl.classList.remove("hidden");
  positionPopoverNear(cityPickerEl, toggleBtn);
}

function selectCity(key) {
  const city = CITIES.find(c => c.key === key);
  if (!city || city.key === currentCity.key) return;

  cityAbortController.abort();
  cityAbortController = new AbortController();

  currentCity = city;
  localStorage.setItem("cityKey", city.key);

  document.getElementById("city-toggle").innerHTML = renderWavyText(city.name);
  document.title = `${city.name} Travel Conditions and Events`;
  updateEventsSourceLink(city);

  document.getElementById("weather-body").innerHTML = '<div class="skeleton"></div>';
  document.getElementById("events-body").innerHTML = '<div class="skeleton"></div>';
  lastUpcomingRows = [];
  currentEventsRows = [];
  setTeaserContent(document.getElementById("now-playing"), "", "");
  setTeaserContent(document.getElementById("next-event"), "", "");
  lastUpdated.weather = null;
  lastUpdated.events = null;

  resetEventsTabs();
  clearEventsDate();

  loadWeather();
  loadEvents();
}

// ---------- Collapsible Weather/Events cards ----------

const COLLAPSIBLE_CARDS = [
  { key: "weather", cardId: "card-weather", toggleId: "weather-collapse-toggle" },
  { key: "events", cardId: "card-events", toggleId: "events-collapse-toggle" },
];

// The grid's two rows default to auto/1fr (Weather sizes to its own content,
// Events fills whatever's left) - collapsing Weather already works with that
// as-is, since Events' 1fr row just claims the freed space. Collapsing
// Events instead needs the assignment flipped so Weather is the one that
// grows into the freed space; collapsing both avoids fr entirely so the
// grid doesn't stretch a chunk of empty background beneath two headers.
function updateGridRows() {
  const weatherCollapsed = document.getElementById("card-weather").classList.contains("collapsed");
  const eventsCollapsed = document.getElementById("card-events").classList.contains("collapsed");
  const grid = document.querySelector(".grid");
  if (weatherCollapsed && eventsCollapsed) {
    grid.style.gridTemplateRows = "auto auto";
  } else if (eventsCollapsed) {
    grid.style.gridTemplateRows = "1fr auto";
  } else {
    grid.style.gridTemplateRows = "auto 1fr";
  }
}

function initCollapsibleCards() {
  COLLAPSIBLE_CARDS.forEach(({ key, cardId, toggleId }) => {
    const card = document.getElementById(cardId);
    const toggle = document.getElementById(toggleId);
    if (localStorage.getItem(`collapsed:${key}`) === "true") {
      card.classList.add("collapsed");
    }
    toggle.addEventListener("click", () => {
      card.classList.toggle("collapsed");
      localStorage.setItem(`collapsed:${key}`, card.classList.contains("collapsed"));
      updateGridRows();
    });
  });
  updateGridRows();
}

// ---------- Events category tabs ----------

function resetEventsTabs() {
  selectedCategory = "all";
  document.querySelectorAll(".events-tab").forEach(b => b.classList.toggle("active", b.dataset.cat === "all"));
}

function initEventsTabs() {
  document.getElementById("events-tabs").addEventListener("click", ev => {
    const btn = ev.target.closest(".events-tab");
    if (!btn) return;
    selectedCategory = btn.dataset.cat;
    document.querySelectorAll(".events-tab").forEach(b => b.classList.toggle("active", b === btn));
    renderEventsList(currentEventsRows);
  });
}

// ---------- Events date picker ----------

function updateEventsTitleForDate() {
  const [y, m, d] = selectedEventDate.split("-");
  document.getElementById("events-title").textContent = `Events on ${m}/${d}/${y}`;
}

function clearEventsDate() {
  selectedEventDate = null;
  document.getElementById("events-date").value = "";
  document.getElementById("events-date-clear").classList.add("hidden");
  document.getElementById("events-title").textContent = "Upcoming Events";
}

function initEventsDatePicker() {
  const dateInput = document.getElementById("events-date");
  const clearBtn = document.getElementById("events-date-clear");

  const today = new Date();
  const y = today.getFullYear();
  const m = String(today.getMonth() + 1).padStart(2, "0");
  const d = String(today.getDate()).padStart(2, "0");
  dateInput.min = `${y}-${m}-${d}`;

  dateInput.addEventListener("change", () => {
    if (!dateInput.value) return;
    selectedEventDate = dateInput.value;
    clearBtn.classList.remove("hidden");
    updateEventsTitleForDate();
    document.getElementById("events-body").innerHTML = '<div class="skeleton"></div>';
    loadEvents();
  });

  clearBtn.addEventListener("click", () => {
    clearEventsDate();
    document.getElementById("events-body").innerHTML = '<div class="skeleton"></div>';
    loadEvents();
  });
}

// ---------- Utilities ----------

async function fetchJSON(url, signal) {
  const res = await fetch(url, signal ? { signal } : undefined);
  if (!res.ok) throw new Error(`Request failed: ${url} (${res.status})`);
  return res.json();
}

// ---------- Boot ----------

function init() {
  tickClock();
  setInterval(tickClock, REFRESH.clockTick);
  setInterval(refreshAgoLabels, REFRESH.agoTick);
  initNavPicker();
  initCityPicker();
  initEventsDatePicker();
  initEventsTabs();
  initCollapsibleCards();

  loadWeather();
  loadEvents();

  setInterval(loadWeather, REFRESH.weather);
  setInterval(loadEvents, REFRESH.events);
}

init();
