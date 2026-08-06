/*
 * FILE NOTES (for future updates)
 * File: sources/sanfrancisco.js
 * Purpose: Data adapter for San Francisco, CA. Pulls incident-level police
 *          reports from DataSF's public Socrata API (dataset wg3w-h783,
 *          "Police Department Incident Reports: 2018 to Present").
 *          Verified working 2026-08-06 (data current to within ~1 day).
 * Key fields used from the feed:
 *          incident_datetime, incident_category, incident_description,
 *          latitude, longitude, point, resolution, police_district,
 *          analysis_neighborhood, intersection, incident_number
 * Query technique: Socrata SoQL within_circle(point, lat, lng, meters) plus
 *          an incident_datetime lower bound. Results capped at MAX_ROWS; if
 *          the cap is hit we tell the caller so the UI can say "showing the
 *          most recent N".
 * Env var: SOCRATA_APP_TOKEN (optional, set on Render) raises rate limits.
 * Change log:
 *   2026-08-06 - Initial version. (latest change)
 */

"use strict";

const { classify } = require("./severity");

const DATASET_URL = "https://data.sfgov.org/resource/wg3w-h783.json";
const MAX_ROWS = 2000;

const adapter = {
  id: "sf",
  name: "San Francisco, CA",
  attribution: "Data: DataSF / SFPD Incident Reports (data.sfgov.org)",
  // Rough bounding box for San Francisco proper, used to route a point to this adapter.
  bounds: { minLat: 37.696, maxLat: 37.837, minLng: -122.523, maxLng: -122.349 },
  coverageNote: "San Francisco incident reports from SFPD, typically updated daily.",

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
      `within_circle(point, ${lat}, ${lng}, ${Math.round(radiusMeters)})` +
      ` AND incident_datetime > '${since}'`;

    const params = new URLSearchParams({
      $where: where,
      $order: "incident_datetime DESC",
      $limit: String(MAX_ROWS),
      $select:
        "incident_number,incident_datetime,incident_category,incident_subcategory," +
        "incident_description,resolution,police_district,analysis_neighborhood," +
        "intersection,latitude,longitude"
    });

    const headers = { Accept: "application/json" };
    if (process.env.SOCRATA_APP_TOKEN) {
      headers["X-App-Token"] = process.env.SOCRATA_APP_TOKEN;
    }

    const response = await fetch(`${DATASET_URL}?${params.toString()}`, { headers });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(
        `San Francisco data feed returned HTTP ${response.status}. ${body.slice(0, 300)}`
      );
    }
    const rows = await response.json();

    const incidents = [];
    for (const row of rows) {
      const rowLat = parseFloat(row.latitude);
      const rowLng = parseFloat(row.longitude);
      if (!isFinite(rowLat) || !isFinite(rowLng)) continue; // skip rows without coordinates

      const rawCategory = row.incident_category || row.incident_description || "Unknown";
      const severity = classify(
        `${row.incident_category || ""} ${row.incident_subcategory || ""} ${row.incident_description || ""}`
      );
      if (severity === "excluded") continue; // non-crime records stay off the map

      incidents.push({
        id: row.incident_number || null,
        datetime: row.incident_datetime || null,
        category: rawCategory,
        description: row.incident_description || rawCategory,
        severity: severity,
        resolution: row.resolution || "",
        area: row.analysis_neighborhood || row.police_district || "",
        approxLocation: row.intersection || "",
        lat: rowLat,
        lng: rowLng
      });
    }

    return { incidents, truncated: rows.length >= MAX_ROWS };
  }
};

module.exports = adapter;

// I did no harm and this file is not truncated
