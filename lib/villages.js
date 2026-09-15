/**
 * Village registry — single source of truth.
 *
 * In the 2024 build these profiles were duplicated as hand-typed HTML inside
 * views/home.ejs (district, lat/long, elevation, population) and the danger
 * thresholds lived in a separate `villagePeakLevels` array in a <script> tag.
 * Nothing kept the two in sync. They now live here; the views and the agents
 * both read from this module.
 *
 * `peakLevelCm` and the 20 cm warning band are carried over unchanged from the
 * original project — they are the thresholds the 2024 system shipped with, and
 * they remain the deterministic safety floor in agents/guardrails.js.
 */

// Hydrological character, not decoration: these drive lib/hydrology.js.
//   catchmentAreaKm2  — how much rain the river collects
//   responseHours     — lag between rainfall and the river responding
//   flashiness        — how sharply it spikes (steep, rocky) vs. spreads (flat, alluvial)
const VILLAGES = [
  {
    id: 'belapur',
    name: 'Belapur',
    district: 'Jivona',
    state: 'Chhattisgarh',
    lat: 22.5765,
    lon: 82.8475,
    elevationM: 35,
    population: 5000,
    nearby: ['Dinoji', 'Peron', 'Kadidoki'],
    river: 'Mahanadi tributary',
    peakLevelCm: 200,
    baseflowCm: 118,
    catchmentAreaKm2: 340,
    responseHours: 9,
    flashiness: 0.35,
    higherGround: 'the school compound on the Peron road ridge',
    seed: 1101,
  },
  {
    id: 'bhangarh',
    name: 'Bhangarh',
    district: 'Alwar',
    state: 'Rajasthan',
    // The 2024 build had 42.5765 / 92.8475 here, which is in Mongolia. Corrected
    // to the real Bhangarh, Alwar — these coordinates now hit a live weather API.
    lat: 27.0959,
    lon: 76.2864,
    elevationM: 235,
    population: 55000,
    nearby: ['Churu', 'Chelari', 'Sidoni', 'Kedonaj'],
    river: 'Ruparel seasonal channel',
    peakLevelCm: 180,
    baseflowCm: 96,
    catchmentAreaKm2: 95,
    responseHours: 3,
    flashiness: 0.85, // steep, rocky, semi-arid — flash-flood behaviour
    higherGround: 'the fort plateau above the old market',
    seed: 2202,
  },
  {
    id: 'khanpur',
    name: 'Khanpur',
    district: 'Sangli',
    state: 'Maharashtra',
    lat: 17.3568,
    lon: 74.1623,
    elevationM: 40,
    population: 8000,
    nearby: ['Miraj', 'Kavathe-Mahankal', 'Atpadi'],
    river: 'Krishna tributary',
    peakLevelCm: 160,
    baseflowCm: 92,
    catchmentAreaKm2: 520,
    responseHours: 14,
    flashiness: 0.22, // large flat catchment — slow, broad flood wave
    higherGround: 'the Miraj road embankment',
    seed: 3303,
  },
  {
    id: 'mangarh',
    name: 'Mangarh',
    district: 'Surendranagar',
    state: 'Gujarat',
    lat: 23.8994,
    lon: 72.6079,
    elevationM: 90,
    population: 6000,
    nearby: ['Dhrangadhra', 'Lakhtar', 'Thangadh'],
    river: 'Bhogavo',
    peakLevelCm: 140,
    baseflowCm: 78,
    catchmentAreaKm2: 210,
    responseHours: 6,
    flashiness: 0.55,
    higherGround: 'the Dhrangadhra road overbridge',
    seed: 4404,
  },
  {
    id: 'adarshnagar',
    name: 'Adarshnagar',
    district: 'Jaipur',
    state: 'Rajasthan',
    lat: 26.9238,
    lon: 75.8269,
    elevationM: 95,
    population: 7500,
    nearby: ['Chaksu', 'Amer', 'Bassi'],
    river: 'Dhund',
    peakLevelCm: 130,
    baseflowCm: 71,
    catchmentAreaKm2: 130,
    responseHours: 4,
    flashiness: 0.7,
    higherGround: 'the Amer road water tank platform',
    seed: 5505,
  },
  {
    id: 'sarai',
    name: 'Sarai',
    district: 'Cuttack',
    state: 'Odisha',
    lat: 20.4648,
    lon: 85.879,
    elevationM: 65,
    population: 7000,
    nearby: ['Salepur', 'Athagarh', 'Kantapada'],
    river: 'Mahanadi delta channel',
    peakLevelCm: 120,
    baseflowCm: 68,
    catchmentAreaKm2: 610,
    responseHours: 16,
    flashiness: 0.18, // delta — slowest responding, longest warning time available
    higherGround: 'the Salepur cyclone shelter',
    seed: 6606,
  },
  {
    id: 'sihor',
    name: 'Sihor',
    district: 'Bhavnagar',
    state: 'Gujarat',
    lat: 21.7032,
    lon: 71.9722,
    elevationM: 70,
    population: 6500,
    nearby: ['Gadhada', 'Palitana', 'Ghogha'],
    river: 'Gautami',
    peakLevelCm: 110,
    baseflowCm: 62,
    catchmentAreaKm2: 155,
    responseHours: 5,
    flashiness: 0.6,
    higherGround: 'the Palitana road temple steps',
    seed: 7707,
  },
];

// The 2024 rule: level >= peak is a flood, level >= peak - 20 is a warning.
// Preserved verbatim as the deterministic floor. See agents/guardrails.js.
const WARNING_BAND_CM = 20;

const byId = new Map(VILLAGES.map((v) => [v.id, v]));

function listVillages() {
  return VILLAGES;
}

function getVillage(id) {
  const village = byId.get(String(id || '').toLowerCase());
  if (!village) {
    throw new Error(
      `Unknown village "${id}". Known villages: ${VILLAGES.map((v) => v.id).join(', ')}`
    );
  }
  return village;
}

function isVillage(id) {
  return byId.has(String(id || '').toLowerCase());
}

/** Thresholds an agent (or the guardrail) needs to judge a reading. */
function thresholdsFor(id) {
  const v = getVillage(id);
  return {
    peakLevelCm: v.peakLevelCm,
    warningLevelCm: v.peakLevelCm - WARNING_BAND_CM,
    baseflowCm: v.baseflowCm,
  };
}

module.exports = {
  VILLAGES,
  WARNING_BAND_CM,
  listVillages,
  getVillage,
  isVillage,
  thresholdsFor,
};
