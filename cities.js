// Shared city list for landing.html and city.html (and the city-key based
// routing fallback in server.js/serve.ps1, which validates slugs against
// this same array client-side rather than keeping its own copy).
//
// Keep `domain` in sync with $CityDomains in serve.ps1 for DoStuff Media
// cities. A city with no primary/domain source can omit `domain` and set
// `eventsUrl` instead as its "browse everything" link-out - the Events
// panel still fetches and shows real events for it (server-side, that's
// whatever 19hz/Eventbrite backfill the city has configured), it just has
// no single primary site to build direct links or a footer link from.
// Omitting *both* `domain` and `eventsUrl` is what actually disables the
// panel for a city with no source of any kind.
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
  { key: "bos",  name: "Boston, MA",      lat: 42.3601, lon: -71.0589,  tz: "America/New_York",    domain: "do617.com" },
  // atl/mia/dc/det/oma have no primary source yet (no DoStuff Media
  // presence, and domain-guessing for a bespoke source came up dry or
  // incompatible for each - see the 19hz backfill notes in server.js) -
  // 19hz (EDM) + Eventbrite (Sports/Food) carry these on their own for now,
  // with eventsUrl as the "browse everything" link-out since there's no
  // single site that has it all. A proper primary source is a separate
  // future task per city.
  { key: "atl",  name: "Atlanta, GA",     lat: 33.7490, lon: -84.3880,  tz: "America/New_York",    eventsUrl: "https://19hz.info/eventlisting_Atlanta.php" },
  { key: "mia",  name: "Miami, FL",       lat: 25.7617, lon: -80.1918,  tz: "America/New_York",    eventsUrl: "https://19hz.info/eventlisting_Miami.php" },
  { key: "dc",   name: "Washington, DC",  lat: 38.9072, lon: -77.0369,  tz: "America/New_York",    eventsUrl: "https://19hz.info/eventlisting_DC.php" },
  { key: "det",  name: "Detroit, MI",     lat: 42.3314, lon: -83.0458,  tz: "America/Detroit",     eventsUrl: "https://19hz.info/eventlisting_Detroit.php" },
  { key: "oma",  name: "Omaha, NE",       lat: 41.2565, lon: -95.9345,  tz: "America/Chicago",     eventsUrl: "https://19hz.info/eventlisting_Iowa.php" },
];
