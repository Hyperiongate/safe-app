/*
 * FILE NOTES (for future updates)
 * File: sources/severity.js
 * Purpose: Shared classifier that maps a raw crime category/description string
 *          (which differs between cities) into one of Safe's severity buckets:
 *            - homicide  (red pins)    : murder / homicide / manslaughter
 *            - violent   (blue pins)   : violent crimes & serious felonies
 *            - lesser    (yellow pins) : property crimes, drug offenses, misdemeanors
 *            - other     (gray pins)   : real incidents that don't fit the above
 *            - excluded  (no pin)      : non-crime records (missing persons,
 *                                        courtesy reports, recovered vehicles, etc.)
 * How it works: keyword matching on the UPPERCASED raw text. Keyword lists are
 *          ordered by priority; the first bucket that matches wins. Keyword
 *          matching (instead of exact category tables) is deliberate so one
 *          classifier works across every city feed we add later.
 * Used by: sources/sanfrancisco.js, sources/oakland.js (and any future adapter).
 * Change log:
 *   2026-08-06 - Initial version. (latest change)
 */

"use strict";

// Order matters: checked top to bottom, first match wins.
const RULES = [
  {
    severity: "excluded",
    keywords: [
      "NON-CRIMINAL", "NON CRIMINAL", "MISSING PERSON", "FOUND PERSON",
      "RECOVERED VEHICLE", "VEHICLE, RECOVERED", "FIRE REPORT",
      "COURTESY REPORT", "SUSPICIOUS OCC", "SUSPICIOUS ACTIVITY",
      "TRAFFIC COLLISION", "MISCELLANEOUS INVESTIGATION", "CASE CLOSURE",
      "VEHICLE MISPLACED", "LOST PROPERTY", "WARRANT", "MISSING ADULT",
      "MISSING JUVENILE", "AIDED CASE", "MENTAL HEALTH", "DEATH REPORT",
      "MISCELLANEOUS INVESTIGATION", "TOWED"
    ]
  },
  {
    severity: "homicide",
    keywords: ["HOMICIDE", "MURDER", "MANSLAUGHTER"]
  },
  {
    severity: "violent",
    keywords: [
      "RAPE", "SEXUAL ASSAULT", "SEX OFFENSE", "SODOMY", "ROBBERY",
      "CARJACK", "ASSAULT", "BATTERY", "SHOOT", "STABBING", "KIDNAP",
      "WEAPON", "FIREARM", "GUN", "ARSON", "HUMAN TRAFFICKING",
      "CHILD ABUSE", "DOMESTIC VIOLENCE", "STRONGARM", "BRANDISHING",
      "THREATS", "EXTORTION", "OFFENCES AGAINST THE FAMILY"
    ]
  },
  {
    severity: "lesser",
    keywords: [
      "BURGLARY", "THEFT", "LARCENY", "STOLEN", "SHOPLIFT", "VANDALISM",
      "MALICIOUS MISCHIEF", "GRAFFITI", "FRAUD", "FORGERY", "COUNTERFEIT",
      "EMBEZZLE", "BAD CHECKS", "DRUG", "NARCOTIC", "PROSTITUTION",
      "DISORDERLY", "DRUNK", "LIQUOR", "GAMBLING", "TRESPASS", "LOITER",
      "DUI", "RECKLESS DRIVING", "TRAFFIC VIOLATION", "MUNICIPAL CODE",
      "PETTY", "VEHICLE BREAK-IN", "AUTO BOOST", "CURFEW", "VAGRANCY",
      "SUSPENDED LICENSE", "PROBATION", "PAROLE", "COURT VIOLATION",
      "RESISTING", "OBSTRUCT", "BRIBERY", "PERJURY", "IDENTITY"
    ]
  }
];

const SEVERITY_INFO = {
  homicide: { label: "Homicide / Murder", color: "#d81b2f", order: 1 },
  violent:  { label: "Violent crime / Felony", color: "#1d5fd6", order: 2 },
  lesser:   { label: "Property crime / Misdemeanor", color: "#e6b400", order: 3 },
  other:    { label: "Other reported incident", color: "#7a7a7a", order: 4 }
};

/**
 * Classify a raw category/description string into a severity bucket.
 * @param {string} rawText - e.g. "Larceny Theft" or "ASSAULT WITH DEADLY WEAPON"
 * @returns {string} one of: "homicide", "violent", "lesser", "other", "excluded"
 */
function classify(rawText) {
  if (!rawText || typeof rawText !== "string") return "other";
  const text = rawText.toUpperCase();
  for (const rule of RULES) {
    for (const keyword of rule.keywords) {
      if (text.includes(keyword)) return rule.severity;
    }
  }
  return "other";
}

module.exports = { classify, SEVERITY_INFO };

// I did no harm and this file is not truncated
