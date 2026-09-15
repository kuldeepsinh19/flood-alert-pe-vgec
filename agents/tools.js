/**
 * The tools the Risk Agent can call.
 *
 * This is what separates an agent from a single prompt: the model is not handed
 * a pre-built situation report and asked to comment on it. It is given a
 * village name and a set of instruments, and it decides what to look at — check
 * the trend first, then pull the rain forecast if the trend is rising, then
 * look upstream if the rain is heavy. The sequence of calls it chooses is
 * visible in the trace and differs by situation.
 *
 * Data access goes through an injected `dataSource` rather than importing
 * lib/hydrology directly. That indirection is what lets evals/run-evals.js swap
 * in fixed scenario fixtures and score the agent on situations that would take
 * months to occur naturally — a stuck sensor, a flash flood, a false spike.
 * Same agent code, same tool surface, deterministic inputs.
 */

const villages = require('../lib/villages');
const hydrology = require('../lib/hydrology');
const weather = require('../lib/weather');

/** Live data source: simulated river levels, live rainfall. */
function createLiveDataSource(opts = {}) {
  return {
    name: 'live',
    getProfile: (villageId) => villages.getVillage(villageId),
    getHistory: (villageId, hours) => hydrology.getHistory(villageId, hours, opts),
    getCurrent: (villageId) => hydrology.getCurrent(villageId, opts),
    getRainfall: (villageId, hours) => weather.getRainfallForecast(villageId, hours),
  };
}

/**
 * Fixture data source for evals. A scenario supplies an explicit level series
 * and rainfall forecast, so the agent sees exactly the situation under test.
 */
