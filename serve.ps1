$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$port = 8837
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$port/")
$listener.Start()
Write-Output "Serving $root on http://localhost:$port/"

# Fetching Sports/Food from Eventbrite adds a second full network round
# trip on top of the primary source's own fetch. server.js now kicks this
# off *concurrently* with the primary fetch (see getEventbriteBackfillPromise
# there), so it only costs max(primary, eventbrite) - this PowerShell
# version was never restructured to match, so here it still runs
# sequentially after the primary fetch and costs the sum of both. Since
# Render only runs server.js, that's just a slower local dev experience,
# not a difference in what's actually deployed.
$EnableEventbriteBackfill = $true

$mime = @{
  ".html" = "text/html"
  ".css"  = "text/css"
  ".js"   = "application/javascript"
  ".json" = "application/json"
  ".png"  = "image/png"
  ".jpg"  = "image/jpeg"
  ".svg"  = "image/svg+xml"
}

# ---- DoStuff Media events proxy (their JSON/HTML isn't CORS-enabled, so we
# fetch + parse it server-side). Same markup/URL pattern across every city on
# the network - only the domain changes. Keep this whitelist in sync with the
# CITIES list in app.js.

$CityDomains = @{
  sea = "do206.com"          # Seattle
  pdx = "dopdx.com"          # Portland
  atx = "do512.com"          # Austin
  nyc = "donyc.com"          # New York
  chi = "do312.com"          # Chicago
  den = "do303.com"          # Denver
  bna = "do615.com"          # Nashville
  lax = "dolosangeles.com"   # Los Angeles
  bay = "dothebay.com"       # SF Bay Area
  # Cities with no DoStuff Media presence (e.g. reno) are intentionally left
  # out - the request handler below returns an empty list for them rather
  # than silently substituting a different city's events.
}

$script:eventsCache = @{}
$script:eventsCacheTime = @{}
$script:eventsCacheFailed = @{}

# A cache entry from a fetch that failed (timeout, network error) is only
# trusted for a minute, instead of the source's normal 15-20 minute TTL.
# Sites like dothebay.com are usually fast but occasionally spike past the
# fetch timeout - without this, one slow response gets its resulting empty
# list cached for the full window, making that city look broken/stuck-empty
# for up to 20 minutes even though the site itself recovers within seconds.
function Test-EventsCacheFresh {
  param([string]$cacheKey, [double]$ttlMinutes)
  if (-not $script:eventsCache.ContainsKey($cacheKey)) { return $false }
  $effectiveTtl = if ($script:eventsCacheFailed.ContainsKey($cacheKey)) { 1 } else { $ttlMinutes }
  return ((Get-Date) - $script:eventsCacheTime[$cacheKey]).TotalMinutes -lt $effectiveTtl
}

function Set-EventsCache {
  param([string]$cacheKey, [array]$parsed, [bool]$fetchSucceeded)
  $script:eventsCache[$cacheKey] = $parsed
  $script:eventsCacheTime[$cacheKey] = Get-Date
  if ($fetchSucceeded) { $script:eventsCacheFailed.Remove($cacheKey) } else { $script:eventsCacheFailed[$cacheKey] = $true }
}

# Fetches multiple URLs concurrently instead of one at a time. Every source
# below needs several fetches per request (DoStuff's today+tomorrow, dtphx's
# per-tag AJAX calls, the Eventbrite backfill's sports+food pages) - doing
# those sequentially was adding 3-7 SECONDS to a cold-cache page load, since
# each one is a full network round trip. This runs them all at once on a
# small runspace pool instead (safe here because the request handler loop
# below is itself single-threaded, so there's no cross-request contention),
# so a batch of N fetches costs roughly the time of the slowest one instead
# of the sum of all of them.
function Get-UrlsParallel {
  param([string[]]$urls)
  $results = @{}
  if ($urls.Count -eq 0) { return $results }

  $pool = [runspacefactory]::CreateRunspacePool(1, [Math]::Max(1, [Math]::Min(8, $urls.Count)))
  $pool.Open()
  try {
    $jobs = foreach ($url in $urls) {
      $ps = [powershell]::Create()
      $ps.RunspacePool = $pool
      [void]$ps.AddScript({
        param($u)
        try {
          (Invoke-WebRequest -Uri $u -UseBasicParsing -Headers @{ "User-Agent" = "Mozilla/5.0"; "Accept" = "text/html" } -TimeoutSec 15).Content
        } catch {
          $null
        }
      }).AddArgument($url)
      [PSCustomObject]@{ Url = $url; Pipe = $ps; Handle = $ps.BeginInvoke() }
    }
    foreach ($job in $jobs) {
      try { $results[$job.Url] = $job.Pipe.EndInvoke($job.Handle) } catch { $results[$job.Url] = $null }
      $job.Pipe.Dispose()
    }
  } finally {
    $pool.Close()
    $pool.Dispose()
  }
  return $results
}

