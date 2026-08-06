/*
 * FILE NOTES (for future updates)
 * File: sources/chicago.js
 * Purpose: Data adapter for Chicago, IL. Pulls incident-level reports from
 *          the City of Chicago's public Socrata API (dataset ijzp-q8t2,
 *          "Crimes - 2001 to Present"). Verified working 2026-08-06 with
 *          records current to within about one week.
 * Key fields used from the feed:
 *          date, primary_type, description, block, arrest, latitude,
 *          longitude, location (Point), case_number
 * Query technique: Socrata SoQL within_circle(location, lat, lng, meters)
 *          plus a date lower bound. Results capped at MAX_ROWS.
 * Data notes: Chicago publishes with roughly a 7-day lag (the UI shows a
 *          note saying so). Some rows have redacted coordinates (sensitive
 *          cases) - those are skipped, same as other adapters.
 * Env var: SOCRATA_APP_TOKEN (optional, set on Render) raises rate limits.
 * Change log:
 *   2026-08-06 - Initial version. (latest change)
 */

"use strict";

const { classify } = require("./severity");

const DATASET_URL = "https://data.cityofchicago.org/resource/ijzp-q8t2.json";
const MAX_ROWS = 2000;

const adapter = {
  id: "chicago",
  name: "Chicago, IL",
  attribution: "Data: City of Chicago Data Portal (data.cityofchicago.org)",
  // Rough bounding box for Chicago city limits (including the O'Hare arm).
  bounds: { minLat: 41.62, maxLat: 42.05, minLng: -87.95, maxLng: -87.5 },
  coverageNote:
    "Chicago incident reports are published with about a one-week delay.",

  contains(lat, lng) {
    const b = this.bounds;
    return lat >= b.minLat && lat <= b.maxLat && lng >= b.minLng && lng <= b.maxLng;
  },

  /**
   * Fetch incidents within a circle and time window.
   * @param {number} lat - center latitude
   * @param {number} lng - center longitude
   * @param {number} radiusMeters - search radius in meters
   * @param {number} days - how many days back to search
   * @returns {Promise<{incidents: Array, truncated: boolean}>}
   */
  async fetchIncidents(lat, lng, radiusMeters, days) {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 19); // Socrata floating timestamp format: YYYY-MM-DDTHH:MM:SS

    const where =
      `within_circle(location, ${lat}, ${lng}, ${Math.round(radiusMeters)})` +
      ` AND date > '${since}'`;

    const params = new URLSearchParams({
      $where: where,
      $order: "date DESC",
      $limit: String(MAX_ROWS),
      $select:
        "case_number,date,primary_type,description,block,arrest,latitude,longitude"
    });

    const headers = { Accept: "application/json" };
    if (process.env.SOCRATA_APP_TOKEN) {
      headers["X-App-Token"] = process.env.SOCRATA_APP_TOKEN;
    }

    const response = await fetch(`${DATASET_URL}?${params.toString()}`, { headers });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(
        `Chicago data feed returned HTTP ${response.status}. ${body.slice(0, 300)}`
      );
    }
    const rows = await response.json();

    const incidents = [];
    for (const row of rows) {
      const rowLat = parseFloat(row.latitude);
      const rowLng = parseFloat(row.longitude);
      if (!isFinite(rowLat) || !isFinite(rowLng)) continue; // skip redacted/missing coordinates

      const rawCategory = row.primary_type || row.description || "Unknown";
      const severity = classify(`${row.primary_type || ""} ${row.description || ""}`);
      if (severity === "excluded") continue; // non-crime records stay off the map

      incidents.push({
        id: row.case_number || null,
        datetime: row.date || null,
        category: rawCategory,
        description: row.description
          ? `${rawCategory}: ${row.description}`
          : rawCategory,
        severity: severity,
        resolution: row.arrest === true || row.arrest === "true" ? "Arrest made" : "",
        area: "",
        approxLocation: row.block || "",
        lat: rowLat,
        lng: rowLng
      });
    }

    return { incidents, truncated: rows.length >= MAX_ROWS };
  }
};

module.exports = adapter;

// I did no harm and this file is not truncated
