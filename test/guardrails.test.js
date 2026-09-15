/**
 * Guardrail tests.
 *
 * The README makes a specific safety claim: the model may escalate severity but
 * can never lower it below what the physical reading establishes, and the system
 * keeps working when the model does not. A claim like that is worth nothing
 * unless it is tested, so these are the tests that back it.
 *
 * Run with: npm test
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  applyGuardrails,
  deterministicSeverity,
  fallbackAssessment,
  INTERVENTION,
} = require('../agents/guardrails');
const { getVillage } = require('../lib/villages');
const { maxSeverity, rankOf } = require('../agents/schemas');

const MANGARH = getVillage('mangarh'); // danger 140 cm, warning 120 cm

/** A well-formed model proposal, to be mutated per test. */
function proposal(overrides = {}) {
  return {
    severity: 'NORMAL',
    confidence: 0.9,
    predicted_peak_cm: 80,
    predicted_peak_in_hours: 2,
    hours_to_breach: null,
    reasoning: 'River is steady and well below its warning level.',
    key_factors: ['flat trend', 'no rain forecast'],
    data_quality_concern: null,
    ...overrides,
  };
}

const reading = (levelCm, trendCmPerHr = 0) => ({ levelCm, trendCmPerHr });

// ---------------------------------------------------------------------------
// The floor is the 2024 rule, unchanged.
// ---------------------------------------------------------------------------

test('deterministic floor reproduces the 2024 threshold rule', () => {
  assert.equal(deterministicSeverity(MANGARH, 100), 'NORMAL');
  assert.equal(deterministicSeverity(MANGARH, 119.9), 'NORMAL');
  assert.equal(deterministicSeverity(MANGARH, 120), 'WARNING'); // peak - 20
  assert.equal(deterministicSeverity(MANGARH, 139.9), 'WARNING');
  assert.equal(deterministicSeverity(MANGARH, 140), 'EVACUATE'); // peak
  assert.equal(deterministicSeverity(MANGARH, 500), 'EVACUATE');
});

// ---------------------------------------------------------------------------
// THE CORE SAFETY CLAIM
// ---------------------------------------------------------------------------

test('a model downgrade below the physical floor is refused', () => {
  // River is 15 cm OVER its danger level. The model says everything is fine.
  const { assessment, floor, interventions } = applyGuardrails(
    'mangarh',
    reading(155, 12),
    proposal({ severity: 'NORMAL', confidence: 0.99 })
  );

  assert.equal(floor, 'EVACUATE');
  assert.equal(assessment.severity, 'EVACUATE', 'guardrail must hold the floor');

  const blocked = interventions.find((i) => i.type === INTERVENTION.DOWNGRADE_BLOCKED);
  assert.ok(blocked, 'the blocked downgrade must be recorded, not silently corrected');
  assert.equal(blocked.proposedSeverity, 'NORMAL');
  assert.equal(blocked.appliedSeverity, 'EVACUATE');

  assert.ok(
    assessment.confidence <= 0.5,
    'confidence must be cut when the model demonstrably misread the situation'
  );
});

test('every downgrade across every tier pair is refused', () => {
  // Exhaustive rather than illustrative: for each physical level, no proposal
  // of any lower tier may survive.
  const levels = [90, 125, 145];
  for (const level of levels) {
    const floor = deterministicSeverity(MANGARH, level);
    for (const proposed of ['NORMAL', 'WATCH', 'WARNING', 'EVACUATE']) {
      const { assessment } = applyGuardrails('mangarh', reading(level), proposal({ severity: proposed }));
      assert.equal(
        assessment.severity,
        maxSeverity(proposed, floor),
        `level ${level} (floor ${floor}) with proposal ${proposed}`
      );
      assert.ok(
        rankOf(assessment.severity) >= rankOf(floor),
        `level ${level}: final severity fell below the floor`
      );
    }
  }
});

test('the model may escalate freely — that is the point of having it', () => {
  // River is calm, but the agent has seen 60mm of rain coming into a flashy catchment.
  const { assessment, floor, interventions } = applyGuardrails(
    'mangarh',
    reading(85, 4),
    proposal({ severity: 'EVACUATE', confidence: 0.8, hours_to_breach: 5 })
  );

  assert.equal(floor, 'NORMAL');
  assert.equal(assessment.severity, 'EVACUATE', 'escalation must pass through untouched');
  assert.equal(assessment.confidence, 0.8, 'escalation must not be penalised');
  assert.equal(
    interventions.filter((i) => i.type === INTERVENTION.DOWNGRADE_BLOCKED).length,
    0
  );
});

