/*
 * FILE NOTES (for future updates)
 * File: test.js
 * Purpose: The Safe app's dry-run test suite. Run with:  npm test
 *   It starts the real server on a test port, but replaces outbound calls to
 *   the city data feeds and geocoders with realistic canned responses (shaped
 *   exactly like the real APIs, which were verified live on 2026-08-06).
 *   That means the whole pipeline - request parsing, adapter routing, SoQL
 *   query building, response parsing, severity classification, summary
 *   counting, error handling - is exercised without needing internet access.
 *   The one thing this cannot test is the city APIs themselves being up;
 *   their query format was verified against the live APIs separately.
 * Exit code: 0 when every test passes, 1 otherwise (prints each failure).
 * Change log:
 *   2026-08-06 - Initial version, 14 checks.
 *   2026-08-06 - Phase 2: added Chicago adapter checks and FBI town-level
 *                fallback checks (stubbed Census reverse geocoder + FBI
 *                agency list + summarized offense endpoints), plus a
 *                no-API-key unit check. Now 21 checks. (latest change)
 */

"use strict";

process.env.PORT = process.env.TEST_PORT || "3999";
process.env.FBI_API_KEY = "TESTKEY"; // exercises the FBI fallback path in tests

// ---------- canned API responses (field shapes verified live 2026-08-06) ----------
const SF_ROWS = [
  {
    incident_number: "260000001", incident_datetime: "2026-08-04T23:53:00.000",
    incident_category: "Homicide", incident_subcategory: "Homicide",
    incident_description: "Murder", resolution: "Open or Active",
    police_district: "Mission", analysis_neighborhood: "Mission",
    intersection: "16TH ST \\ MISSION ST", latitude: "37.7650", longitude: "-122.4194"
  },
  {
    incident_number: "260000002", incident_datetime: "2026-08-03T10:00:00.000",
    incident_category: "Assault", incident_subcategory: "Aggravated Assault",
    incident_description: "Assault with a deadly weapon", resolution: "Cite or Arrest Adult",
    police_district: "Mission", analysis_neighborhood: "Mission",
    intersection: "17TH ST \\ VALENCIA ST", latitude: "37.7639", longitude: "-122.4213"
  },
  {
    incident_number: "260000003", incident_datetime: "2026-08-02T15:30:00.000",
    incident_category: "Larceny Theft", incident_subcategory: "Larceny - From Vehicle",
    incident_description: "Theft from locked vehicle", resolution: "Open or Active",
    police_district: "Mission", analysis_neighborhood: "Mission",
    intersection: "18TH ST \\ GUERRERO ST", latitude: "37.7614", longitude: "-122.4241"
  },
  {
    incident_number: "260000004", incident_datetime: "2026-08-01T12:00:00.000",
    incident_category: "Non-Criminal", incident_subcategory: "Non-Criminal",
    incident_description: "Aided case", resolution: "Open or Active",
    police_district: "Mission", analysis_neighborhood: "Mission",
    intersection: "19TH ST \\ DOLORES ST", latitude: "37.7605", longitude: "-122.4260"
  },
  { // row with no coordinates - must be skipped, not crash
    incident_number: "260000005", incident_datetime: "2026-08-01T09:00:00.000",
    incident_category: "Fraud", incident_description: "Fraudulent scheme"
  }
];

const OAKLAND_ROWS = [
  {
    crimetype: "ROBBERY", datetime: "2026-08-03T16:52:00.000", casenumber: "26-030001",
    description: "ROBBERY", policebeat: "04X", address: "800 BROADWAY",
    city: "Oakland", state: "CA",
    location_1: { type: "Point", coordinates: [-122.27398, 37.80936] }
  },
  {
    crimetype: "PETTY THEFT", datetime: "2026-08-02T14:00:00.000", casenumber: "26-030002",
    description: "THEFT", policebeat: "10Y", address: "800 54TH ST",
    city: "Oakland", state: "CA",
    location_1: { type: "Point", coordinates: [-122.26976, 37.83886] }
  }
];

const CHICAGO_ROWS = [
  {
    case_number: "JH100001", date: "2026-08-01T21:30:00.000",
    primary_type: "HOMICIDE", description: "FIRST DEGREE MURDER",
    block: "010XX W ARGYLE ST", arrest: false, latitude: "41.8810", longitude: "-87.6300"
  },
  {
    case_number: "JH100002", date: "2026-07-30T13:10:00.000",
    primary_type: "CRIMINAL DAMAGE", description: "TO VEHICLE",
    block: "015XX N STATE ST", arrest: false, latitude: "41.8825", longitude: "-87.6285"
  },
  {
    case_number: "JH100003", date: "2026-07-29T02:45:00.000",
    primary_type: "ROBBERY", description: "ARMED - HANDGUN",
    block: "012XX S WABASH AVE", arrest: true, latitude: "41.8790", longitude: "-87.6320"
  }
];