function Parse-DoStuffHtml {
  param([string]$html)
  $events = @()
  # data-ds-ga-label is only "day" on today's page - it's empty for every
  # other date (tomorrow included), so this must not require a fixed value.
  $starts = [regex]::Matches($html, '<div class="ds-listing event-card ds-event-category-(?<cat>[a-z-]+)" data-ds-ga-label="[^"]*" data-permalink="(?<permalink>[^"]+)"')
  for ($i = 0; $i -lt $starts.Count; $i++) {
    $m = $starts[$i]
    $blockStart = $m.Index
    $blockEnd = if ($i + 1 -lt $starts.Count) { $starts[$i + 1].Index } else { [Math]::Min($html.Length, $blockStart + 6000) }
    $block = $html.Substring($blockStart, $blockEnd - $blockStart)

    $titleMatch = [regex]::Match($block, '<span class="ds-listing-event-title-text" itemprop="name">(?<t>[^<]+)</span>')
    if (-not $titleMatch.Success) { continue }

    $venueMatch = [regex]::Match($block, '<a href="/venues/[^"]*" itemprop="url"><span itemprop="name">(?<v>[^<]+)</span></a>')
    $cityMatch  = [regex]::Match($block, '<meta itemprop="addressLocality" content="(?<c>[^"]+)"')
    $dateMatch  = [regex]::Match($block, '<meta itemprop="startDate" datetime="(?<d>[^"]+)"')
    $latMatch   = [regex]::Match($block, '<meta itemprop="latitude" content="(?<lat>[^"]+)"')
    $lonMatch   = [regex]::Match($block, '<meta itemprop="longitude" content="(?<lon>[^"]+)"')
    # DoStuff's own "Buy Tickets" button already points straight at the real
    # vendor (Ticketmaster, AXS, Dice, the venue's own site, etc., often via
    # an affiliate redirect) - it's embedded as a schema.org Offer right in
    # this same page, so linking to it costs nothing extra to fetch. Free/
    # RSVP events have no Offer at all, hence the fallback to the DoStuff
    # page elsewhere.
    $offerMatch = [regex]::Match($block, '<span itemprop="offers"[^>]*>\s*<meta itemprop="url" content="(?<u>[^"]+)"')

    $events += [PSCustomObject]@{
      title     = [System.Net.WebUtility]::HtmlDecode($titleMatch.Groups['t'].Value.Trim())
      permalink = $m.Groups['permalink'].Value
      venue     = if ($venueMatch.Success) { [System.Net.WebUtility]::HtmlDecode($venueMatch.Groups['v'].Value.Trim()) } else { $null }
      city      = if ($cityMatch.Success) { $cityMatch.Groups['c'].Value } else { $null }
      startDate = if ($dateMatch.Success) { $dateMatch.Groups['d'].Value } else { $null }
      category  = $m.Groups['cat'].Value
      lat       = if ($latMatch.Success) { [double]$latMatch.Groups['lat'].Value } else { $null }
      lon       = if ($lonMatch.Success) { [double]$lonMatch.Groups['lon'].Value } else { $null }
      ticketUrl = if ($offerMatch.Success) { [System.Net.WebUtility]::HtmlDecode($offerMatch.Groups['u'].Value) } else { $null }
    }
  }
  return $events
}

# Fetches one or more days' pages for a domain, running only the actual
# cache misses in parallel (a specific-date lookup needs just one page; the
# default view needs today+tomorrow).
function Get-DoStuffDaysEvents {
  param([string]$domain, [datetime[]]$dates)
  $cacheKeyFor = { param($d) "$domain|$($d.ToString('yyyy-MM-dd'))" }
  $urlFor = { param($d) "https://$domain/events/$($d.Year)/$($d.Month)/$($d.Day)" }

  $missing = @($dates | Where-Object { -not (Test-EventsCacheFresh -cacheKey (& $cacheKeyFor $_) -ttlMinutes 15) })

  if ($missing.Count -gt 0) {
    $htmlByUrl = Get-UrlsParallel -urls ($missing | ForEach-Object { & $urlFor $_ })
    foreach ($d in $missing) {
      $html = $htmlByUrl[(& $urlFor $d)]
      $parsed = if ($html) { Parse-DoStuffHtml -html $html } else { @() }
      Set-EventsCache -cacheKey (& $cacheKeyFor $d) -parsed $parsed -fetchSucceeded ([bool]$html)
    }
  }

  $all = @()
  foreach ($d in $dates) { $all += @($script:eventsCache[(& $cacheKeyFor $d)]) }
  return $all
}

