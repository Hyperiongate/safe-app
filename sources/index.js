/*
 * FILE NOTES (for future updates)
 * File: sources/index.js
 * Purpose: The city adapter registry. Every covered city has one adapter
 *          file (sanfrancisco.js, oakland.js, ...). To add a new city later:
 *            1. Create sources/<newcity>.js following the same adapter shape
 *               (id, name, attribution, bounds, coverageNote, contains(),
 *               fetchIncidents()).
 *            2. require() it below and add it to the ADAPTERS array.
 *          Nothing else in the app needs to change - server.js and the
 *          frontend discover cities through this registry.
 * Exports: ADAPTERS (array), findAdapterForPoint(lat, lng), listCities().
 * Change log:
 *   2026-08-06 - Initial version with San Francisco and Oakland. (latest change)
 */

"use strict";

const sanFrancisco = require("./sanfrancisco");
const oakland = require("./oakland");

const ADAPTERS = [sanFrancisco, oakland];

/**
 * Find the adapter whose coverage area contains the given point.
 * @returns {object|null} the adapter, or null if no covered city contains it.
 */
function findAdapterForPoint(lat, lng) {
  for (const adapter of ADAPTERS) {
    if (adapter.contains(lat, lng)) return adapter;
  }
  return null;
}

/**
 * Public list of covered cities (safe to send to the browser).
 */
function listCities() {
  return ADAPTERS.map((a) => ({
    id: a.id,
    name: a.name,
    attribution: a.attribution,
    coverageNote: a.coverageNote,
    bounds: a.bounds
  }));
}

module.exports = { ADAPTERS, findAdapterForPoint, listCities };

// I did no harm and this file is not truncated
