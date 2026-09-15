/**
 * Structured output contracts for every agent.
 *
 * These are Zod schemas rather than prose instructions on purpose. They are
 * handed to the model through `output_config.format`, so the API constrains
 * generation to this shape — and the SAME object validates the response on the
 * way back, and validates the fixtures in evals/. One definition, three jobs.
 *
 * Note the use of .nullable() rather than .optional() throughout: structured
 * outputs require every property to be present, so "no value" is expressed as
 * an explicit null instead of an absent key.
 */

const { z } = require('zod');

/**
 * Four severity tiers, ordered. The ordering is load-bearing: agents/guardrails.js
 * compares the deterministic floor against the model proposal by RANK, which is
 * what makes "the model may escalate but never downgrade" enforceable in code.
 */
const SEVERITY_LEVELS = ['NORMAL', 'WATCH', 'WARNING', 'EVACUATE'];

const SEVERITY_RANK = Object.freeze(
  SEVERITY_LEVELS.reduce((acc, level, i) => ({ ...acc, [level]: i }), {})
);

function rankOf(severity) {
  const rank = SEVERITY_RANK[severity];
  if (rank === undefined) throw new Error(`Unknown severity "${severity}"`);
  return rank;
}

/** Higher of two severities. */
function maxSeverity(a, b) {
  return rankOf(a) >= rankOf(b) ? a : b;
}

const RiskAssessmentSchema = z.object({
  severity: z
    .enum(SEVERITY_LEVELS)
    .describe(
      'NORMAL: river within its usual range. WATCH: rising but well below the warning level. ' +
        'WARNING: expected to cross the warning level, prepare. EVACUATE: expected to cross or ' +
        'has crossed the danger level, move people now.'
    ),
  confidence: z
    .number()
    .min(0)
    .max(1)
    .describe('Confidence in this assessment, 0 to 1. Lower it when the data looks unreliable.'),
  predicted_peak_cm: z
    .number()
    .describe('Highest river level expected during the forecast window, in centimetres.'),
  predicted_peak_in_hours: z
    .number()
    .describe('Hours from now until that peak is reached.'),
  hours_to_breach: z
    .number()
    .nullable()
    .describe(
      'Hours until the river crosses the DANGER level. Null if it is not expected to cross ' +
        'at all. Zero or negative if it has already crossed.'
    ),
  reasoning: z
    .string()
    .describe(
      'Two to four sentences explaining the call, citing the actual numbers used. Written to be ' +
        'read by a district flood officer, not an engineer.'
    ),
  key_factors: z
    .array(z.string())
    .describe('Three to five short phrases naming what drove this assessment.'),
  data_quality_concern: z
    .string()
    .nullable()
    .describe(
      'Set when the readings themselves look wrong — a flat-lined sensor, a physically ' +
        'impossible jump, rain with no river response. Null when the data looks sound.'
    ),
});

const AdvisorySchema = z.object({
  headline: z.string().describe('Under 10 words. What is happening, in plain language.'),
  sms_en: z
    .string()
    .describe('English SMS alert, 160 characters or fewer. Plain words, no jargon, no acronyms.'),
  sms_gu: z.string().describe('The same SMS in Gujarati script, 160 characters or fewer.'),
  sms_hi: z.string().describe('The same SMS in Hindi (Devanagari) script, 160 characters or fewer.'),
  loudspeaker_script: z
    .string()
    .describe(
      'Script to be read aloud over a village loudspeaker. Short sentences, repeatable, ' +
        'calm. Assumes the listener cannot read.'
    ),
  actions: z
    .array(
      z.object({
        priority: z.enum(['IMMEDIATE', 'SOON', 'PREPARE']),
        instruction: z.string().describe('One concrete physical action.'),
      })
    )
    .describe('Ordered actions. Name real places from the village profile, not generic advice.'),
  audience: z
    .enum(['RESIDENTS', 'RESIDENTS_AND_AUTHORITIES', 'AUTHORITIES_ONLY'])
    .describe('Who this should go to. Do not wake a village at 3am for a WATCH.'),
});

const IncidentReportSchema = z.object({
  headline: z.string().describe('One line summarising the event.'),
  summary: z.string().describe('A short paragraph for a district-level after-action file.'),
  timeline: z
    .array(
      z.object({
        time: z.string().describe('Timestamp or relative time of this step.'),
        event: z.string().describe('What happened or what the system did.'),
      })
    )
    .describe('The event in order, from first signal to resolution.'),
  peak_level_cm: z.number().describe('Highest level actually observed.'),
  lead_time_minutes: z
    .number()
    .describe(
      'Minutes between the first alert being issued and the danger level being crossed. ' +
        'This is the number the whole system exists to maximise.'
    ),
  villages_affected: z.array(z.string()),
  recommendations: z
    .array(z.string())
    .describe('What to change before the next event — thresholds, sensors, procedure.'),
});

module.exports = {
  SEVERITY_LEVELS,
  SEVERITY_RANK,
  rankOf,
  maxSeverity,
  RiskAssessmentSchema,
  AdvisorySchema,
  IncidentReportSchema,
};