function createFixtureDataSource(scenario) {
  const village = villages.getVillage(scenario.villageId);
  const nowMs = Date.parse('2026-08-15T06:00:00Z'); // fixed clock: evals must reproduce
  const stepMs = 10 * 60 * 1000;
  const series = scenario.levelSeriesCm;

  const history = series.map((levelCm, i) => ({
    tsMs: nowMs - (series.length - 1 - i) * stepMs,
    isoTime: new Date(nowMs - (series.length - 1 - i) * stepMs).toISOString(),
    levelCm,
    rainfallMmHr: scenario.observedRainMmHr ?? 0,
  }));

  const latest = history[history.length - 1];
  const oneHourBack = history[Math.max(0, history.length - 7)];
  const threeHourBack = history[0];

  return {
    name: `fixture:${scenario.id}`,
    getProfile: () => village,
    getHistory: (_villageId, hours) => {
      const wanted = Math.ceil((hours * 60) / 10);
      return history.slice(Math.max(0, history.length - wanted));
    },
    getCurrent: () => ({
      villageId: village.id,
      tsMs: latest.tsMs,
      isoTime: latest.isoTime,
      levelCm: latest.levelCm,
      rainfallMmHr: scenario.observedRainMmHr ?? 0,
      trendCmPerHr: Math.round((latest.levelCm - oneHourBack.levelCm) * 10) / 10,
      trend3hCmPerHr:
        Math.round(((latest.levelCm - threeHourBack.levelCm) / 3) * 10) / 10,
    }),
    getRainfall: async () => ({
      villageId: village.id,
      source: 'scenario-fixture',
      note: `eval scenario ${scenario.id}`,
      totalMm: (scenario.forecastRainMmHr || []).reduce((a, b) => a + b, 0),
      maxIntensityMmHr: Math.max(0, ...(scenario.forecastRainMmHr || [0])),
      hourly: (scenario.forecastRainMmHr || []).map((mm, i) => ({
        hoursAhead: i + 1,
        rainfallMmHr: mm,
      })),
    }),
  };
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

/**
 * Downsample a 10-minute series to hourly before showing it to the model.
 *
 * 24 hours at 10-minute resolution is 144 readings. Sent raw that is a few
 * thousand tokens of mostly-redundant numbers on every single call, and the
 * shape of the hydrograph is perfectly legible at hourly resolution. The
 * summary statistics are computed from the FULL series, so nothing that matters
 * (a brief spike, the true maximum) is lost to the downsampling.
 */
function summariseHistory(history) {
  const levels = history.map((h) => h.levelCm);
  const hourly = history.filter((_, i) => i % 6 === 0 || i === history.length - 1);

  return {
    readings_count: history.length,
    window_hours: round1(((history[history.length - 1].tsMs - history[0].tsMs) / 3600000)),
    current_level_cm: levels[levels.length - 1],
    min_level_cm: round1(Math.min(...levels)),
    max_level_cm: round1(Math.max(...levels)),
    net_change_cm: round1(levels[levels.length - 1] - levels[0]),
    hourly_series: hourly.map((h) => ({
      hours_ago: round1((history[history.length - 1].tsMs - h.tsMs) / 3600000),
      level_cm: h.levelCm,
      rainfall_mm_hr: h.rainfallMmHr,
    })),
  };
}

/**
 * Build the tool set against a data source.
 * Returns objects carrying BOTH the API-facing definition and the local `run`
 * implementation; agents/riskAgent.js strips `run` before sending to the API.
 */
function buildTools(dataSource) {
  return [
    {
      name: 'get_level_history',
      description:
        'River level readings for a village over a recent window, downsampled to hourly with ' +
        'summary statistics. Use this first — the trend matters more than the current number.',
      strict: true,
      input_schema: {
        type: 'object',
        properties: {
          village_id: { type: 'string', description: 'Village id, e.g. "mangarh".' },
          hours: {
            type: 'integer',
            description: 'How far back to look. 24 is a good default; use 48 for slow catchments.',
          },
        },
        required: ['village_id', 'hours'],
        additionalProperties: false,
      },
      run: async ({ village_id, hours }) => {
        const history = dataSource.getHistory(village_id, Math.min(Math.max(hours, 1), 72));
        const current = dataSource.getCurrent(village_id);
        return {
          ...summariseHistory(history),
          trend_cm_per_hr: current.trendCmPerHr,
          trend_3h_avg_cm_per_hr: current.trend3hCmPerHr,
          note: 'River levels are SIMULATED (see lib/hydrology.js). Rainfall may be live.',
        };
      },
    },

    {
      name: 'get_rainfall_forecast',
      description:
        'Rainfall forecast for the hours ahead. Rain that has not fallen yet is the main reason ' +
        'to warn before the river has actually risen.',
      strict: true,
      input_schema: {
        type: 'object',
        properties: {
          village_id: { type: 'string' },
          hours: { type: 'integer', description: 'Forecast horizon in hours, up to 24.' },
        },
        required: ['village_id', 'hours'],
        additionalProperties: false,
      },
      run: async ({ village_id, hours }) => {
        const forecast = await dataSource.getRainfall(village_id, Math.min(Math.max(hours, 1), 24));
        return {
          source: forecast.source,
          source_note: forecast.note,
          total_mm_expected: forecast.totalMm,
          max_intensity_mm_hr: forecast.maxIntensityMmHr,
          hourly: forecast.hourly,
        };
      },
    },

    {
      name: 'get_village_profile',
      description:
        'Static facts about a village: thresholds, population, elevation, catchment size, how ' +
        'fast the river responds to rain, and where the local high ground is.',
      strict: true,
      input_schema: {
        type: 'object',
        properties: { village_id: { type: 'string' } },
        required: ['village_id'],
        additionalProperties: false,
      },
      run: async ({ village_id }) => {
        const v = dataSource.getProfile(village_id);
        return {
          id: v.id,
          name: v.name,
          district: v.district,
          state: v.state,
          river: v.river,
          population: v.population,
          elevation_m: v.elevationM,
          danger_level_cm: v.peakLevelCm,
          warning_level_cm: v.peakLevelCm - villages.WARNING_BAND_CM,
          normal_baseflow_cm: v.baseflowCm,
          catchment_area_km2: v.catchmentAreaKm2,
          catchment_response_hours: v.responseHours,
          flashiness_0_to_1: v.flashiness,
          nearest_high_ground: v.higherGround,
          nearby_villages: v.nearby,
        };
      },
    },

    {
      name: 'get_nearby_village_levels',
      description:
        'Current levels at other monitored villages. A village upstream on the same river system ' +
        'rising now is an early signal for this one.',
      strict: true,
      input_schema: {
        type: 'object',
        properties: { village_id: { type: 'string' } },
        required: ['village_id'],
        additionalProperties: false,
      },
      run: async ({ village_id }) => {
        const self = dataSource.getProfile(village_id);
        const others = villages
          .listVillages()
          .filter((v) => v.id !== self.id)
          .map((v) => {
            // Fixture sources only know about the village under test; fall back to
            // the live simulator for the neighbours so the tool still answers.
            const reading = hydrology.getCurrent(v.id);
            return {
              id: v.id,
              name: v.name,
              state: v.state,
              level_cm: reading.levelCm,
              danger_level_cm: v.peakLevelCm,
              trend_cm_per_hr: reading.trendCmPerHr,
              percent_of_danger: Math.round((reading.levelCm / v.peakLevelCm) * 100),
            };
          });
        return {
          note:
            'These are the other monitored villages. They are not necessarily on the same river — ' +
            'check the river and state fields before treating one as upstream.',
          villages: others,
        };
      },
    },
  ];
}

module.exports = {
  createLiveDataSource,
  createFixtureDataSource,
  buildTools,
  summariseHistory,
};
