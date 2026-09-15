/**
 * Hydrograph simulator — the replacement for Math.random().
 *
 * The 2024 build generated water levels with:
 *     Math.floor(Math.random() * (221 - 130)) + 130
 * re-rolled in the browser every 9 seconds, and applied the SAME number to all
 * seven villages at once. There was no history, no trend, and no way for two
 * villages to disagree — so there was nothing a forecast could be built from.
 *
 * This module produces a physically-shaped hydrograph instead:
 *
 *     rainfall -> [runoff coefficient] -> two cascaded linear reservoirs -> level
 *
 * That two-reservoir cascade (a Nash cascade) is the standard textbook way to
 * turn rainfall into a river response. It gives three features that make
 * forecasting meaningful and that a random number cannot have:
 *
 *   1. a LAG between rain falling and the river rising (village.responseHours),
 *   2. a smooth rising limb and a slow exponential recession, and
 *   3. per-village character — a steep 95 km2 catchment (Bhangarh) spikes in
 *      hours, a 610 km2 delta channel (Sarai) takes most of a day.
 *
 * Everything is a deterministic function of absolute wall-clock time and a
 * per-village seed. Two consequences worth noting:
 *   - Demos and evals reproduce exactly.
 *   - Because it is a function of time, it can be evaluated for FUTURE times,
 *     which is what gives us a rainfall forecast to hand the agents.
 *
 * This is simulated data and is labelled as such everywhere it surfaces.
 */

const { getVillage } = require('./villages');

const STEP_MIN = 10; // simulation resolution
const STEP_HOURS = STEP_MIN / 60;
const SLOT_HOURS = 6; // storms are decided per 6-hour slot
const MS_PER_HOUR = 3600 * 1000;

/** Deterministic PRNG (mulberry32). Same inputs, same number, forever. */
function rng(seed, salt) {
  let t = (Math.imul(seed, 0x9e3779b1) ^ Math.imul(salt + 0x6d2b79f5, 0x85ebca6b)) >>> 0;
  t = (t + 0x6d2b79f5) >>> 0;
  let r = Math.imul(t ^ (t >>> 15), 1 | t);
  r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
  return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
}

/**
 * Rainfall intensity (mm/hr) for a village at an absolute time.
 * Storms are decided per 6-hour slot; a long storm carries into later slots,
 * so we look back a few slots and sum whatever is still falling.
 */
function rainfallAt(village, tsMs) {
  const slot = Math.floor(tsMs / (SLOT_HOURS * MS_PER_HOUR));
  let mmPerHour = 0;

  for (let back = 0; back <= 2; back++) {
    const s = slot - back;
    // Drier, flashier catchments storm less often but harder when they do.
    const stormChance = 0.14 + 0.1 * village.flashiness;
    if (rng(village.seed, s) > stormChance) continue;

    const u = rng(village.seed, s + 500000);
    // Cubic weighting: most storms are small, big ones are rare.
    const peakMmHr = 3 + 46 * Math.pow(u, 2.6);
    const durationH = 1.5 + 5 * rng(village.seed, s + 900000);
    const startOffsetH = SLOT_HOURS * rng(village.seed, s + 1300000);

    const stormStartMs = s * SLOT_HOURS * MS_PER_HOUR + startOffsetH * MS_PER_HOUR;
    const elapsedH = (tsMs - stormStartMs) / MS_PER_HOUR;
    if (elapsedH < 0 || elapsedH > durationH) continue;

    // Half-sine burst: ramps up, peaks mid-storm, tails off.
    mmPerHour += peakMmHr * Math.sin((Math.PI * elapsedH) / durationH);
  }
  return mmPerHour;
}

/** Runoff parameters derived from the catchment description in villages.js. */
function paramsFor(village) {
  return {
    k: Math.max(village.responseHours / 2, 0.5), // storage constant, hours
    runoffCoeff: 0.18 + 0.5 * village.flashiness, // steep ground sheds more rain
    areaFactor: Math.sqrt(village.catchmentAreaKm2 / 100), // bigger catchment, more water
  };
}

/**
 * Route a rainfall series through two cascaded linear reservoirs.
 * Returns outflow at each step in arbitrary units, scaled later by gainFor().
 */
function route(village, startMs, steps, warmupSteps) {
  const { k, runoffCoeff, areaFactor } = paramsFor(village);

  let s1 = 0;
  let s2 = 0;
  const out = [];
  const firstMs = startMs - warmupSteps * STEP_MIN * 60 * 1000;

  for (let i = 0; i < warmupSteps + steps; i++) {
    const tsMs = firstMs + i * STEP_MIN * 60 * 1000;
    const rain = rainfallAt(village, tsMs);
    const effectiveRain = rain * runoffCoeff * areaFactor;

    const q1 = s1 / k;
    const q2 = s2 / k;
    s1 += (effectiveRain - q1) * STEP_HOURS;
    s2 += (q1 - q2) * STEP_HOURS;

    if (i >= warmupSteps) out.push({ tsMs, outflow: q2, rainfallMmHr: rain });
  }
  return out;
}

