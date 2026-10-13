// Events and Travel Conditions — weather + events for one city at a time.
// All data comes from free public endpoints, fetched client-side (events go
// through the local proxy in serve.ps1 since do206.com has no CORS support).
// CITIES itself lives in cities.js (loaded before this file), shared with
// landing.html's city grid.

// The city comes from the URL (/<key>, e.g. /sea) - server.js/serve.ps1
// route any such extensionless path to this same page (see their own
// routing comments), and this is the one place that actually validates the
// slug against CITIES. Falls back to the last-saved city only if somehow
// loaded with no slug at all; redirects to the landing page if neither
// resolves to a real city (see the guarded call to init() at the bottom).
function getCityFromPath() {
  const slug = location.pathname.replace(/^\/+/, "").split("/")[0];
  return CITIES.find(c => c.key === slug) || null;
}

function loadSavedCity() {
  const fromPath = getCityFromPath();
  if (fromPath) return fromPath;
  const savedKey = localStorage.getItem("cityKey");
  return CITIES.find(c => c.key === savedKey) || null;
}

// Records the resolved city as the visitor's saved default - but only on
// an actual change, not on every reload of the same city, so the Firebase
// sync's last-write-wins timestamp doesn't get bumped by simply revisiting
// a page (see auth-ui.js's mergeStates).
function persistCity(city) {
  if (localStorage.getItem("cityKey") === city.key) return;
  const ts = Date.now();
  localStorage.setItem("cityKey", city.key);
  localStorage.setItem("cityKeyUpdatedAt", String(ts));
  window.EventTravelSync?.pushCity?.(city.key, ts);
}

let currentCity = loadSavedCity();
if (currentCity) persistCity(currentCity);

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

// Events the user has checked off as "got tix" for, persisted across
// reloads. Stored as self-contained snapshots (not just a key flag on the
// live rows) since the Got Tix card needs to keep showing an event even
// after switching away from the city it belongs to, or past its own
// source's normal fetch window - each snapshot carries its own timezone
// for that same reason (currentCity.tz would be wrong once you've
// switched to a different city than the ticketed event's own).
let ticketedEvents = loadTicketedEvents();

// Ticket tracking (the My Tickets card and the per-event checkbox) is a
// signed-in-only feature - starts false so nothing flashes before auth-ui.js
// confirms the real state, and is kept live via the onAuthStateChange
// subscription wired up in init() below. The underlying localStorage data
// is never touched by this flag - signing out just stops showing it, it's
// still there (and still synced) if you sign back in.
let signedIn = false;

// Whether the "Past" sub-section of My Tickets is expanded - module-level
// (not re-derived from the DOM) so it survives renderTicketsCard() being
// called again by the 30s refreshAgoLabels tick while a visitor has it
// open; starts collapsed since past tickets are secondary information.
let pastTicketsExpanded = false;

