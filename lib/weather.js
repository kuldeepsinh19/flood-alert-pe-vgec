/**
 * Live rainfall via Open-Meteo (free, no API key, no signup).
 *
 * This is the one input in the system that is genuinely real: each village has
 * actual coordinates, and this fetches the actual forecast for them. River
 * levels remain simulated (lib/hydrology.js) — the README says so plainly, and
 * every payload produced here carries a `source` field so the distinction is
 * never lost between this module and the UI.
 *
 * If the network is unavailable, the call times out, or the response is
 * malformed, we fall back to the simulator rather than failing the assessment.
 * A flood warning system that goes dark because an upstream API is slow is
 * worse than one running on degraded inputs, so long as it says which it is.
 */

const { getVillage } = require('./villages');
const hydrology = require('./hydrology');

const ENDPOINT = 'https://api.open-meteo.com/v1/forecast';
const TIMEOUT_MS = Number(process.env.WEATHER_TIMEOUT_MS || 4000);
const CACHE_TTL_MS = Number(process.env.WEATHER_CACHE_TTL_MS || 15 * 60 * 1000);

const cache = new Map(); // villageId -> { expiresAt, payload }

function round1(n) {
  return Math.round(n * 10) / 10;
}

/** Shape the simulator output like the live payload so callers cannot tell them apart structurally. */
function simulatedForecast(villageId, hours, note) {
  const series = hydrology.getRainfallForecast(villageId, hours);
  return {
    villageId,
    source: 'simulated',
    note,
    totalMm: round1(series.reduce((sum, p) => sum + p.rainfallMmHr, 0)),
    maxIntensityMmHr: round1(Math.max(0, ...series.map((p) => p.rainfallMmHr))),
    hourly: series.map((p) => ({ hoursAhead: p.hoursAhead, rainfallMmHr: p.rainfallMmHr })),
  };
}

/**
 * Rainfall forecast for a village.
 * Always resolves — never rejects — so a degraded network cannot take the
 * assessment pipeline down with it.
 *
 * @returns {Promise<{villageId:string, source:'open-meteo'|'simulated', totalMm:number,
 *                    maxIntensityMmHr:number, hourly:Array<{hoursAhead:number, rainfallMmHr:number}>}>}
 */
async function getRainfallForecast(villageId, hours = 12) {
  const village = getVillage(villageId);

  const cached = cache.get(village.id);
  if (cached && cached.expiresAt > Date.now()) return cached.payload;

  if (process.env.DISABLE_LIVE_WEATHER === 'true') {
    return simulatedForecast(village.id, hours, 'live weather disabled by DISABLE_LIVE_WEATHER');
  }

  const url =
    `${ENDPOINT}?latitude=${village.lat}&longitude=${village.lon}` +
    `&hourly=precipitation&forecast_days=2&timezone=UTC`;

  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { 'User-Agent': 'FloodSense-AI/1.0 (portfolio project)' },
    });
    if (!response.ok) throw new Error(`Open-Meteo returned HTTP ${response.status}`);

    const data = await response.json();
    const precipitation = data?.hourly?.precipitation;
    const times = data?.hourly?.time;
    if (!Array.isArray(precipitation) || !Array.isArray(times)) {
      throw new Error('Open-Meteo response missing hourly.precipitation');
    }

    // Open-Meteo returns the whole forecast day from 00:00 UTC; keep only the
    // hours that are still ahead of us.
    const nowMs = Date.now();
    const future = times
      .map((t, i) => ({ tsMs: Date.parse(`${t}Z`), mm: Number(precipitation[i]) || 0 }))
      .filter((p) => p.tsMs > nowMs)
      .slice(0, hours);

    if (future.length === 0) throw new Error('Open-Meteo returned no future hours');

    const hourly = future.map((p, i) => ({
      hoursAhead: i + 1,
      rainfallMmHr: round1(p.mm),
    }));

    const payload = {
      villageId: village.id,
      source: 'open-meteo',
      note: `live forecast for ${village.name}, ${village.district} (${village.lat}, ${village.lon})`,
      totalMm: round1(hourly.reduce((sum, p) => sum + p.rainfallMmHr, 0)),
      maxIntensityMmHr: round1(Math.max(0, ...hourly.map((p) => p.rainfallMmHr))),
      hourly,
    };

    cache.set(village.id, { expiresAt: Date.now() + CACHE_TTL_MS, payload });
    return payload;
  } catch (error) {
    // Degrade, do not fail. The caller sees source:'simulated' and can say so.
    return simulatedForecast(
      village.id,
      hours,
      `live weather unavailable (${error.message}); using simulated rainfall`
    );
  }
}

module.exports = { getRainfallForecast, _cache: cache };