function Get-UpcomingEventsJson {
  param([string]$domain, [string]$cityKey, [string]$specificDate = $null)

  # A specific date was requested from the Events panel's date picker -
  # fetch just that one day and keep only events that actually land on it
  # (this also naturally drops the recurring-series debut-date artifact
  # below, since a stale date won't match the requested one).
  if ($specificDate) {
    $target = $null
    try { $target = [datetime]::ParseExact($specificDate, "yyyy-MM-dd", $null) } catch {}
    if (-not $target) { return "[]" }

    $dayEvents = @(Get-DoStuffDaysEvents -domain $domain -dates @($target))
    $unique = $dayEvents | Where-Object { $_.permalink } | Sort-Object -Property permalink -Unique
    $matching = $unique | Where-Object {
      if (-not $_.startDate) { return $false }
      try { ([datetime]$_.startDate).Date -eq $target.Date } catch { return $false }
    }
    $matching = Merge-EventbriteBackfill -existingEvents $matching -cityKey $cityKey -startDate $specificDate -endDate $specificDate
    $sorted = $matching | Sort-Object { [datetime]$_.startDate }

    if ($sorted.Count -eq 0) { return "[]" }
    $json = $sorted | ConvertTo-Json -Depth 3
    if ($sorted.Count -eq 1) { $json = "[$json]" }
    return $json
  }

  $today = Get-Date
  $todayStart = $today.Date
  $tomorrow = $today.AddDays(1)
  $all = Get-DoStuffDaysEvents -domain $domain -dates @($today, $tomorrow)
  $unique = $all | Where-Object { $_.permalink } | Sort-Object -Property permalink -Unique

  # Some recurring/series listings carry their original debut date instead of
  # today's occurrence (e.g. a weekly series shows its season-opener date) -
  # drop anything dated before today so the list only shows real upcoming times.
  $unique = $unique | Where-Object {
    if (-not $_.startDate) { return $true }
    try { ([datetime]$_.startDate) -ge $todayStart } catch { $true }
  }

  $unique = Merge-EventbriteBackfill -existingEvents $unique -cityKey $cityKey -startDate $todayStart.ToString("yyyy-MM-dd") -endDate $tomorrow.ToString("yyyy-MM-dd")

  $sorted = $unique | Sort-Object {
    if ($_.startDate) { try { [datetime]$_.startDate } catch { [datetime]::MaxValue } } else { [datetime]::MaxValue }
  }

  if ($sorted.Count -eq 0) { return "[]" }
  $json = $sorted | ConvertTo-Json -Depth 3
  if ($sorted.Count -eq 1) { $json = "[$json]" }
  return $json
}

# ---- therenoscene.com (Reno has no DoStuff Media site, so this is a
# bespoke parser for a different, non-CORS-enabled source). Its concert
# listing is a single ungrouped page rather than per-day URLs like DoStuff,
# with events grouped under a "dateBar" that only appears when the date
# changes, so parsing has to carry the current date forward row by row.
# Note the "www." - the bare domain points to an unrelated placeholder page.

function Parse-RenoSceneHtml {
  param([string]$html)
  $events = @()
  $currentDateText = $null
  $rows = [regex]::Matches($html, '<div class="row ">')
  for ($i = 0; $i -lt $rows.Count; $i++) {
    $blockStart = $rows[$i].Index
    $blockEnd = if ($i + 1 -lt $rows.Count) { $rows[$i + 1].Index } else { [Math]::Min($html.Length, $blockStart + 3000) }
    $block = $html.Substring($blockStart, $blockEnd - $blockStart)

    $dateMatch = [regex]::Match($block, '<div class="dateBar">(?<d>[^<]+)</div>')
    if ($dateMatch.Success) { $currentDateText = $dateMatch.Groups['d'].Value.Trim() }
    if (-not $currentDateText) { continue }

    $titleMatch = [regex]::Match($block, '<h2 class="loopbands"><a href="(?<url>[^"]+)">(?<t>[^<]+)</a></h2>')
    if (-not $titleMatch.Success) { continue }

    $venueMatch = [regex]::Match($block, '<span class="loopvenuename"><a href="[^"]*"[^>]*>(?<v>[^<]+)</a></span>')
    $showMatch  = [regex]::Match($block, '(?<time>\d{1,2}:\d{2}\s*[AP]M)\s*\(Show\)')
    $doorMatch  = [regex]::Match($block, '(?<time>\d{1,2}:\d{2}\s*[AP]M)\s*\(Doors\)')
    $timeText = if ($showMatch.Success) { $showMatch.Groups['time'].Value } elseif ($doorMatch.Success) { $doorMatch.Groups['time'].Value } else { $null }

    $startDate = $null
    if ($timeText) {
      try {
        $dt = [datetime]::ParseExact("$currentDateText $timeText", "MMMM d, yyyy h:mm tt", [System.Globalization.CultureInfo]::InvariantCulture)
        $startDate = $dt.ToString("yyyy-MM-ddTHH:mm") + "-07:00"
      } catch {}
    }

    $events += [PSCustomObject]@{
      title     = [System.Net.WebUtility]::HtmlDecode($titleMatch.Groups['t'].Value.Trim())
      permalink = $titleMatch.Groups['url'].Value -replace '^https://www\.therenoscene\.com', ''
      venue     = if ($venueMatch.Success) { [System.Net.WebUtility]::HtmlDecode($venueMatch.Groups['v'].Value.Trim()) } else { $null }
      city      = "Reno"
      startDate = $startDate
      category  = "music"
      lat       = $null
      lon       = $null
    }
  }
  return $events
}