function loadTicketedEvents() {
  try {
    const raw = JSON.parse(localStorage.getItem("ticketedEvents") || "[]");
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

// The one place ticketedEvents is ever written to localStorage - both
// toggleTicketed() and renderTicketsCard()'s own expiry prune go through
// here, so hooking the Firestore push here (rather than in toggleTicketed
// alone) covers both without needing a second hook.
function saveTicketedEvents() {
  localStorage.setItem("ticketedEvents", JSON.stringify(ticketedEvents));
  window.EventTravelSync?.pushTickets?.(ticketedEvents);
}

function isTicketed(key) {
  return ticketedEvents.some(t => t.key === key);
}

function toggleTicketed(row, checked) {
  const key = eventLink(row);
  if (checked) {
    if (!isTicketed(key)) {
      ticketedEvents.push({
        key,
        title: row.title,
        startDate: row.startDate,
        hasTime: row.hasTime,
        venue: row.venue,
        cityName: currentCity.name,
        cityTz: currentCity.tz,
      });
    }
  } else {
    ticketedEvents = ticketedEvents.filter(t => t.key !== key);
  }
  saveTicketedEvents();
  renderTicketsCard();
}

function fmtTicketWhen(t) {
  return fmtEventWhen(t.startDate, t.hasTime !== false, t.cityTz || currentCity.tz);
}

const TICKET_STALE_AFTER_MS = 6 * 60 * 60 * 1000;

// A ticket moves to the grayed-out, collapsed Past section once it's been
// more than 6 hours since its start - not as soon as it starts (you're
// probably still there) and not tied to the calendar day rolling over
// (an early-morning event shouldn't clutter the normal list all the way
// into the evening). No startDate at all (time TBD) never goes stale.
function isStaleTicket(t) {
  return !!t.startDate && Date.now() - new Date(t.startDate).getTime() >= TICKET_STALE_AFTER_MS;
}

// Nothing in this app tracks a real event *end* time (most sources never
// give one), so every calendar entry just assumes a 2-hour block from the
// known start - an approximation, but a far better default than an
// instantaneous (zero-length) calendar event.
function ticsUtcStamp(d) {
  return d.toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
}

// Google/Outlook just need a plain URL (no auth, no popup blocked by
// following it), so those are regular links. Apple Calendar (and anything
// else that can import a file) has no such URL scheme - a .ics file is the
// universal fallback. That used to be built right here as a data: URI
// opened via a throwaway <a download>, but iOS Safari doesn't support the
// download attribute at all, so tapping it silently did nothing on an
// iPhone - it's now a real same-origin URL the server generates on the
// fly (see /api/ics in server.js), which is what actually works there.
function buildCalendarLinks(t) {
  const start = new Date(t.startDate);
  const end = new Date(start.getTime() + 2 * 60 * 60 * 1000);
  const startStamp = ticsUtcStamp(start);
  const endStamp = ticsUtcStamp(end);
  const title = encodeURIComponent(t.title);
  const location = encodeURIComponent(t.venue || "");

  const google = `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${title}&dates=${startStamp}/${endStamp}&location=${location}`;
  const outlook = `https://outlook.live.com/calendar/0/deeplink/compose?path=/calendar/action/compose&rru=addevent&subject=${title}&startdt=${encodeURIComponent(start.toISOString())}&enddt=${encodeURIComponent(end.toISOString())}&location=${location}`;
  const ics = `/api/ics?title=${title}&start=${encodeURIComponent(t.startDate)}&venue=${location}&key=${encodeURIComponent(t.key)}`;

  return { google, outlook, ics };
}

// Shows the soonest upcoming ticket prominently, anything further out
// listed compactly below, and - separately - a collapsed, grayed-out
// "Past" section for tickets that have gone stale (see isStaleTicket
// above). Nothing is ever deleted from ticketedEvents here any more: past
// tickets stay around indefinitely (a future "events you've attended"
// page could read the same data) - only their *display* is demoted.
// Shows an explanatory placeholder rather than hiding the card when
// there's nothing at all, so a first-time visitor discovers the
// checkbox-in-the-Events-card mechanism rather than never seeing this
// card at all. Called after every checkbox toggle and on the same 30s
// tick that re-checks the header teasers, so the upcoming->Past transition
// (and the upcoming list's own ordering) advances live without a reload.
function renderTicketsCard() {
  const card = document.getElementById("card-tickets");
  if (!signedIn) {
    card.classList.add("hidden");
    return;
  }
  card.classList.remove("hidden");

  const body = document.getElementById("tickets-body");

  if (!ticketedEvents.length) {
    body.innerHTML = `<div class="ticket-empty">Select events you've bought tickets for in the Events card below.</div>`;
    return;
  }

  const elsewhere = t => (t.cityName && t.cityName !== currentCity.name ? ` · ${escapeHtml(t.cityName)}` : "");
  const calBtn = t => {
    const { google, outlook, ics } = buildCalendarLinks(t);
    return `<button type="button" class="cal-btn"
        data-google="${escapeHtml(google)}"
        data-outlook="${escapeHtml(outlook)}"
        data-ics="${escapeHtml(ics)}"
        title="Add to calendar" aria-label="Add ${escapeHtml(t.title)} to calendar">🗓️+</button>`;
  };
  const ticketRowHtml = t => `
    <div class="ticket-row">
      <span class="ticket-title"><a class="ext-link" href="${escapeHtml(t.key)}" target="_blank" rel="noopener">${escapeHtml(t.title)}</a></span>
      <span class="ticket-when">${fmtTicketWhen(t)}${elsewhere(t)}</span>
      ${calBtn(t)}
    </div>`;

  const upcoming = ticketedEvents.filter(t => !isStaleTicket(t));
  const past = ticketedEvents.filter(isStaleTicket);

  let upcomingHtml;
  if (!upcoming.length) {
    upcomingHtml = `<div class="ticket-empty">No upcoming tickets - see Past below.</div>`;
  } else {
    const sorted = [...upcoming].sort((a, b) => {
      const ta = a.startDate ? new Date(a.startDate).getTime() : Infinity;
      const tb = b.startDate ? new Date(b.startDate).getTime() : Infinity;
      return ta - tb;
    });

    // The featured (highlighted) slot goes to the soonest ticket that
    // hasn't started yet, judged against real time right now - not just
    // the earliest same-day ticket. A same-day event that's already under
    // way stays in the plain list below rather than being "featured" as
    // if it were still next up.
    const now = Date.now();
    const featuredIndex = sorted.findIndex(t => !t.startDate || new Date(t.startDate).getTime() >= now);

    if (featuredIndex === -1) {
      // Every ticket still in "upcoming" (i.e. not yet 6h stale, per
      // isStaleTicket) has already started - nothing left to feature
      // right now, just list them plainly.
      upcomingHtml = `<div class="ticket-more flush">${sorted.map(ticketRowHtml).join("")}</div>`;
    } else {
      const featured = sorted[featuredIndex];
      const rest = sorted.filter((_, i) => i !== featuredIndex);

      const featuredHtml = `
        <div class="ticket-featured">
          <div class="ticket-featured-row">
            <div class="ticket-title"><a class="ext-link" href="${escapeHtml(featured.key)}" target="_blank" rel="noopener">${escapeHtml(featured.title)}</a></div>
            ${calBtn(featured)}
          </div>
          <div class="ticket-when">${fmtTicketWhen(featured)}${featured.venue ? ` · ${escapeHtml(featured.venue)}` : ""}${elsewhere(featured)}</div>
        </div>`;

      const restHtml = rest.length ? `<div class="ticket-more">${rest.map(ticketRowHtml).join("")}</div>` : "";

      upcomingHtml = featuredHtml + restHtml;
    }
  }

  let pastHtml = "";
  if (past.length) {
    const pastSorted = [...past].sort((a, b) => {
      const ta = a.startDate ? new Date(a.startDate).getTime() : -Infinity;
      const tb = b.startDate ? new Date(b.startDate).getTime() : -Infinity;
      return tb - ta; // most recent first
    });
    pastHtml = `
      <div class="ticket-past">
        <button type="button" class="ticket-past-toggle${pastTicketsExpanded ? " expanded" : ""}" id="ticket-past-toggle">
          <span class="collapse-icon">▾</span> Past (${past.length})
        </button>
        <div class="ticket-past-list${pastTicketsExpanded ? "" : " hidden"}" id="ticket-past-list">
          ${pastSorted
            .map(t => `
              <div class="ticket-row ticket-row-past">
                <span class="ticket-title"><a class="ext-link" href="${escapeHtml(t.key)}" target="_blank" rel="noopener">${escapeHtml(t.title)}</a></span>
                <span class="ticket-when">${fmtTicketWhen(t)}${elsewhere(t)}</span>
              </div>`)
            .join("")}
        </div>
      </div>`;
  }

  body.innerHTML = upcomingHtml + pastHtml;

  if (past.length) {
    document.getElementById("ticket-past-toggle").addEventListener("click", () => {
      pastTicketsExpanded = !pastTicketsExpanded;
      document.getElementById("ticket-past-toggle").classList.toggle("expanded", pastTicketsExpanded);
      document.getElementById("ticket-past-list").classList.toggle("hidden", !pastTicketsExpanded);
    });
  }
}

// Every source reports its own raw category vocabulary (DoStuff's dozens of
// per-city genre slugs, dtphx's own tag ids already normalized server-side
// to "concerts"/"sports"/"food"/"community", Reno's single always-"music"
// value) - this collapses all of it down to the tabs in the Events card.
function normalizeCategory(raw) {
  const c = (raw || "").toLowerCase();
  if (c === "concerts" || c === "sports" || c === "food" || c === "comedy" || c === "edm" || c === "community") return c;
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
  renderTicketsCard();
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
  try {
    const { lat, lon } = currentCity;
    const point = await fetchJSON(`https://api.weather.gov/points/${lat},${lon}`);
    const { forecast, observationStations } = point.properties;

    const [forecastData, stations, alertsData] = await Promise.all([
      fetchJSON(forecast),
      fetchJSON(observationStations),
      fetchJSON(`https://api.weather.gov/alerts/active?point=${lat},${lon}`),
    ]);

    renderAlerts(alertsData);

    const periods = forecastData.properties.periods;
    const now = periods[0];
    const upcoming = periods.slice(1, 5);

    let current = null;
    const stationUrl = stations.features?.[0]?.id;
    if (stationUrl) {
      try {
        const obs = await fetchJSON(`${stationUrl}/observations/latest`);
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
function fmtEventWhen(iso, hasTime = true, tz = currentCity.tz) {
  if (!iso) return "Time TBD";
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

function fmtNextEventTime(iso, hasTime = true, tz = currentCity.tz) {
  if (!iso || !hasTime) return "";
  return new Date(iso).toLocaleTimeString("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" });
}

// Most sources give a permalink relative to the city's domain; the
// Eventbrite backfill gives a full absolute URL on a different domain, so
// this only prefixes when the permalink isn't already a complete URL.
// Prefer a direct ticket-purchase link over the source site's own event
// page when one's available (currently just the DoStuff cities - their
// listing already embeds the real vendor's URL, so this costs nothing
// extra to use). Free/RSVP events have no ticketUrl, so they fall back
// to the source page exactly as before.
function eventLink(e) {
  if (e.ticketUrl) return e.ticketUrl;
  // 19hz/Eventbrite permalinks are always already-absolute URLs, so this
  // relative-prefixing path is only ever exercised by DoStuff cities
  // (which always have a domain) - the fallback below just needs to not
  // blow up for a domain-less city on the off chance an event has neither.
  if (!e.permalink) return currentCity.domain ? `https://${currentCity.domain}/events` : currentCity.eventsUrl || "#";
  if (/^https?:\/\//i.test(e.permalink)) return e.permalink;
  return `https://${currentCity.domain}${e.permalink}`;
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
  const browseUrl = currentCity.domain ? `https://${currentCity.domain}/events` : currentCity.eventsUrl;
  const browseLabel = currentCity.domain || "local events calendar";
  const current = rows.filter(e => !isStaleToday(e));
  const filtered = selectedCategory === "all"
    ? current
    : current.filter(e => normalizeCategory(e.category) === selectedCategory);

  if (!filtered.length) {
    const dateNote = selectedEventDate ? ` for ${fmtSelectedDate(selectedEventDate)}` : "";
    const activeTab = document.querySelector(`.events-tab[data-cat="${selectedCategory}"]`);
    const categoryNote = selectedCategory !== "all" && activeTab ? ` in ${activeTab.textContent}` : "";
    document.getElementById("events-body").innerHTML =
      `<div class="empty-state">No events found${dateNote}${categoryNote}. <a class="ext-link" href="${browseUrl}" target="_blank" rel="noopener">Browse ${escapeHtml(browseLabel)} ↗</a></div>`;
    return;
  }

  document.getElementById("events-body").innerHTML = filtered
    .map((e, i) => {
      const { gmapsUrl, wazeUrl, appleUrl, place } = directionsLinks(e);
      const checked = isTicketed(eventLink(e));
      const checkbox = signedIn
        ? `<input type="checkbox" class="ticket-check" data-index="${i}" ${checked ? "checked" : ""} title="I've got tickets to this" aria-label="Mark ${escapeHtml(e.title)} as got tickets">`
        : "";

      return `
        <div class="list-item">
          <div class="title">
            ${checkbox}
            <a class="ext-link" href="${eventLink(e)}" target="_blank" rel="noopener">${escapeHtml(e.title)}</a>
          </div>
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

  // Delegated + rebuilt on every render, cheap for a list this size and
  // simpler than diffing - data-index maps back into `filtered`, the exact
  // array actually rendered, rather than re-deriving it from the DOM.
  document.getElementById("events-body").querySelectorAll(".ticket-check").forEach(input => {
    input.addEventListener("change", () => {
      toggleTicketed(filtered[Number(input.dataset.index)], input.checked);
    });
  });
}

async function loadEvents() {
  // A city with genuinely no source at all (no domain, and nothing for the
  // server to fall back to) skips the fetch entirely - every city currently
  // in CITIES has at least a domain or an eventsUrl-backed 19hz/Eventbrite
  // feed, so this is only a safety net for a future half-added city.
  if (!currentCity.domain && !currentCity.eventsUrl) {
    document.getElementById("events-body").innerHTML =
      `<div class="empty-state">No live event feed for ${escapeHtml(currentCity.name)} yet.</div>`;
    lastUpcomingRows = [];
    currentEventsRows = [];
    setTeaserContent(document.getElementById("now-playing"), "", "");
    setTeaserContent(document.getElementById("next-event"), "", "");
    setUpdated("events");
    refreshAgoLabels();
    return;
  }

  const browseUrl = currentCity.domain ? `https://${currentCity.domain}/events` : currentCity.eventsUrl;
  const browseLabel = currentCity.domain || "local events calendar";
  try {
    const rows = await fetchJSON(eventsEndpoint());
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
    console.error(err);
    const hint = location.protocol === "file:"
      ? `This page was opened as a local file (${location.href}). Events need serve.ps1 - open <strong>http://localhost:8837</strong> in your browser instead of double-clicking city.html.`
      : "Live event list needs the local server (serve.ps1) running. Start it, then reload this page.";
    document.getElementById("events-body").innerHTML =
      `<div class="empty-state">${hint}<br><a class="ext-link" href="${browseUrl}" target="_blank" rel="noopener">Browse events on ${escapeHtml(browseLabel)} ↗</a></div>`;
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

// ---------- Add-to-calendar picker (My Tickets card) ----------

let calPickerEl = null;
let activeCalBtn = null;

function initCalPicker() {
  calPickerEl = document.createElement("div");
  calPickerEl.id = "cal-picker";
  calPickerEl.className = "nav-picker hidden";
  calPickerEl.setAttribute("role", "menu");
  calPickerEl.innerHTML = `
    <button type="button" data-key="google" role="menuitem">Google Calendar</button>
    <button type="button" data-key="outlook" role="menuitem">Outlook</button>
    <button type="button" data-key="ics" role="menuitem">Apple / Download .ics</button>
  `;
  document.body.appendChild(calPickerEl);

  calPickerEl.addEventListener("click", ev => {
    const btn = ev.target.closest("button[data-key]");
    if (!btn) return;
    const url = calPickerEl.dataset[btn.dataset.key];
    if (url) window.open(url, "_blank", "noopener");
    hideCalPicker();
  });

  document.getElementById("tickets-body").addEventListener("click", ev => {
    const btn = ev.target.closest(".cal-btn");
    if (!btn) return;
    ev.stopPropagation();
    toggleCalPicker(btn);
  });

  document.addEventListener("click", ev => {
    if (calPickerEl.classList.contains("hidden")) return;
    if (ev.target.closest("#cal-picker")) return;
    hideCalPicker();
  });

  document.addEventListener("keydown", ev => {
    if (ev.key === "Escape") hideCalPicker();
  });

  window.addEventListener("scroll", hideCalPicker, true);
  window.addEventListener("resize", hideCalPicker);
}

function hideCalPicker() {
  if (!calPickerEl) return;
  calPickerEl.classList.add("hidden");
  activeCalBtn = null;
}

function toggleCalPicker(btn) {
  if (activeCalBtn === btn && !calPickerEl.classList.contains("hidden")) {
    hideCalPicker();
    return;
  }
  activeCalBtn = btn;
  calPickerEl.dataset.google = btn.dataset.google;
  calPickerEl.dataset.outlook = btn.dataset.outlook;
  calPickerEl.dataset.ics = btn.dataset.ics;
  calPickerEl.classList.remove("hidden");
  positionPopoverNear(calPickerEl, btn);
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
  document.title = `${currentCity.name} Events and Travel Conditions`;
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

// Switching cities is a real navigation now (the city lives in the URL,
// see getCityFromPath) rather than an in-place state swap - this used to
// reset a dozen pieces of UI state and re-fetch everything by hand; a
// normal page load of /<key> now does all of that for free.
function selectCity(key) {
  if (key === currentCity.key) return;
  location.href = `/${key}`;
}

// ---------- Collapsible Weather/Events cards ----------

const COLLAPSIBLE_CARDS = [
  { key: "weather", cardId: "card-weather", toggleId: "weather-collapse-toggle" },
  { key: "events", cardId: "card-events", toggleId: "events-collapse-toggle" },
  { key: "tickets", cardId: "card-tickets", toggleId: "tickets-collapse-toggle" },
];

// Both grid rows are auto-height now (the page scrolls naturally instead of
// being locked to the viewport - see the .grid comment in style.css), so
// collapsing a card just shrinks that card to its own header height; no
// row-sizing math needed to redistribute space to whichever one is expanded.
function initCollapsibleCards() {
  document.getElementById("weather-label").innerHTML = renderWavyText("Weather");
  document.getElementById("tickets-label").innerHTML = renderWavyText("My Tickets");
  COLLAPSIBLE_CARDS.forEach(({ key, cardId, toggleId }) => {
    const card = document.getElementById(cardId);
    const toggle = document.getElementById(toggleId);
    if (localStorage.getItem(`collapsed:${key}`) === "true") {
      card.classList.add("collapsed");
    }
    toggle.addEventListener("click", () => {
      card.classList.toggle("collapsed");
      localStorage.setItem(`collapsed:${key}`, card.classList.contains("collapsed"));
    });
  });
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
  document.getElementById("events-title").innerHTML = renderWavyText(`Events on ${m}/${d}/${y}`);
}

function clearEventsDate() {
  selectedEventDate = null;
  document.getElementById("events-date").value = "";
  document.getElementById("events-date-clear").classList.add("hidden");
  document.getElementById("events-title").innerHTML = renderWavyText("Upcoming Events");
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

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Request failed: ${url} (${res.status})`);
  return res.json();
}

// ---------- Boot ----------

function init() {
  tickClock();
  setInterval(tickClock, REFRESH.clockTick);
  setInterval(refreshAgoLabels, REFRESH.agoTick);
  initNavPicker();
  initCalPicker();
  initCityPicker();
  initEventsDatePicker();
  clearEventsDate();
  initEventsTabs();
  initCollapsibleCards();
  // window.EventTravelSync is set synchronously by auth-ui.js (loaded
  // before this file), so this is always safe even though the signed-in
  // state it reports starts as false until Firebase's own async check
  // resolves - onAuthStateChange fires once immediately with whatever's
  // currently known, then again on every real sign-in/out.
  window.EventTravelSync?.onAuthStateChange?.(signedInNow => {
    signedIn = signedInNow;
    renderTicketsCard();
    renderEventsList(currentEventsRows);
  });

  loadWeather();
  loadEvents();

  setInterval(loadWeather, REFRESH.weather);
  setInterval(loadEvents, REFRESH.events);
}

// currentCity is null only if the URL's slug (if any) doesn't match a
// known city AND nothing was ever saved locally - city.html should only
// ever be reached via a valid /<key> path (see server.js/serve.ps1's
// routing), so this is a defensive fallback, not the normal case.
if (currentCity) {
  init();
} else {
  location.replace("/");
}
