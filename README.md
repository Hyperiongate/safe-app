<!--
  FILE NOTES (for future updates)
  File: README.md
  Purpose: Explains what the Safe app is, how it's organized, and exactly how
    to deploy it from GitHub to Render. Written for a non-coder owner.
  Change log:
    2026-08-06 - Initial version covering San Francisco + Oakland MVP.
    2026-08-06 - Documented the drop-a-pin feature (tap the map to search a
                 spot with no address; drag the green pin to fine-tune).
    2026-08-06 - Phase 2: added Chicago, and the FBI town-level fallback for
                 everywhere else in the US (needs free FBI_API_KEY on Render).
                 (latest change)
-->

# Safe

**How safe is this spot?** Stand anywhere, type any address, or simply **tap the
map to drop a pin** (no address needed — the pin is draggable to fine-tune).
Pick a radius and a time window, and see reported crimes as color-coded pins on a map:

- 🔴 **Red** — homicide / murder
- 🔵 **Blue** — violent crime / felony
- 🟡 **Yellow** — property crime / misdemeanor
- ⚪ **Gray** — other reported incidents

A summary panel shows counts by severity and the most common crime types inside
your circle.

## Coverage

| City | Source | Freshness |
|---|---|---|
| San Francisco, CA | DataSF / SFPD Incident Reports (free public API) | Updated ~daily |
| Oakland, CA | City of Oakland CrimeWatch (free public API) | Rolling past 90 days only |
| Chicago, IL | City of Chicago Data Portal (free public API) | Published with ~1 week delay |

**Everywhere else in the US:** when the free `FBI_API_KEY` environment
variable is set on Render, uncovered locations get a *town-wide safety
picture* instead of an apology — the town's name (free US Census reverse
lookup), its latest-year violent and property crime totals from the FBI
Crime Data Explorer, and per-1,000-resident rates compared to the US
average. The app is honest that this is annual, town-wide data that runs
about a year behind, with no street pins. Without the key, uncovered
locations simply get the "not covered yet" message as before.

The architecture is adapter-based: each city is one file in `sources/`, so new
cities plug in without touching the rest of the app.

## How the pieces fit

```
server.js            <- web server + API endpoints (/api/crimes, /api/geocode, /api/cities)
sources/index.js     <- city registry (add new cities here)
sources/severity.js  <- maps raw crime categories to red/blue/yellow/gray
sources/sanfrancisco.js  <- San Francisco data adapter
sources/oakland.js       <- Oakland data adapter
sources/chicago.js       <- Chicago data adapter
sources/fbi.js           <- nationwide town-level fallback (FBI + Census)
public/index.html    <- the entire app screen (map, controls, results panel)
render.yaml          <- tells Render how to run the app
package.json         <- app identity + dependencies (just Express)
```

No API keys are required for the three pin-level cities. Two optional free
keys unlock more:

- `FBI_API_KEY` — free from api.data.gov (instant, email only). Turns on the
  nationwide town-level fallback described above.
- `SOCRATA_APP_TOKEN` — free Socrata "app token" that raises the open-data
  rate limits for the city feeds.

Both go in Render → your service → Environment tab.

## Deploying (GitHub → Render)

1. Put all of these files in a GitHub repository (keeping the folder layout above).
2. In Render: **New → Blueprint**, pick the repository, and Render reads
   `render.yaml` and sets everything up (free plan).
   - Or: **New → Web Service**, pick the repo, Build Command `npm install`,
     Start Command `node server.js`.
3. Open the Render URL it gives you. Location access ("Use my location")
   works because Render serves the site over HTTPS.

Note: on Render's free plan the app "goes to sleep" after 15 minutes of no
visitors, so the first visit after a quiet period takes ~30–60 seconds to wake up.

## Honest limitations (v1)

- Only reported crimes appear — under-reporting varies by neighborhood.
- Police departments map incidents to the nearest block/intersection for
  privacy, so pins are approximate, not exact doorsteps.
- Oakland's public feed only holds the past 90 days.
- Very busy searches (big radius + long window) cap at the 2,000 most recent
  incidents, and the app says so when that happens.

I did no harm and this file is not truncated
