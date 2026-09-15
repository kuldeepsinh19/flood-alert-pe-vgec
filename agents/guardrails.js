/**
 * Safety guardrails — the contract between the deterministic system and the LLM.
 *
 * THE RULE
 *
 *   The model may ESCALATE severity. It may never DOWNGRADE below the level
 *   that physics has already established.
 *
 * Why it is built this way. A language model is genuinely good at the thing the
 * 2024 system could not do at all: looking at a rising trend, the rain still to
 * come, and the shape of the catchment, and saying "this will cross the danger
 * line in about five hours." That is anticipation, and it is worth real lead
 * time.
 *
 * But it is a probabilistic component in a system where a false negative means
 * somebody drowns. So it is wired in as an ADVISOR, not an authority:
 *
 *   - The deterministic check runs FIRST and INDEPENDENTLY. If the river is
 *     already over the danger mark, severity is EVACUATE. No model output can
 *     talk that back down, however confident or well-argued it is.
 *   - The model can only ever raise the floor — warning earlier than the
 *     threshold rule would have.
 *   - If the API is down, slow, returns malformed JSON, or no key is
 *     configured, we fall back to the 2024 threshold logic and keep running.
 *     A flood warning system that goes dark when a vendor has an outage is
 *     worse than one running on simpler rules.
 *
 * Every intervention is recorded, so "how often did the model try to downgrade
 * a real flood?" is a number we can actually report rather than a hope.
 *
 * The floor itself is the original 2024 rule, unchanged:
 *     level >= peak        -> flood   (now EVACUATE)
 *     level >= peak - 20   -> warning (now WARNING)
 *     otherwise            -> normal  (now NORMAL)
 * lifted from the getStatus() function in views/home.ejs.
 */

const { getVillage, WARNING_BAND_CM } = require('../lib/villages');
const { rankOf, maxSeverity, RiskAssessmentSchema } = require('./schemas');

const INTERVENTION = {
  DOWNGRADE_BLOCKED: 'DOWNGRADE_BLOCKED',
  LLM_UNAVAILABLE: 'LLM_UNAVAILABLE',
  SCHEMA_INVALID: 'SCHEMA_INVALID',
  IMPLAUSIBLE_BREACH_TIME: 'IMPLAUSIBLE_BREACH_TIME',
  CONFIDENCE_CLAMPED: 'CONFIDENCE_CLAMPED',
};

/**
 * The 2024 threshold rule, verbatim in behaviour.
 * This is the floor. It is not negotiable by anything downstream.
 */
function deterministicSeverity(village, levelCm) {
  if (levelCm >= village.peakLevelCm) return 'EVACUATE';
  if (levelCm >= village.peakLevelCm - WARNING_BAND_CM) return 'WARNING';
  return 'NORMAL';
}

/**
 * A complete, valid assessment derived with no model at all.
 *
 * Used in two situations: as the fallback when the LLM is unavailable, and as
 * the baseline the eval harness scores the agent against — if the agent cannot
 * beat this, the AI layer is not earning its cost.
 */
function fallbackAssessment(villageId, reading) {
  const village = getVillage(villageId);
  const severity = deterministicSeverity(village, reading.levelCm);
  const trend = reading.trendCmPerHr ?? 0;
  const gapCm = village.peakLevelCm - reading.levelCm;

  // Straight-line extrapolation. Crude — a real river decelerates as it spreads
  // across its floodplain — but honest about being crude.
  let hoursToBreach = null;
  if (gapCm <= 0) hoursToBreach = 0;
  else if (trend > 0.5) hoursToBreach = Math.round((gapCm / trend) * 10) / 10;

  return {
    severity,
    confidence: 0.4, // deliberately low: this is a rule, not an analysis
    predicted_peak_cm: Math.round((reading.levelCm + Math.max(0, trend) * 3) * 10) / 10,
    predicted_peak_in_hours: trend > 0.5 ? 3 : 0,
    hours_to_breach: hoursToBreach,
    reasoning:
      `Threshold rule only (no AI assessment available). Level is ${reading.levelCm} cm against a ` +
      `danger level of ${village.peakLevelCm} cm and a warning level of ` +
      `${village.peakLevelCm - WARNING_BAND_CM} cm, trending ${trend >= 0 ? '+' : ''}${trend} cm/hr.`,
    key_factors: [
      `level ${reading.levelCm} cm`,
      `danger level ${village.peakLevelCm} cm`,
      `trend ${trend >= 0 ? '+' : ''}${trend} cm/hr`,
      'deterministic fallback — no model input',
    ],
    data_quality_concern: null,
  };
}