function Get-RenoSceneEventsJson {
  param([string]$specificDate = $null)

  $cacheKey = "therenoscene"
  if (-not (Test-EventsCacheFresh -cacheKey $cacheKey -ttlMinutes 20)) {
    $succeeded = $false
    try {
      $resp = Invoke-WebRequest -Uri "https://www.therenoscene.com/concerts-all-ages/" -UseBasicParsing -Headers @{ "User-Agent" = "Mozilla/5.0"; "Accept" = "text/html" } -TimeoutSec 15
      $parsed = Parse-RenoSceneHtml -html $resp.Content
      $succeeded = $true
    } catch {
      $parsed = @()
    }
    Set-EventsCache -cacheKey $cacheKey -parsed $parsed -fetchSucceeded $succeeded
  }

  if ($specificDate) {
    $target = $null
    try { $target = [datetime]::ParseExact($specificDate, "yyyy-MM-dd", $null) } catch {}
    if (-not $target) { return "[]" }

    $matching = $script:eventsCache[$cacheKey] | Where-Object {
      $_.startDate -and (([datetime]$_.startDate).Date -eq $target.Date)
    }
    $matching = Merge-EventbriteBackfill -existingEvents $matching -cityKey "reno" -startDate $specificDate -endDate $specificDate
    $matching = $matching | Sort-Object { [datetime]$_.startDate }

    if ($matching.Count -eq 0) { return "[]" }
    $json = $matching | ConvertTo-Json -Depth 3
    if ($matching.Count -eq 1) { $json = "[$json]" }
    return $json
  }

  $todayStart = (Get-Date).Date
  # Concerts don't happen every day here like DoStuff cities' daily listings
  # do, so "today + tomorrow" would come up empty most nights - show every
  # upcoming show on the page instead, whatever span of days that covers.
  $upcoming = $script:eventsCache[$cacheKey] | Where-Object {
    $_.startDate -and (([datetime]$_.startDate) -ge $todayStart)
  }
  # Reno's own concert list can span weeks, but the Eventbrite backfill only
  # needs to cover the same near-term window every other city gets - it's
  # there to fill a Sports/Food gap, not to extend the horizon.
  $upcoming = Merge-EventbriteBackfill -existingEvents $upcoming -cityKey "reno" -startDate $todayStart.ToString("yyyy-MM-dd") -endDate $todayStart.AddDays(1).ToString("yyyy-MM-dd")
  $upcoming = $upcoming | Sort-Object { [datetime]$_.startDate }

  if ($upcoming.Count -eq 0) { return "[]" }
  $json = $upcoming | ConvertTo-Json -Depth 3
  if ($upcoming.Count -eq 1) { $json = "[$json]" }
  return $json
}

# ---- dtphx.org (Downtown Phoenix Inc.'s events calendar - Phoenix has no
# DoStuff Media presence either). The site's calendar page filters by
# category client-side only (a "picnic-tag" widget with no server-rendered
# per-event category in the page source), but clicking a tag revealed the
# AJAX endpoint it actually calls - _picnic_list_ajax.php?ds=...&de=...&ti=
# (date range + tag id) - which returns the same .pcrd card markup as the
# main calendar page. That's used directly here, both for date-range
# filtering (sidestepping the main page's unreliable "today") and for
# splitting events into Concerts/Sports/Community by tag id.

