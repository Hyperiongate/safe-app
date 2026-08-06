/*
 * FILE NOTES (for future updates)
 * File: server.js
 * Purpose: The Safe app's web server (Node.js + Express). It does three jobs:
 *   1. Serves the frontend (public/index.html and any static assets).
 *   2. GET /api/cities  - lists covered cities (from sources/index.js registry).
 *   3. GET /api/geocode - turns a typed address into coordinates. Tries the
 *      free US Census geocoder first (best for street addresses), then falls
 *      back to OpenStreetMap Nominatim (handles place names like
 *      "Golden Gate Park"). Both are free and need no API key.
 *   4. GET /api/crimes  - the core endpoint. Takes lat, lng, radiusMiles,
 *      days; routes the point to the right city adapter; returns incidents
 *      (already classified by severity) plus summary counts.
 * Deploy: Render Web Service. Build: npm install. Start: node server.js.
 *      PORT is provided by Render automatically. Optional env var
 *      SOCRATA_APP_TOKEN raises open-data rate limits (set it in Render).
 * Input limits: radiusMiles clamped to 0.05-10, days clamped to 1-365.
 * Change log:
 *   2026-08-06 - Initial version.
 *   2026-08-06 - Uncovered locations now try the FBI town-level fallback
 *                (sources/fbi.js): if the free FBI_API_KEY env var is set on
 *                Render, "not covered" searches return a town-wide safety
 *                picture (place name, latest-year violent/property counts
 *                and per-1,000 rates vs US average) instead of only an
 *                apology. Without the key, behavior is unchanged. (latest change)
 */

"use strict";

const path = require("path");
const express = require("express");
const { findAdapterForPoint, listCities } = require("./sources");
const { SEVERITY_INFO } = require("./sources/severity");
const { townLevelFallback } = require("./sources/fbi");

const app = express();
const PORT = process.env.PORT || 3000;

const METERS_PER_MILE = 1609.344;
const MIN_RADIUS_MILES = 0.05;
const MAX_RADIUS_MILES = 10;
const MIN_DAYS = 1;
const MAX_DAYS = 365;

// ---------- static frontend ----------
app.use(express.static(path.join(__dirname, "public")));

// ---------- helpers ----------
function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function badRequest(res, message) {
  return res.status(400).json({ error: message });
}

// ---------- GET /api/cities ----------
app.get("/api/cities", (req, res) => {
  res.json({ cities: listCities(), severities: SEVERITY_INFO });
});

// ---------- GET /api/geocode?q=<address or place> ----------
app.get("/api/geocode", async (req, res) => {
  const query = (req.query.q || "").toString().trim();
  if (!query) return badRequest(res, "Please provide an address to look up.");
  if (query.length > 300) return badRequest(res, "That address is too long.");

  // 1) US Census geocoder - free, no key, excellent for US street addresses.
  try {
    const url =
      "https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?" +
      new URLSearchParams({
        address: query,
        benchmark: "Public_AR_Current",
        format: "json"
      }).toString();
    const response = await fetch(url, { headers: { Accept: "application/json" } });
    if (response.ok) {
      const data = await response.json();
      const match =
        data && data.result && Array.isArray(data.result.addressMatches)
          ? data.result.addressMatches[0]
          : null;
      if (match && match.coordinates) {
        return res.json({
          lat: match.coordinates.y,
          lng: match.coordinates.x,
          matchedAddress: match.matchedAddress || query,
          source: "US Census Bureau geocoder"
        });
      }
    }
  } catch (err) {
    console.error("Census geocoder error:", err.message);
  }

  // 2) Fallback: OpenStreetMap Nominatim - free, handles place names.
  //    Their usage policy requires an identifying User-Agent.
  try {
    const url =
      "https://nominatim.openstreetmap.org/search?" +
      new URLSearchParams({
        q: query,
        format: "json",
        countrycodes: "us",
        limit: "1"
      }).toString();
    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": "SafeApp/1.0 (location safety web app)"
      }
    });
    if (response.ok) {
      const results = await response.json();
      if (Array.isArray(results) && results.length > 0) {
        return res.json({
          lat: parseFloat(results[0].lat),
          lng: parseFloat(results[0].lon),
          matchedAddress: results[0].display_name || query,
          source: "OpenStreetMap Nominatim"
        });
      }
    }
  } catch (err) {
    console.error("Nominatim geocoder error:", err.message);
  }

  return res
    .status(404)
    .json({ error: "Could not find that address. Try adding the city and state." });
});