/**
 * Reconcile a model proposal with the deterministic floor.
 *
 * @param {string} villageId
 * @param {object} reading           current reading ({levelCm, trendCmPerHr, ...})
 * @param {object|null} proposed     the model's RiskAssessment, or null if it could not be obtained
 * @param {Error|null} modelError    why it could not be obtained, if applicable
 * @returns {{assessment: object, floor: string, interventions: Array, usedFallback: boolean}}
 */
function applyGuardrails(villageId, reading, proposed, modelError = null) {
  const village = getVillage(villageId);
  const floor = deterministicSeverity(village, reading.levelCm);
  const interventions = [];

  // ---- No usable model output: degrade to the 2024 rule, stay up. ----
  if (!proposed) {
    interventions.push({
      type: INTERVENTION.LLM_UNAVAILABLE,
      detail: modelError ? modelError.message : 'no assessment returned',
      appliedSeverity: floor,
    });
    return { assessment: fallbackAssessment(villageId, reading), floor, interventions, usedFallback: true };
  }

  // ---- Repair what is repairable BEFORE validating. ----
  // Order matters here, and getting it wrong is a safety bug. Validation is
  // all-or-nothing: if we validated first, a confidence of 1.02 on an otherwise
  // perfect assessment would fail the schema, drop us to the fallback, and
  // throw away a genuine EVACUATE escalation over a rounding artefact. A field
  // we can obviously fix must never cost us a warning, so fix it, record that
  // we did, and then validate what is left.
  const candidate = { ...proposed };
  if (
    typeof candidate.confidence === 'number' &&
    (candidate.confidence < 0 || candidate.confidence > 1)
  ) {
    interventions.push({
      type: INTERVENTION.CONFIDENCE_CLAMPED,
      detail: `confidence ${candidate.confidence} clamped into [0, 1]`,
    });
    candidate.confidence = Math.max(0, Math.min(1, candidate.confidence));
  }

  // ---- Validate the shape before trusting any field on it. ----
  const parsed = RiskAssessmentSchema.safeParse(candidate);
  if (!parsed.success) {
    interventions.push({
      type: INTERVENTION.SCHEMA_INVALID,
      detail: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      appliedSeverity: floor,
    });
    return { assessment: fallbackAssessment(villageId, reading), floor, interventions, usedFallback: true };
  }

  const assessment = { ...parsed.data };

  // ---- THE CORE RULE: escalation allowed, downgrade refused. ----
  if (rankOf(assessment.severity) < rankOf(floor)) {
    interventions.push({
      type: INTERVENTION.DOWNGRADE_BLOCKED,
      detail:
        `Model proposed ${assessment.severity} but the river is at ${reading.levelCm} cm ` +
        `against a danger level of ${village.peakLevelCm} cm, which is physically ${floor}. ` +
        `Holding at ${floor}.`,
      proposedSeverity: assessment.severity,
      appliedSeverity: floor,
    });
    assessment.severity = maxSeverity(assessment.severity, floor);
    // A blocked downgrade means the model misread the situation; the confidence
    // attached to that reading should not survive intact.
    assessment.confidence = Math.min(assessment.confidence, 0.5);
  }

  // ---- Consistency: if it is already over the line, it cannot breach "in 4 hours". ----
  if (floor === 'EVACUATE' && (assessment.hours_to_breach === null || assessment.hours_to_breach > 0)) {
    interventions.push({
      type: INTERVENTION.IMPLAUSIBLE_BREACH_TIME,
      detail:
        `Model reported hours_to_breach=${assessment.hours_to_breach} for a river that has ` +
        `already crossed its danger level. Corrected to 0.`,
    });
    assessment.hours_to_breach = 0;
  }

  return { assessment, floor, interventions, usedFallback: false };
}

module.exports = {
  INTERVENTION,
  deterministicSeverity,
  fallbackAssessment,
  applyGuardrails,
};