function Parse-DtphxHtml {
  param([string]$html, [string]$category = "community")
  $events = @()
  $starts = [regex]::Matches($html, '<a class="pcrd" href="(?<permalink>[^"]+)">')
  for ($i = 0; $i -lt $starts.Count; $i++) {
    $m = $starts[$i]
    $blockStart = $m.Index
    $blockEnd = if ($i + 1 -lt $starts.Count) { $starts[$i + 1].Index } else { [Math]::Min($html.Length, $blockStart + 2000) }
    $block = $html.Substring($blockStart, $blockEnd - $blockStart)

    $titleMatch = [regex]::Match($block, '<div class="pcrd-content-headline">(?<t>[^<]+)</div>')
    if (-not $titleMatch.Success) { continue }

    $venueMatch = [regex]::Match($block, '<div class="pcrd-content-venue"><span>.*?</span>(?<v>[^<]+)</div>')
    $timeMatch  = [regex]::Match($block, '<div class="pcrd-content-time"><span>.*?</span>\s*(?<time>[^<]+)</div>')
    $dayMatch   = [regex]::Match($block, '<div class="pcrd-date-day">(?<day>\d+)</div>')
    $monthMatch = [regex]::Match($block, '<div class="pcrd-date-month">(?<month>[A-Za-z]+)</div>')

    $startDate = $null
    if ($dayMatch.Success -and $monthMatch.Success) {
      try {
        $monthNum = [datetime]::ParseExact($monthMatch.Groups['month'].Value, "MMM", [System.Globalization.CultureInfo]::InvariantCulture).Month
        $day = [int]$dayMatch.Groups['day'].Value
        $eventDate = Get-Date -Year (Get-Date).Year -Month $monthNum -Day $day -Hour 0 -Minute 0 -Second 0
        # Cards never include a year - if that lands more than a month in the
        # past (e.g. a next7 page spanning a Dec->Jan year boundary), it
        # actually belongs to next year.
        if ($eventDate -lt (Get-Date).Date.AddDays(-30)) { $eventDate = $eventDate.AddYears(1) }

        $hour = 0
        $minute = 0
        if ($timeMatch.Success) {
          # Some cards show a range ("10am - 5pm") - only the start time matters.
          $timeParse = [regex]::Match($timeMatch.Groups['time'].Value, '(?<h>\d{1,2})(:(?<m>\d{2}))?\s*(?<ap>[AaPp][Mm])')
          if ($timeParse.Success) {
            $hour = [int]$timeParse.Groups['h'].Value
            $minute = if ($timeParse.Groups['m'].Success) { [int]$timeParse.Groups['m'].Value } else { 0 }
            $ap = $timeParse.Groups['ap'].Value.ToLower()
            if ($ap -eq "pm" -and $hour -ne 12) { $hour += 12 }
            if ($ap -eq "am" -and $hour -eq 12) { $hour = 0 }
          }
        }
        $eventDate = $eventDate.AddHours($hour).AddMinutes($minute)
        # Arizona doesn't observe daylight saving, so -07:00 is correct year-round.
        $startDate = $eventDate.ToString("yyyy-MM-ddTHH:mm") + "-07:00"
      } catch {}
    }

    $events += [PSCustomObject]@{
      title     = [System.Net.WebUtility]::HtmlDecode($titleMatch.Groups['t'].Value.Trim())
      permalink = $m.Groups['permalink'].Value
      venue     = if ($venueMatch.Success) { [System.Net.WebUtility]::HtmlDecode($venueMatch.Groups['v'].Value.Trim()) } else { $null }
      city      = "Phoenix"
      startDate = $startDate
      category  = $category
      lat       = $null
      lon       = $null
    }
  }
  return $events
}

# Tag ids from the site's own category picker (data-tagid on its picnic-tag
# elements). Everything that isn't Concerts, Sports, or Culinary is bucketed
# as "community" by subtraction below - there's no single "everything else" tag.
$DtphxTagIds = @{ concerts = "7"; sports = "36"; food = "10" }

# Fetches all four of dtphx's tag-filtered views (Concerts/Sports/Food/
# everything) for a date range in parallel, running only the cache misses.
function Get-DtphxEventsForRange {
  param([string]$startDate, [string]$endDate)
  $tags = @(
    @{ TagId = $DtphxTagIds.concerts; Category = "concerts" }
    @{ TagId = $DtphxTagIds.sports; Category = "sports" }
    @{ TagId = $DtphxTagIds.food; Category = "food" }
    @{ TagId = ""; Category = "community" }
  )
  $urlFor = { param($t) "https://dtphx.org/_templates/_picnic_list_ajax.php?ds=$startDate&de=$endDate&ti=$($t.TagId)" }
  $cacheKeyFor = { param($t) "dtphx|$startDate|$endDate|$($t.TagId)" }

  $missing = @($tags | Where-Object { -not (Test-EventsCacheFresh -cacheKey (& $cacheKeyFor $_) -ttlMinutes 15) })

  if ($missing.Count -gt 0) {
    $htmlByUrl = Get-UrlsParallel -urls ($missing | ForEach-Object { & $urlFor $_ })
    foreach ($t in $missing) {
      $html = $htmlByUrl[(& $urlFor $t)]
      $parsed = if ($html) { Parse-DtphxHtml -html $html -category $t.Category } else { @() }
      Set-EventsCache -cacheKey (& $cacheKeyFor $t) -parsed $parsed -fetchSucceeded ([bool]$html)
    }
  }

  $byCategory = @{}
  foreach ($t in $tags) { $byCategory[$t.Category] = @($script:eventsCache[(& $cacheKeyFor $t)]) }

  $taggedPermalinks = @{}
  foreach ($e in (@($byCategory.concerts) + @($byCategory.sports) + @($byCategory.food))) {
    if ($e.permalink) { $taggedPermalinks[$e.permalink] = $true }
  }
  $community = $byCategory.community | Where-Object { $_.permalink -and -not $taggedPermalinks.ContainsKey($_.permalink) }

  return @($byCategory.concerts) + @($byCategory.sports) + @($byCategory.food) + @($community) | Where-Object { $_.permalink } | Sort-Object -Property permalink -Unique
}