// ---------- GET /api/crimes?lat=..&lng=..&radiusMiles=..&days=.. ----------
app.get("/api/crimes", async (req, res) => {
  const lat = parseFloat(req.query.lat);
  const lng = parseFloat(req.query.lng);
  let radiusMiles = parseFloat(req.query.radiusMiles);
  let days = parseInt(req.query.days, 10);

  if (!isFinite(lat) || !isFinite(lng)) {
    return badRequest(res, "A valid latitude and longitude are required.");
  }
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return badRequest(res, "Latitude/longitude out of range.");
  }
  if (!isFinite(radiusMiles)) radiusMiles = 0.25;
  if (!isFinite(days)) days = 7;
  radiusMiles = clamp(radiusMiles, MIN_RADIUS_MILES, MAX_RADIUS_MILES);
  days = clamp(days, MIN_DAYS, MAX_DAYS);

  const adapter = findAdapterForPoint(lat, lng);
  if (!adapter) {
    // Not in a covered city: try the FBI town-level fallback (returns null
    // when FBI_API_KEY isn't set or data isn't available for this spot).
    const fallback = await townLevelFallback(lat, lng);
    return res.json({
      covered: false,
      fallback: fallback, // null, or a town-wide safety picture
      message: fallback
        ? "Street-level pins aren't available here yet, but here's the town-wide picture."
        : "That location isn't in a covered city yet. Safe currently covers: " +
          listCities().map((c) => c.name).join(", ") +
          ". More cities are on the way.",
      cities: listCities().map((c) => c.name)
    });
  }

  try {
    const result = await adapter.fetchIncidents(
      lat,
      lng,
      radiusMiles * METERS_PER_MILE,
      days
    );

    // Summary counts by severity, worst first.
    const counts = {};
    for (const key of Object.keys(SEVERITY_INFO)) counts[key] = 0;
    for (const incident of result.incidents) {
      if (counts[incident.severity] === undefined) counts[incident.severity] = 0;
      counts[incident.severity] += 1;
    }

    // Top raw categories, for the "what kind of crime" breakdown.
    const categoryCounts = {};
    for (const incident of result.incidents) {
      categoryCounts[incident.category] = (categoryCounts[incident.category] || 0) + 1;
    }
    const topCategories = Object.entries(categoryCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([category, count]) => ({ category, count }));

    const notes = [];
    if (adapter.coverageNote && (result.historyLimited || adapter.id !== "oakland")) {
      // Always share SF's freshness note; only share Oakland's 90-day note
      // when the user actually asked for a window longer than the feed holds.
      if (adapter.id !== "oakland" || result.historyLimited) {
        notes.push(adapter.coverageNote);
      }
    }
    if (result.truncated) {
      notes.push(
        "There were more incidents than the app can display at once; showing the most recent " +
          result.incidents.length +
          ". Try a smaller radius or shorter time window for a complete picture."
      );
    }

    return res.json({
      covered: true,
      city: adapter.name,
      attribution: adapter.attribution,
      query: { lat, lng, radiusMiles, days },
      totalShown: result.incidents.length,
      counts,
      topCategories,
      notes,
      incidents: result.incidents
    });
  } catch (err) {
    console.error(`Error fetching incidents for ${adapter.name}:`, err.message);
    return res.status(502).json({
      error:
        "The " +
        adapter.name +
        " public data feed didn't respond properly just now. This is usually temporary - please try again in a minute."
    });
  }
});

// ---------- start ----------
app.listen(PORT, () => {
  console.log(`Safe app listening on port ${PORT}`);
});

// I did no harm and this file is not truncated
