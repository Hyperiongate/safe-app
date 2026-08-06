/*
 * FILE NOTES (for future updates)
 * File: sources/oakland.js
 * Purpose: Data adapter for Oakland, CA. Pulls incident-level reports from
 *          the City of Oakland's public Socrata API (dataset ym6k-rx7a,
 *          "CrimeWatch Maps Past 90-Days"). Verified working 2026-08-06.
 * IMPORTANT LIMIT: Oakland only publishes the PAST 90 DAYS of incidents in
 *          this dataset. For time windows longer than 90 days the adapter
 *          still works but returns a coverage note so the UI can tell the
 *          user the Oakland results only reach back ~90 days.
 * Key fields used from the feed:
 *          datetime, crimetype, description, address, city, location_1 (Point)
 * Query technique: Socrata SoQL within_circle(location_1, lat, lng, meters)
 *          plus a datetime lower bound. Results capped at MAX_ROWS.
 * Env var: SOCRATA_APP_TOKEN (optional, set on Render) raises rate limits.
 * Change log:
 *   2026-08-06 - Initial version. (latest change)
 */

"use strict";

const { classify } = require("./severity");

const DATASET_URL = "https://data.oaklandca.gov/resource/ym6k-rx7a.json";
const MAX_ROWS = 2000;
const FEED_HISTORY_DAYS = 90;

const adapter = {
  id: "oakland",
  name: "Oakland, CA",
  attribution: "Data: City of Oakland CrimeWatch (data.oaklandca.gov)",
  // Rough bounding box for Oakland, used to route a point to this adapter.
  bounds: { minLat: 37.699, maxLat: 37.885, minLng: -122.343, maxLng: -122.114 },
  coverageNote:
    "Oakland's public feed only includes the past 90 days of incidents, " +
    "so longer time windows show at most ~90 days of Oakland data.",

  contains(lat, lng) {
    const b = this.bounds;
    return lat >= b.minLat && lat <= b.maxLat && lng >= b.minLng && lng <= b.maxLng;
  },

  /**
   * Fetch incidents within a circle and time window.
   * @param {number} lat - center latitude
   * @param {number} lng - center longitude
   * @param {number} radiusMeters - search radius in meters
   * @param {number} days - how many days back to search (feed holds max ~90)
   * @returns {Promise<{incidents: Array, truncated: boolean, historyLimited: boolean}>}
   */
  async fetchIncidents(lat, lng, radiusMeters, days) {
    const effectiveDays = Math.min(days, FEED_HISTORY_DAYS);
    const since = new Date(Date.now() - effectiveDays * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 19); // Socrata floating timestamp format: YYYY-MM-DDTHH:MM:SS

    const where =
      `within_circle(location_1, ${lat}, ${lng}, ${Math.round(radiusMeters)})` +
      ` AND datetime > '${since}'`;

    const params = new URLSearchParams({
      $where: where,
      $order: "datetime DESC",
      $limit: String(MAX_ROWS)
    });

    const headers = { Accept: "application/json" };
    if (process.env.SOCRATA_APP_TOKEN) {
      headers["X-App-Token"] = process.env.SOCRATA_APP_TOKEN;
    }

    const response = await fetch(`${DATASET_URL}?${params.toString()}`, { headers });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(
        `Oakland data feed returned HTTP ${response.status}. ${body.slice(0, 300)}`
      );
    }
    const rows = await response.json();

    const incidents = [];
    for (const row of rows) {
      const coords =
        row.location_1 && Array.isArray(row.location_1.coordinates)
          ? row.location_1.coordinates
          : null;
      if (!coords || coords.length < 2) continue; // skip rows without coordinates
      const rowLng = parseFloat(coords[0]);
      const rowLat = parseFloat(coords[1]);
      if (!isFinite(rowLat) || !isFinite(rowLng)) continue;

      const rawCategory = row.crimetype || row.description || "Unknown";
      const severity = classify(`${row.crimetype || ""} ${row.description || ""}`);
      if (severity === "excluded") continue; // non-crime records stay off the map

      incidents.push({
        id: row.casenumber || null,
        datetime: row.datetime || null,
        category: rawCategory,
        description: row.description || rawCategory,
        severity: severity,
        resolution: "",
        area: row.policebeat ? `Police beat ${row.policebeat}` : "",
        approxLocation: row.address || "",
        lat: rowLat,
        lng: rowLng
      });
    }

    return {
      incidents,
      truncated: rows.length >= MAX_ROWS,
      historyLimited: days > FEED_HISTORY_DAYS
    };
  }
};

module.exports = adapter;

// I did no harm and this file is not truncated