function Get-DtphxEventsJson {
  param([string]$specificDate = $null)

  if ($specificDate) {
    $target = $null
    try { $target = [datetime]::ParseExact($specificDate, "yyyy-MM-dd", $null) } catch {}
    if (-not $target) { return "[]" }

    $dayEvents = @(Get-DtphxEventsForRange -startDate $specificDate -endDate $specificDate)
    $matching = $dayEvents | Where-Object {
      $_.startDate -and (([datetime]$_.startDate).Date -eq $target.Date)
    }
    $matching = Merge-EventbriteBackfill -existingEvents $matching -cityKey "phx" -startDate $specificDate -endDate $specificDate
    $matching = $matching | Sort-Object { [datetime]$_.startDate }

    if ($matching.Count -eq 0) { return "[]" }
    $json = $matching | ConvertTo-Json -Depth 3
    if ($matching.Count -eq 1) { $json = "[$json]" }
    return $json
  }

  # dtphx's own "today" concept turned out to run a day ahead of Phoenix for
  # a chunk of every evening (likely a UTC-vs-Arizona mixup on their end),
  # which would silently drop every remaining event tonight. Sidestep that
  # entirely by computing Phoenix's real date ourselves (fixed UTC-7, no
  # daylight saving) and requesting that exact range - the same approach
  # already used for the DoStuff cities above, which never trust a site's
  # own "today" either.
  $phoenixNow = (Get-Date).ToUniversalTime().AddHours(-7)
  $phoenixToday = $phoenixNow.Date
  $phoenixTomorrow = $phoenixToday.AddDays(1)
  $todayStart = $phoenixToday

  $all = @(Get-DtphxEventsForRange -startDate $phoenixToday.ToString("yyyy-MM-dd") -endDate $phoenixTomorrow.ToString("yyyy-MM-dd"))
  $upcoming = $all | Where-Object {
    -not $_.startDate -or (([datetime]$_.startDate) -ge $todayStart)
  }
  $upcoming = Merge-EventbriteBackfill -existingEvents $upcoming -cityKey "phx" -startDate $phoenixToday.ToString("yyyy-MM-dd") -endDate $phoenixTomorrow.ToString("yyyy-MM-dd")
  $upcoming = $upcoming | Sort-Object {
    if ($_.startDate) { try { [datetime]$_.startDate } catch { [datetime]::MaxValue } } else { [datetime]::MaxValue }
  }

  if ($upcoming.Count -eq 0) { return "[]" }
  $json = $upcoming | ConvertTo-Json -Depth 3
  if ($upcoming.Count -eq 1) { $json = "[$json]" }
  return $json
}

# ---- Eventbrite backfill for Sports/Food ----
#
# Every primary source above is fundamentally a nightlife/concert calendar,
# so on any given day-or-two window Sports and Food listings are thin to
# nonexistent - that's real event density, not a scraping bug. Eventbrite's
# per-city, per-category browse pages ("/d/<state>--<city>/sports--events/")
# embed a JSON-LD ItemList with real event data (title, url, venue, lat/lon)
# that fills a lot of that gap. The one real limitation: that embedded data
# is date-only, with no time-of-day - so these entries are flagged
# hasTime=$false and the client shows just a date for them, omitting a
# fabricated or misleading time.

$EventbriteCitySlugs = @{
  sea = "wa--seattle"; pdx = "or--portland"; atx = "tx--austin"; nyc = "ny--new-york"
  chi = "il--chicago"; den = "co--denver"; bna = "tn--nashville"; lax = "ca--los-angeles"
  bay = "ca--san-francisco"; reno = "nv--reno"; phx = "az--phoenix"
}

# Windows tz ids (not IANA - this runs on Windows PowerShell) used only to
# compute a correct, DST-aware UTC offset for Eventbrite's date-only entries.
$CityWindowsTz = @{
  sea = "Pacific Standard Time"; pdx = "Pacific Standard Time"; atx = "Central Standard Time"
  nyc = "Eastern Standard Time"; chi = "Central Standard Time"; den = "Mountain Standard Time"
  bna = "Central Standard Time"; lax = "Pacific Standard Time"; bay = "Pacific Standard Time"
  reno = "Pacific Standard Time"; phx = "US Mountain Standard Time" # Arizona - no daylight saving
}