// ---------------------------------------------------------------------------
// Degradation: the system must stay up without the model.
// ---------------------------------------------------------------------------

test('a missing model response falls back to the threshold rule', () => {
  const { assessment, usedFallback, interventions } = applyGuardrails(
    'mangarh',
    reading(145, 8),
    null,
    new Error('connection timed out')
  );

  assert.equal(usedFallback, true);
  assert.equal(assessment.severity, 'EVACUATE', 'the river is over the line, key or no key');
  assert.equal(interventions[0].type, INTERVENTION.LLM_UNAVAILABLE);
  assert.match(interventions[0].detail, /connection timed out/);
  assert.ok(assessment.reasoning.length > 0, 'fallback must still explain itself');
});

test('a malformed model response is rejected, not partially trusted', () => {
  const { assessment, usedFallback, interventions } = applyGuardrails(
    'mangarh',
    reading(150),
    { severity: 'CATASTROPHIC', confidence: 'very high' } // not our schema
  );

  assert.equal(usedFallback, true);
  assert.equal(interventions[0].type, INTERVENTION.SCHEMA_INVALID);
  assert.equal(assessment.severity, 'EVACUATE');
});

test('the deterministic fallback is itself a valid assessment', () => {
  const { RiskAssessmentSchema } = require('../agents/schemas');
  for (const level of [70, 125, 160]) {
    const result = RiskAssessmentSchema.safeParse(fallbackAssessment('mangarh', reading(level, 6)));
    assert.ok(result.success, `fallback at ${level} cm failed its own schema`);
  }
});

// ---------------------------------------------------------------------------
// Internal consistency of what we display.
// ---------------------------------------------------------------------------

test('an already-breached river cannot be "4 hours from breaching"', () => {
  const { assessment, interventions } = applyGuardrails(
    'mangarh',
    reading(150),
    proposal({ severity: 'EVACUATE', hours_to_breach: 4 })
  );

  assert.equal(assessment.hours_to_breach, 0);
  assert.ok(interventions.some((i) => i.type === INTERVENTION.IMPLAUSIBLE_BREACH_TIME));
});

test('out-of-range confidence is repaired, not treated as a fatal error', () => {
  const { assessment, interventions, usedFallback } = applyGuardrails(
    'mangarh',
    reading(80),
    proposal({ confidence: 1.7 })
  );

  assert.equal(assessment.confidence, 1);
  assert.equal(usedFallback, false, 'a repairable field must not trigger the fallback');
  assert.ok(interventions.some((i) => i.type === INTERVENTION.CONFIDENCE_CLAMPED));
});

test('a repairable field never costs us a real escalation', () => {
  // Regression test for a genuine safety bug. Validation is all-or-nothing, so
  // when it ran before repair, an out-of-range confidence on an otherwise valid
  // assessment dropped the whole thing to the deterministic fallback — turning
  // a model-detected EVACUATE on a physically-calm river back into NORMAL, and
  // losing exactly the early warning the AI layer exists to provide.
  const { assessment, usedFallback } = applyGuardrails(
    'mangarh',
    reading(85, 4), // floor is NORMAL — only the model knows trouble is coming
    proposal({ severity: 'EVACUATE', confidence: 1.4, hours_to_breach: 5 })
  );

  assert.equal(usedFallback, false);
  assert.equal(assessment.severity, 'EVACUATE', 'the escalation must survive the repair');
  assert.equal(assessment.confidence, 1);
  assert.equal(assessment.hours_to_breach, 5);
});

test('a clean agreement between model and floor produces no interventions', () => {
  const { assessment, interventions, usedFallback } = applyGuardrails(
    'mangarh',
    reading(85),
    proposal({ severity: 'NORMAL' })
  );

  assert.equal(usedFallback, false);
  assert.deepEqual(interventions, []);
  assert.equal(assessment.severity, 'NORMAL');
  assert.equal(assessment.confidence, 0.9, 'an untouched assessment must pass through verbatim');
});