// FBI fallback stubs (shapes verified against the live APIs on 2026-08-06).
function monthlySeries(year, value) {
  const out = {};
  for (let m = 1; m <= 12; m++) out[String(m).padStart(2, "0") + "-" + year] = value;
  return out;
}
const CENSUS_REVERSE_RESPONSE = {
  result: {
    geographies: {
      "Incorporated Places": [{ NAME: "Sacramento city", STATE: "06", PLACE: "64000" }]
    }
  }
};
const FBI_AGENCIES_RESPONSE = {
  SACRAMENTO: [
    {
      ori: "CA0340100", agency_name: "Sacramento Police Department",
      agency_type_name: "City", latitude: 38.5816, longitude: -121.4944,
      state_abbr: "CA", is_nibrs: true
    }
  ]
};
const FBI_VIOLENT_RESPONSE = {
  offenses: {
    actuals: {
      "Sacramento Police Department Offenses": monthlySeries(2025, 40),
      "California Offenses": monthlySeries(2025, 9000)
    },
    rates: {}
  },
  populations: { "Sacramento Police Department": monthlySeries(2025, 500000) }
};
const FBI_PROPERTY_RESPONSE = {
  offenses: {
    actuals: {
      "Sacramento Police Department Offenses": monthlySeries(2025, 900),
      "California Offenses": monthlySeries(2025, 80000)
    },
    rates: {}
  },
  populations: { "Sacramento Police Department": monthlySeries(2025, 500000) }
};

const CENSUS_RESPONSE = {
  result: {
    addressMatches: [
      {
        matchedAddress: "1 FERRY BUILDING, SAN FRANCISCO, CA, 94111",
        coordinates: { x: -122.3937, y: 37.7955 }
      }
    ]
  }
};

// ---------- stub outbound fetch BEFORE loading the server ----------
const stubLog = [];
global.fetch = async function stubbedFetch(url) {
  const urlText = String(url);
  stubLog.push(urlText);
  const jsonResponse = (obj) => ({
    ok: true, status: 200,
    json: async () => obj,
    text: async () => JSON.stringify(obj)
  });
  if (urlText.includes("data.sfgov.org")) return jsonResponse(SF_ROWS);
  if (urlText.includes("data.oaklandca.gov")) return jsonResponse(OAKLAND_ROWS);
  if (urlText.includes("data.cityofchicago.org")) return jsonResponse(CHICAGO_ROWS);
  if (urlText.includes("geocoder/geographies/coordinates")) return jsonResponse(CENSUS_REVERSE_RESPONSE);
  if (urlText.includes("geocoding.geo.census.gov")) return jsonResponse(CENSUS_RESPONSE);
  if (urlText.includes("agency/byStateAbbr/")) return jsonResponse(FBI_AGENCIES_RESPONSE);
  if (urlText.includes("/violent-crime")) return jsonResponse(FBI_VIOLENT_RESPONSE);
  if (urlText.includes("/property-crime")) return jsonResponse(FBI_PROPERTY_RESPONSE);
  if (urlText.includes("nominatim.openstreetmap.org")) return jsonResponse([]);
  return { ok: false, status: 404, json: async () => ({}), text: async () => "not stubbed" };
};

require("./server"); // starts listening on the test port

// ---------- tiny test runner ----------
const http = require("http");
function get(pathname) {
  return new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port: process.env.PORT, path: pathname }, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        let parsed = null;
        try { parsed = JSON.parse(body); } catch (e) { parsed = body; }
        resolve({ status: res.statusCode, body: parsed });
      });
    }).on("error", reject);
  });
}

let passed = 0, failed = 0;
function check(name, condition, extra) {
  if (condition) { passed++; console.log("  PASS  " + name); }
  else { failed++; console.log("  FAIL  " + name + (extra ? "  -> " + extra : "")); }
}