function Get-CityUtcOffsetString {
  param([string]$cityKey, [datetime]$date)
  $winTzId = $CityWindowsTz[$cityKey]
  if (-not $winTzId) { return "+00:00" }
  try {
    $tz = [System.TimeZoneInfo]::FindSystemTimeZoneById($winTzId)
    $offset = $tz.GetUtcOffset($date)
    $sign = if ($offset.Ticks -ge 0) { "+" } else { "-" }
    # :D2 requires an integral type - [Math]::Floor/modulo on a double throws
    # "Format specifier was invalid" without these casts.
    $hours = [int][Math]::Floor([Math]::Abs($offset.TotalMinutes) / 60)
    $minutes = [int]([Math]::Abs($offset.TotalMinutes) % 60)
    return "{0}{1:D2}:{2:D2}" -f $sign, $hours, $minutes
  } catch {
    return "+00:00"
  }
}

function Parse-EventbriteJson {
  param([string]$html, [string]$category, [string]$cityKey)
  $events = @()
  $blocks = [regex]::Matches($html, '<script type="application/ld\+json">\s*(?<json>[\[\{].*?[\]\}])\s*</script>', [System.Text.RegularExpressions.RegexOptions]::Singleline)
  $seenUrls = @{}
  foreach ($block in $blocks) {
    $parsed = $null
    try { $parsed = $block.Groups['json'].Value | ConvertFrom-Json } catch { continue }
    $items = $parsed.itemListElement
    if (-not $items) { continue }
    foreach ($li in $items) {
      $item = $li.item
      # Breadcrumb ItemLists share this same shape but their entries have no
      # startDate - that's what distinguishes an actual event row here.
      if (-not $item -or -not $item.startDate -or -not $item.name -or -not $item.url) { continue }
      if ($seenUrls.ContainsKey($item.url)) { continue }
      $seenUrls[$item.url] = $true

      $startDate = $null
      try {
        $eventDate = [datetime]::ParseExact($item.startDate, "yyyy-MM-dd", $null)
        $offsetStr = Get-CityUtcOffsetString -cityKey $cityKey -date $eventDate
        $startDate = $eventDate.ToString("yyyy-MM-ddT00:00") + $offsetStr
      } catch { continue }

      $events += [PSCustomObject]@{
        title     = $item.name
        permalink = $item.url
        venue     = if ($item.location -and $item.location.name) { $item.location.name } else { $null }
        city      = $null
        startDate = $startDate
        category  = $category
        lat       = if ($item.location -and $item.location.geo -and $item.location.geo.latitude) { [double]$item.location.geo.latitude } else { $null }
        lon       = if ($item.location -and $item.location.geo -and $item.location.geo.longitude) { [double]$item.location.geo.longitude } else { $null }
        hasTime   = $false
      }
    }
  }
  return $events
}

# Fetches the Sports and Food-and-drink browse pages for a city in
# parallel (only the ones not already cached).
function Get-EventbriteEventsBatch {
  param([string]$cityKey)
  $slug = $EventbriteCitySlugs[$cityKey]
  if (-not $slug) { return @() }

  $categories = @(
    @{ Slug = "sports"; Category = "sports" }
    @{ Slug = "food-and-drink"; Category = "food" }
  )
  $urlFor = { param($c) "https://www.eventbrite.com/d/$slug/$($c.Slug)--events/" }
  $cacheKeyFor = { param($c) "eventbrite|$cityKey|$($c.Slug)" }

  $missing = @($categories | Where-Object { -not (Test-EventsCacheFresh -cacheKey (& $cacheKeyFor $_) -ttlMinutes 20) })

  if ($missing.Count -gt 0) {
    $htmlByUrl = Get-UrlsParallel -urls ($missing | ForEach-Object { & $urlFor $_ })
    foreach ($c in $missing) {
      $html = $htmlByUrl[(& $urlFor $c)]
      $parsed = if ($html) { Parse-EventbriteJson -html $html -category $c.Category -cityKey $cityKey } else { @() }
      Set-EventsCache -cacheKey (& $cacheKeyFor $c) -parsed $parsed -fetchSucceeded ([bool]$html)
    }
  }

  $all = @()
  foreach ($c in $categories) { $all += @($script:eventsCache[(& $cacheKeyFor $c)]) }
  return $all
}

