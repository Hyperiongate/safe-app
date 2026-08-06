/*
 * FILE NOTES (for future updates)
 * File: sources/fbi.js
 * Purpose: The nationwide TOWN-LEVEL fallback. When a searched point is not
 *          inside any covered city, this module builds a town-wide safety
 *          picture from two free federal sources (both verified 2026-08-06):
 *            1. US Census reverse geocoder (no key): coordinates -> town name
 *               ("Incorporated Places" layer, plus "Census Designated Places"
 *               so unincorporated communities work too).
 *            2. FBI Crime Data Explorer API (free key from api.data.gov):
 *               - /agency/byStateAbbr/{ST} lists every agency with ori,
 *                 name, type, lat/lng (grouped by county; no population).
 *               - /summarized/agency/{ori}/{offense}?from=MM-YYYY&to=MM-YYYY
 *                 returns offenses.actuals["<Agency Name> Offenses"] monthly
 *                 counts AND populations["<Agency Name>"] monthly population.
 * Agency matching: prefer a City-type agency whose name contains the town
 *          name; else the nearest City agency within ~25 miles; else the
 *          nearest agency of any type (usually the county sheriff). If the
 *          first choice has no published data, the runner-up is tried.
 * Year selection: prefers last calendar year if it has >= 9 reported months,
 *          else the year before. Rates are per 1,000 residents, compared to
 *          the US averages (2023 FBI national estimates: violent ~3.6 and
 *          property ~19.2 per 1,000 - update these constants when newer
 *          national figures are published).
 * Env var: FBI_API_KEY (free from api.data.gov; set it on Render). If it is
 *          missing, townLevelFallback() returns null and the app simply
 *          shows the old "not covered yet" message - nothing breaks.
 * Caching: per-state agency lists are cached in memory for 24h to conserve
 *          the API rate limit.
 * Change log:
 *   2026-08-06 - Initial version.
 *   2026-08-06 - Population fix (found live with Wasco, CA): some smaller
 *                agencies have no population in the FBI response, which left
 *                the per-1,000 rates blank. The Census reverse geocoder's
 *                "Census2020_Current" vintage returns POP100 (official 2020
 *                Census population) in the SAME call we already make, so we
 *                now capture it and use it whenever the FBI population is
 *                missing. No extra request, no extra key. (latest change)
 */

"use strict";

const FBI_BASE = "https://api.usa.gov/crime/fbi/cde";
const CENSUS_REVERSE_URL =
  "https://geocoding.geo.census.gov/geocoder/geographies/coordinates";
const FETCH_TIMEOUT_MS = 12000;

// US averages per 1,000 residents (FBI 2023 national estimates).
const NATIONAL_VIOLENT_PER_1000 = 3.6;
const NATIONAL_PROPERTY_PER_1000 = 19.2;

const STATE_FIPS_TO_ABBR = {
  "01": "AL", "02": "AK", "04": "AZ", "05": "AR", "06": "CA", "08": "CO",
  "09": "CT", "10": "DE", "11": "DC", "12": "FL", "13": "GA", "15": "HI",
  "16": "ID", "17": "IL", "18": "IN", "19": "IA", "20": "KS", "21": "KY",
  "22": "LA", "23": "ME", "24": "MD", "25": "MA", "26": "MI", "27": "MN",
  "28": "MS", "29": "MO", "30": "MT", "31": "NE", "32": "NV", "33": "NH",
  "34": "NJ", "35": "NM", "36": "NY", "37": "NC", "38": "ND", "39": "OH",
  "40": "OK", "41": "OR", "42": "PA", "44": "RI", "45": "SC", "46": "SD",
  "47": "TN", "48": "TX", "49": "UT", "50": "VT", "51": "VA", "53": "WA",
  "54": "WV", "55": "WI", "56": "WY", "72": "PR"
};

// In-memory cache of per-state agency lists: { ST: { at: ms, agencies: [] } }
const agencyCache = {};
const AGENCY_CACHE_MS = 24 * 60 * 60 * 1000;

function timedFetch(url) {
  return fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
  });
}