/**
 * Self-calibrating gain: run a reference storm through this catchment and scale
 * so a severe event lands just above the danger threshold. Without this, every
 * village would need a hand-tuned magic number.
 */
const gainCache = new Map();
function gainFor(village) {
  if (gainCache.has(village.id)) return gainCache.get(village.id);

  const { k, runoffCoeff, areaFactor } = paramsFor(village);

  // Reference storm: 30 mm/hr for 4 hours.
  let s1 = 0;
  let s2 = 0;
  let peakOutflow = 0;
  const totalSteps = Math.ceil((village.responseHours * 8) / STEP_HOURS);
  for (let i = 0; i < totalSteps; i++) {
    const hours = i * STEP_HOURS;
    const rain = hours <= 4 ? 30 : 0;
    const effectiveRain = rain * runoffCoeff * areaFactor;
    const q1 = s1 / k;
    const q2 = s2 / k;
    s1 += (effectiveRain - q1) * STEP_HOURS;
    s2 += (q1 - q2) * STEP_HOURS;
    peakOutflow = Math.max(peakOutflow, q2);
  }

  const targetRiseCm = (village.peakLevelCm - village.baseflowCm) * 1.18;
  const gain = peakOutflow > 0 ? targetRiseCm / peakOutflow : 0;
  gainCache.set(village.id, gain);
  return gain;
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

/**
 * Level history for a village, at 10-minute resolution.
 * @returns {Array<{tsMs:number, isoTime:string, levelCm:number, rainfallMmHr:number}>}
 */
function getHistory(villageId, hours = 24, opts = {}) {
  const village = getVillage(villageId);
  const nowMs = opts.atMs ?? Date.now();
  const steps = Math.max(2, Math.ceil(hours / STEP_HOURS));
  const startMs = nowMs - hours * MS_PER_HOUR;
  // Warm up long enough that the reservoirs have forgotten their zero start.
  const warmupSteps = Math.ceil((village.responseHours * 6) / STEP_HOURS);

  const routed = route(village, startMs, steps + 1, warmupSteps);
  const gain = gainFor(village);

  return routed.map((r, i) => ({
    tsMs: r.tsMs,
    isoTime: new Date(r.tsMs).toISOString(),
    // Tiny seeded sensor noise — real gauges are never perfectly smooth.
    levelCm: round1(
      village.baseflowCm + r.outflow * gain + (rng(village.seed, 77000 + i) - 0.5) * 1.2
    ),
    rainfallMmHr: round1(r.rainfallMmHr),
  }));
}

/** Current reading plus the trend that makes it interpretable. */
function getCurrent(villageId, opts = {}) {
  const history = getHistory(villageId, 3, opts);
  const latest = history[history.length - 1];
  const stepsPerHour = Math.round(1 / STEP_HOURS);
  const oneHourBack = history[Math.max(0, history.length - 1 - stepsPerHour)];
  const threeHourBack = history[0];

  return {
    villageId: getVillage(villageId).id,
    tsMs: latest.tsMs,
    isoTime: latest.isoTime,
    levelCm: latest.levelCm,
    rainfallMmHr: latest.rainfallMmHr,
    trendCmPerHr: round1(latest.levelCm - oneHourBack.levelCm),
    trend3hCmPerHr: round1((latest.levelCm - threeHourBack.levelCm) / 3),
  };
}

/**
 * Rainfall forecast. Only possible because the simulator is a pure function of
 * absolute time — we evaluate it ahead of now. Used as the fallback when the
 * live Open-Meteo call in lib/weather.js is unavailable.
 */
function getRainfallForecast(villageId, hours = 12, opts = {}) {
  const village = getVillage(villageId);
  const nowMs = opts.atMs ?? Date.now();
  const out = [];
  for (let h = 1; h <= hours; h++) {
    const tsMs = nowMs + h * MS_PER_HOUR;
    out.push({
      tsMs,
      isoTime: new Date(tsMs).toISOString(),
      hoursAhead: h,
      rainfallMmHr: round1(rainfallAt(village, tsMs)),
    });
  }
  return out;
}

module.exports = {
  STEP_MIN,
  getHistory,
  getCurrent,
  getRainfallForecast,
  rainfallAt,
  _internals: { rng, gainFor, paramsFor },
};
