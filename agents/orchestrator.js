/**
 * Orchestrator — the pipeline that turns a village name into an alert.
 *
 *   reading ──> riskAgent ──> guardrails ──> advisoryAgent ──> result
 *   (always)   (advisory)    (authority)     (WATCH and above)
 *                   │             │
 *                   └─────────────┴──> trace (timings, tokens, cost, interventions)
 *
 * Three things this module is responsible for beyond sequencing:
 *
 * 1. COST CONTROL. An assessment costs real money and takes real seconds. Page
 *    loads must not each trigger one, so results are cached per village and
 *    served from cache until they expire. The API surface exposes an explicit
 *    refresh for when someone actually wants a fresh look.
 *
 * 2. NEVER GOING DARK. If the model is unreachable, or no API key is set at
 *    all, the pipeline still returns a valid assessment — from the 2024
 *    threshold rule, clearly flagged as such. Degraded is acceptable; silent is
 *    not, and down is not.
 *
 * 3. EVIDENCE. Every run writes a trace: which tools the agent chose to call
 *    and in what order, how long each took, tokens and cost per agent, and
 *    every guardrail intervention. This is what makes claims about the system
 *    checkable instead of merely stated.
 */

const fs = require('fs');
const path = require('path');

const { listVillages, getVillage } = require('../lib/villages');
const { createLiveDataSource } = require('./tools');
const { assessRisk } = require('./riskAgent');
const { generateAdvisory } = require('./advisoryAgent');
const { applyGuardrails } = require('./guardrails');
const { isConfigured, MODEL } = require('./client');

const CACHE_TTL_MS = Number(process.env.ASSESSMENT_CACHE_TTL_MS || 10 * 60 * 1000);
const TRACE_DIR = path.join(__dirname, '..', 'traces');
const WRITE_TRACES = process.env.WRITE_TRACES !== 'false';
const EVENT_LOG_LIMIT = 200;

const cache = new Map(); // villageId -> { expiresAt, result }
const eventLog = new Map(); // villageId -> [{tsMs, levelCm, severity, note, interventions}]

function recordEvent(villageId, entry) {
  const log = eventLog.get(villageId) || [];
  log.push(entry);
  if (log.length > EVENT_LOG_LIMIT) log.shift();
  eventLog.set(villageId, log);
}

/** Chronological event history for a village, for the incident agent. */
function getEventLog(villageId) {
  return eventLog.get(getVillage(villageId).id) || [];
}

function writeTrace(result) {
  if (!WRITE_TRACES) return null;
  try {
    fs.mkdirSync(TRACE_DIR, { recursive: true });
    const file = path.join(
      TRACE_DIR,
      `${result.villageId}-${new Date(result.generatedAt).toISOString().replace(/[:.]/g, '-')}.json`
    );
    fs.writeFileSync(file, JSON.stringify(result, null, 2));
    return file;
  } catch (error) {
    // A failure to write a log file must never fail an assessment.
    console.warn(`[orchestrator] could not write trace: ${error.message}`);
    return null;
  }
}

/**
 * Assess one village.
 *
 * @param {string} villageId
 * @param {{refresh?: boolean, dataSource?: object}} [opts]
 * @returns {Promise<object>} the full assessment result
 */
async function assessVillage(villageId, opts = {}) {
  const village = getVillage(villageId);
  const cached = cache.get(village.id);
  if (!opts.refresh && cached && cached.expiresAt > Date.now()) {
    return { ...cached.result, servedFromCache: true };
  }

  const startedAt = Date.now();
  const dataSource = opts.dataSource || createLiveDataSource();
  const reading = dataSource.getCurrent(village.id);

  // 1. The agent proposes.
  const { proposed, error: riskError, trace: riskTrace } = await assessRisk(village.id, dataSource);

  // 2. The guardrail disposes.
  const { assessment, floor, interventions, usedFallback } = applyGuardrails(
    village.id,
    reading,
    proposed,
    riskError
  );

  // 3. Write the alert, but only when there is something to say.
  const {
    advisory,
    error: advisoryError,
    trace: advisoryTrace,
  } = await generateAdvisory(assessment, village.id);

  const result = {
    villageId: village.id,
    villageName: village.name,
    generatedAt: new Date(startedAt).toISOString(),
    servedFromCache: false,

    reading: {
      levelCm: reading.levelCm,
      trendCmPerHr: reading.trendCmPerHr,
      trend3hCmPerHr: reading.trend3hCmPerHr,
      rainfallMmHr: reading.rainfallMmHr,
      observedAt: reading.isoTime,
    },
    thresholds: {
      dangerLevelCm: village.peakLevelCm,
      warningLevelCm: village.peakLevelCm - 20,
      baseflowCm: village.baseflowCm,
    },

    assessment,
    advisory,

    guardrail: {
      deterministicFloor: floor,
      finalSeverity: assessment.severity,
      escalatedByModel: floor !== assessment.severity && !usedFallback,
      interventions,
    },

    mode: usedFallback ? 'DETERMINISTIC_FALLBACK' : 'AI_ASSESSED',
    aiConfigured: isConfigured(),
    notes: {
      riverLevel: 'SIMULATED — see lib/hydrology.js',
      advisoryError: advisoryError ? advisoryError.message : null,
    },

    trace: {
      model: MODEL,
      totalLatencyMs: Date.now() - startedAt,
      totalCostUsd:
        Math.round(
          ((riskTrace.usage?.costUsd || 0) + (advisoryTrace.usage?.costUsd || 0)) * 1e6
        ) / 1e6,
      agents: [riskTrace, advisoryTrace],
    },
  };

  recordEvent(village.id, {
    tsMs: startedAt,
    levelCm: reading.levelCm,
    severity: assessment.severity,
    note: result.mode,
    interventions,
  });

  result.traceFile = writeTrace(result);
  cache.set(village.id, { expiresAt: Date.now() + CACHE_TTL_MS, result });
  return result;
}

/**
 * Assess every village.
 * Sequential on purpose: seven concurrent agent runs is a burst of API traffic
 * and a rate-limit risk for no user-visible benefit on a page that renders once.
 */
async function assessAll(opts = {}) {
  const results = [];
  for (const village of listVillages()) {
    results.push(await assessVillage(village.id, opts));
  }
  return results;
}

/** Cheap, model-free snapshot for first paint — the page renders before any agent runs. */
function quickSnapshot() {
  const { deterministicSeverity } = require('./guardrails');
  const dataSource = createLiveDataSource();
  return listVillages().map((village) => {
    const reading = dataSource.getCurrent(village.id);
    const cached = cache.get(village.id);
    return {
      villageId: village.id,
      villageName: village.name,
      levelCm: reading.levelCm,
      trendCmPerHr: reading.trendCmPerHr,
      dangerLevelCm: village.peakLevelCm,
      warningLevelCm: village.peakLevelCm - 20,
      deterministicSeverity: deterministicSeverity(village, reading.levelCm),
      hasAiAssessment: Boolean(cached && cached.expiresAt > Date.now()),
    };
  });
}

module.exports = {
  assessVillage,
  assessAll,
  quickSnapshot,
  getEventLog,
  CACHE_TTL_MS,
  _cache: cache,
};