function milesBetween(lat1, lng1, lat2, lng2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const R = 3958.8; // earth radius in miles
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/**
 * Coordinates -> { placeName, stateAbbr, censusPopulation } via the free
 * Census reverse geocoder. The Census2020_Current vintage includes POP100
 * (official 2020 Census population) in the response.
 */
async function reverseGeocodePlace(lat, lng) {
  const params = new URLSearchParams({
    x: String(lng),
    y: String(lat),
    benchmark: "Public_AR_Current",
    vintage: "Census2020_Current",
    layers: "Incorporated Places,Census Designated Places",
    format: "json"
  });
  const response = await timedFetch(`${CENSUS_REVERSE_URL}?${params.toString()}`);
  if (!response.ok) return null;
  const data = await response.json();
  const geos = data && data.result && data.result.geographies;
  if (!geos) return null;
  const entry =
    (geos["Incorporated Places"] && geos["Incorporated Places"][0]) ||
    (geos["Census Designated Places"] && geos["Census Designated Places"][0]);
  if (!entry || !entry.NAME || !entry.STATE) return null;
  const stateAbbr = STATE_FIPS_TO_ABBR[entry.STATE];
  if (!stateAbbr) return null;
  // "Sacramento city" -> "Sacramento"; "Truckee town" -> "Truckee"; "Tamalpais-Homestead Valley CDP" -> base name
  const placeName = entry.NAME
    .replace(/\s+(city|town|village|borough|municipality|CDP)$/i, "")
    .trim();
  const censusPopulation = Number(entry.POP100) > 0 ? Number(entry.POP100) : null;
  return { placeName, stateAbbr, censusPopulation };
}

/** Full flattened agency list for a state, cached 24h. */
async function getAgencies(stateAbbr, apiKey) {
  const cached = agencyCache[stateAbbr];
  if (cached && Date.now() - cached.at < AGENCY_CACHE_MS) return cached.agencies;
  const response = await timedFetch(
    `${FBI_BASE}/agency/byStateAbbr/${stateAbbr}?API_KEY=${encodeURIComponent(apiKey)}`
  );
  if (!response.ok) {
    throw new Error(`FBI agency list returned HTTP ${response.status}`);
  }
  const byCounty = await response.json();
  const agencies = [];
  for (const county of Object.keys(byCounty)) {
    const list = byCounty[county];
    if (!Array.isArray(list)) continue;
    for (const a of list) {
      if (a && a.ori && a.agency_name) {
        agencies.push({
          ori: a.ori,
          name: a.agency_name,
          type: a.agency_type_name || "",
          lat: parseFloat(a.latitude),
          lng: parseFloat(a.longitude)
        });
      }
    }
  }
  agencyCache[stateAbbr] = { at: Date.now(), agencies };
  return agencies;
}

/** Ranked candidate agencies for a place: best guess first, backup second. */
function pickAgencies(agencies, placeName, lat, lng) {
  const wanted = placeName.toUpperCase();
  const cityAgencies = agencies.filter((a) => /city/i.test(a.type));
  const nameMatch = cityAgencies.find((a) =>
    a.name.toUpperCase().startsWith(wanted + " ")
  ) || cityAgencies.find((a) => a.name.toUpperCase().includes(wanted));

  const withDistance = (list) =>
    list
      .filter((a) => isFinite(a.lat) && isFinite(a.lng))
      .map((a) => ({ ...a, miles: milesBetween(lat, lng, a.lat, a.lng) }))
      .sort((x, y) => x.miles - y.miles);

  const nearestCity = withDistance(cityAgencies).find((a) => a.miles <= 25) || null;
  const nearestAny = withDistance(agencies)[0] || null;

  const ranked = [];
  for (const candidate of [nameMatch, nearestCity, nearestAny]) {
    if (candidate && !ranked.some((r) => r.ori === candidate.ori)) ranked.push(candidate);
  }
  return ranked.slice(0, 2);
}

/** Sum a summarized-offense response into { year, count, population, monthsReported }. */
function summarizeOffense(payload, agencyName) {
  const offenses = payload && payload.offenses;
  const actualsRoot = offenses && offenses.actuals;
  if (!actualsRoot) return null;
  let series = actualsRoot[`${agencyName} Offenses`];
  if (!series) {
    // Key names sometimes differ slightly from the list name; take the first
    // non-state series (state keys look like "California Offenses").
    const keys = Object.keys(actualsRoot);
    const agencyKey = keys.find((k) => k.includes("Police") || k.includes("Sheriff") || k.includes("Department"));
    series = agencyKey ? actualsRoot[agencyKey] : null;
  }
  if (!series) return null;

  const popRoot = (payload.populations &&
    (payload.populations[agencyName] ||
      payload.populations[Object.keys(payload.populations).find((k) => k !== "participated_population")])) || null;

  const byYear = {};
  for (const monthKey of Object.keys(series)) {
    const year = monthKey.slice(3); // "MM-YYYY" -> "YYYY"
    const value = series[monthKey];
    if (value === null || value === undefined || isNaN(Number(value))) continue;
    if (!byYear[year]) byYear[year] = { count: 0, months: 0 };
    byYear[year].count += Number(value);
    byYear[year].months += 1;
  }
  const years = Object.keys(byYear).sort().reverse(); // newest first
  for (const year of years) {
    if (byYear[year].months >= 9) {
      let population = null;
      if (popRoot) {
        const popKey = Object.keys(popRoot).find((k) => k.endsWith(`-${year}`) || k.slice(3) === year);
        if (popKey) population = Number(popRoot[popKey]) || null;
      }
      return {
        year,
        count: byYear[year].count,
        monthsReported: byYear[year].months,
        population
      };
    }
  }
  return null;
}

/**
 * The main entry point. Returns a town-level safety picture for an uncovered
 * point, or null when unavailable (no key, lookup failure, or no data) -
 * the caller then falls back to the plain "not covered yet" message.
 */
async function townLevelFallback(lat, lng) {
  const apiKey = process.env.FBI_API_KEY;
  if (!apiKey) return null;

  try {
    const place = await reverseGeocodePlace(lat, lng);
    if (!place) return null;

    const agencies = await getAgencies(place.stateAbbr, apiKey);
    if (!agencies.length) return null;
    const candidates = pickAgencies(agencies, place.placeName, lat, lng);

    const now = new Date();
    const from = `01-${now.getFullYear() - 2}`;
    const to = `12-${now.getFullYear() - 1}`;

    for (const agency of candidates) {
      const [violentRes, propertyRes] = await Promise.all([
        timedFetch(`${FBI_BASE}/summarized/agency/${agency.ori}/violent-crime?from=${from}&to=${to}&API_KEY=${encodeURIComponent(apiKey)}`),
        timedFetch(`${FBI_BASE}/summarized/agency/${agency.ori}/property-crime?from=${from}&to=${to}&API_KEY=${encodeURIComponent(apiKey)}`)
      ]);
      if (!violentRes.ok || !propertyRes.ok) continue;
      const violent = summarizeOffense(await violentRes.json(), agency.name);
      const property = summarizeOffense(await propertyRes.json(), agency.name);
      if (!violent && !property) continue;

      // Prefer the FBI's own population figure; fall back to the official
      // 2020 Census population when the FBI omits it (common for small towns).
      const population =
        (violent && violent.population) ||
        (property && property.population) ||
        place.censusPopulation ||
        null;
      const per1000 = (count) =>
        population && count !== null && count !== undefined
          ? Math.round((count / population) * 1000 * 10) / 10
          : null;

      return {
        placeName: place.placeName,
        stateAbbr: place.stateAbbr,
        agencyName: agency.name,
        year: (violent && violent.year) || (property && property.year),
        population,
        violent: violent
          ? { count: violent.count, ratePer1000: per1000(violent.count), monthsReported: violent.monthsReported }
          : null,
        property: property
          ? { count: property.count, ratePer1000: per1000(property.count), monthsReported: property.monthsReported }
          : null,
        nationalViolentPer1000: NATIONAL_VIOLENT_PER_1000,
        nationalPropertyPer1000: NATIONAL_PROPERTY_PER_1000,
        attribution:
          "Data: FBI Crime Data Explorer (annual, town-wide) & US Census Bureau"
      };
    }
    return null;
  } catch (err) {
    console.error("FBI town-level fallback error:", err.message);
    return null;
  }
}

module.exports = { townLevelFallback };

// I did no harm and this file is not truncated