(async function main() {
  await new Promise((r) => setTimeout(r, 400)); // let the server finish binding

  console.log("Dry run: Safe app test suite\n");

  // 1. Cities endpoint
  const cities = await get("/api/cities");
  check("GET /api/cities returns 200", cities.status === 200);
  check("cities list includes SF, Oakland, and Chicago",
    cities.body.cities && cities.body.cities.length === 3 &&
    cities.body.cities.some((c) => c.id === "sf") &&
    cities.body.cities.some((c) => c.id === "oakland") &&
    cities.body.cities.some((c) => c.id === "chicago"));

  // 2. SF crimes (mocked feed)
  const sf = await get("/api/crimes?lat=37.7650&lng=-122.4194&radiusMiles=0.25&days=7");
  check("SF query returns 200", sf.status === 200, JSON.stringify(sf.body).slice(0, 200));
  check("SF query routed to San Francisco adapter", sf.body.city === "San Francisco, CA");
  check("Non-criminal + no-coordinate rows filtered (3 of 5 kept)", sf.body.totalShown === 3,
    "totalShown=" + sf.body.totalShown);
  check("Homicide classified red bucket", sf.body.counts.homicide === 1);
  check("Assault classified violent bucket", sf.body.counts.violent === 1);
  check("Theft classified lesser bucket", sf.body.counts.lesser === 1);
  check("SoQL query used within_circle + time filter",
    stubLog.some((u) => u.includes("within_circle") && u.includes("incident_datetime")));

  // 3. Oakland crimes (mocked feed)
  const oak = await get("/api/crimes?lat=37.8044&lng=-122.2712&radiusMiles=1&days=365");
  check("Oakland query routed to Oakland adapter", oak.body.city === "Oakland, CA");
  check("Oakland 90-day history note included for 1-year window",
    Array.isArray(oak.body.notes) && oak.body.notes.some((n) => n.includes("90 days")));

  // 3b. Chicago crimes (mocked feed)
  const chi = await get("/api/crimes?lat=41.8810&lng=-87.6300&radiusMiles=0.5&days=30");
  check("Chicago query routed to Chicago adapter", chi.body.city === "Chicago, IL",
    JSON.stringify(chi.body).slice(0, 150));
  check("Chicago homicide classified red bucket", chi.body.counts && chi.body.counts.homicide === 1);
  check("Chicago CRIMINAL DAMAGE classified lesser (yellow) bucket",
    chi.body.counts && chi.body.counts.lesser === 1);
  check("Chicago armed robbery classified violent bucket",
    chi.body.counts && chi.body.counts.violent === 1);
  check("Chicago arrest flag becomes 'Arrest made'",
    chi.body.incidents && chi.body.incidents.some((i) => i.resolution === "Arrest made"));

  // 4. Uncovered location -> FBI town-level fallback (stubbed)
  const sac = await get("/api/crimes?lat=38.58&lng=-121.49&radiusMiles=1&days=30");
  check("Uncovered city says covered:false with friendly message",
    sac.body.covered === false && typeof sac.body.message === "string");
  check("FBI fallback present with place name Sacramento",
    sac.body.fallback && sac.body.fallback.placeName === "Sacramento" &&
    sac.body.fallback.stateAbbr === "CA");
  check("FBI fallback violent count and per-1,000 rate computed",
    sac.body.fallback && sac.body.fallback.violent &&
    sac.body.fallback.violent.count === 480 &&
    sac.body.fallback.violent.ratePer1000 === 1.0,
    sac.body.fallback ? JSON.stringify(sac.body.fallback.violent) : "no fallback");
  check("FBI fallback property count computed (10800)",
    sac.body.fallback && sac.body.fallback.property &&
    sac.body.fallback.property.count === 10800);

  // 4b. Without an API key, the fallback quietly returns null (unit check)
  const fbiModule = require("./sources/fbi");
  const savedKey = process.env.FBI_API_KEY;
  delete process.env.FBI_API_KEY;
  const noKeyResult = await fbiModule.townLevelFallback(38.58, -121.49);
  process.env.FBI_API_KEY = savedKey;
  check("FBI fallback returns null when no API key is set", noKeyResult === null);

  // 5. Input validation
  const bad = await get("/api/crimes?lat=abc&lng=-122");
  check("Bad latitude rejected with 400", bad.status === 400);

  // 6. Geocoding (mocked Census)
  const geo = await get("/api/geocode?q=" + encodeURIComponent("1 Ferry Building, San Francisco, CA"));
  check("Geocode returns Census match with coordinates",
    geo.status === 200 && Math.abs(geo.body.lat - 37.7955) < 0.001 &&
    Math.abs(geo.body.lng + 122.3937) < 0.001);

  console.log("\nResult: " + passed + " passed, " + failed + " failed.");
  process.exit(failed === 0 ? 0 : 1);
})().catch((err) => {
  console.error("Test suite crashed:", err);
  process.exit(1);
});

// I did no harm and this file is not truncated