# Fills in Sports/Food from Eventbrite for whatever date range a primary
# source just returned, skipping anything that's a same-title/same-day match
# for an event the primary source already has (cheap de-dup - permalinks
# never match across sources, so title+date is what's available).
# Plain [datetime] casts of an offset-bearing ISO string silently convert to
# the SERVER machine's local timezone (Kind=Local) before exposing .Date -
# harmless for instant comparisons (the underlying instant is unchanged) but
# wrong for "which calendar day is this" questions, since that answer
# depends on the event's own city, not whatever machine happens to be
# running serve.ps1. Every Eventbrite entry is anchored at exactly midnight
# in its city's offset, which is the single worst case for that shift to
# flip the result to the wrong day - so date-only comparisons here go
# through DateTimeOffset instead, which preserves the original offset.
function Get-EventDateOnly {
  param([string]$iso)
  if (-not $iso) { return $null }
  try { return [System.DateTimeOffset]::Parse($iso).Date } catch { return $null }
}

function Merge-EventbriteBackfill {
  param([array]$existingEvents, [string]$cityKey, [string]$startDate, [string]$endDate)
  if (-not $EnableEventbriteBackfill) { return $existingEvents }
  if (-not $EventbriteCitySlugs.ContainsKey($cityKey)) { return $existingEvents }

  $ebAll = Get-EventbriteEventsBatch -cityKey $cityKey

  $rangeStart = $null; $rangeEnd = $null
  try {
    $rangeStart = ([datetime]::ParseExact($startDate, "yyyy-MM-dd", $null)).Date
    $rangeEnd = ([datetime]::ParseExact($endDate, "yyyy-MM-dd", $null)).Date
  } catch { return $existingEvents }

  $existingKeys = @{}
  foreach ($e in $existingEvents) {
    $d = Get-EventDateOnly $e.startDate
    if ($e.title -and $d) {
      $key = "$($e.title.ToLower().Trim())|$($d.ToString('yyyy-MM-dd'))"
      $existingKeys[$key] = $true
    }
  }

  $fresh = @($ebAll) | Where-Object {
    $d = Get-EventDateOnly $_.startDate
    if (-not $d) { return $false }
    if ($d -lt $rangeStart -or $d -gt $rangeEnd) { return $false }
    $key = "$($_.title.ToLower().Trim())|$($d.ToString('yyyy-MM-dd'))"
    -not $existingKeys.ContainsKey($key)
  }

  return @($existingEvents) + @($fresh)
}

# ---- static file + API server ----
#
# A single request must never be able to bring the whole server down. In
# particular: a slow /api/events lookup can outlive the browser's interest
# in it (e.g. the user switched cities and the page aborted the fetch) - by
# the time we try to write the response, the client connection is gone and
# OutputStream.Write/Close will throw. Catch broadly here so that just fails
# the one request instead of unhandled-exception-ing out of the while loop
# and killing the process.

while ($listener.IsListening) {
  try {
    $context = $listener.GetContext()
  } catch {
    continue
  }
  $request = $context.Request
  $response = $context.Response
  try {
    $path = $request.Url.LocalPath

    if ($path -eq "/api/events") {
      $cityKey = $request.QueryString["city"]
      $specificDate = $request.QueryString["date"]
      $domain = $CityDomains[$cityKey]
      $json = if ($cityKey -eq "reno") {
        Get-RenoSceneEventsJson -specificDate $specificDate
      } elseif ($cityKey -eq "phx") {
        Get-DtphxEventsJson -specificDate $specificDate
      } elseif ($domain) {
        Get-UpcomingEventsJson -domain $domain -cityKey $cityKey -specificDate $specificDate
      } else {
        "[]"
      }
      $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
      $response.ContentType = "application/json"
      $response.Headers.Add("Access-Control-Allow-Origin", "*")
      $response.ContentLength64 = $bytes.Length
      $response.OutputStream.Write($bytes, 0, $bytes.Length)
    } else {
      if ($path -eq "/") { $path = "/index.html" }
      $filePath = Join-Path $root ($path.TrimStart("/"))
      if (Test-Path $filePath -PathType Leaf) {
        $ext = [System.IO.Path]::GetExtension($filePath)
        $contentType = $mime[$ext]
        if (-not $contentType) { $contentType = "application/octet-stream" }
        $bytes = [System.IO.File]::ReadAllBytes($filePath)
        $response.ContentType = $contentType
        # This is a local dev server that gets edited often - never let the
        # browser cache index.html/app.js/style.css across reloads, or a
        # code change can look like it "didn't work" when it's just stale.
        $response.Headers.Add("Cache-Control", "no-cache, no-store, must-revalidate")
        $response.Headers.Add("Pragma", "no-cache")
        $response.ContentLength64 = $bytes.Length
        $response.OutputStream.Write($bytes, 0, $bytes.Length)
      } else {
        $response.StatusCode = 404
        $notFound = [System.Text.Encoding]::UTF8.GetBytes("Not found: $path")
        $response.OutputStream.Write($notFound, 0, $notFound.Length)
      }
    }
  } catch {
    Write-Output "Request error ($($request.Url)): $($_.Exception.Message)"
  } finally {
    try { $response.OutputStream.Close() } catch {}
  }
}
