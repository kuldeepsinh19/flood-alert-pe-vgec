/**
 * Advisory Agent — the alert that the 2024 build never got around to writing.
 *
 * The original About page described alerts reaching people "through various
 * channels, including mobile phones, sirens, and community loudspeakers". None
 * of that existed. The colour of a dot changed on a web page that a villager
 * was never going to have open, and that was the entire alerting mechanism.
 *
 * This agent produces the actual message. Not a notification payload — the
 * words. That turns out to be a genuinely good use of a language model, because
 * the hard part is not delivery, it is writing something that works when:
 *
 *   - the reader may not read English, so it goes out in Gujarati and Hindi too,
 *   - the reader may not read at all, so there is a loudspeaker script written
 *     to be spoken aloud,
 *   - it must fit in one SMS on a feature phone with no data connection,
 *   - and "move to higher ground" is useless advice, while "move to the
 *     Dhrangadhra road overbridge" is something a person can actually do.
 *
 * Cost control: this only runs for WATCH and above. A NORMAL river needs no
 * advisory, and generating one for every village every cycle would be most of
 * the running cost of the system for no benefit.
 */

const { zodOutputFormat } = require('@anthropic-ai/sdk/helpers/zod');
const { AdvisorySchema } = require('./schemas');
const { getVillage, WARNING_BAND_CM } = require('../lib/villages');
const { MODEL, EFFORT, getClient, isConfigured, newUsageAccumulator } = require('./client');

const MAX_TOKENS = 16000;

const SYSTEM_PROMPT = `You write flood alerts for rural villages in India. A risk assessment has already been made; you turn it into words that reach people in time to act.

WHO YOU ARE WRITING FOR
Farmers, shopkeepers, families. Many did not finish school. Some cannot read. Many have a feature phone with no data. It may be the middle of the night. They will act on what you write only if it is specific and it is obviously about them.

RULES
- SMS: 160 characters maximum, each language. Name the village. Say what is happening, then what to do. No links, no jargon, no "advisory issued pursuant to".
- Provide the same message in English, Gujarati script, and Hindi (Devanagari). These are translations for the same reader, not three different messages.
- Loudspeaker script: written to be READ ALOUD by a person. Short sentences. Repeat the essential instruction at the end. Calm, firm, no panic.
- Actions must name real places from the village profile you are given. "Move to higher ground" is useless. "Move to the Salepur cyclone shelter" is an instruction.
- Audience:
    AUTHORITIES_ONLY          — WATCH. Do not wake a village to tell it a river is slightly up.
    RESIDENTS_AND_AUTHORITIES — WARNING and EVACUATE.
    RESIDENTS                 — rarely; only when there is nothing for officials to do.
- Match urgency to severity honestly. Do not write EVACUATE copy for a WARNING. People who are evacuated for nothing do not evacuate next time.
- Never invent a fact that is not in the assessment or the village profile. No made-up road closures, relief camps, or casualty figures.`;

/** Advisory is generated for WATCH and above only. */
function needsAdvisory(severity) {
  return severity !== 'NORMAL';
}

/**
 * @param {object} assessment  a guardrail-approved RiskAssessment
 * @param {string} villageId
 * @returns {Promise<{advisory: object|null, error: Error|null, trace: object}>}
 */
async function generateAdvisory(assessment, villageId) {
  const startedAt = Date.now();
  const usage = newUsageAccumulator();
  const trace = {
    agent: 'advisoryAgent',
    model: MODEL,
    effort: EFFORT,
    skipped: false,
    latencyMs: 0,
    usage: null,
  };

  if (!needsAdvisory(assessment.severity)) {
    trace.skipped = true;
    trace.skipReason = 'severity NORMAL — no advisory needed';
    trace.usage = usage.get();
    return { advisory: null, error: null, trace };
  }

  if (!isConfigured()) {
    trace.latencyMs = Date.now() - startedAt;
    trace.usage = usage.get();
    return { advisory: null, error: new Error('ANTHROPIC_API_KEY not set'), trace };
  }

  const village = getVillage(villageId);

  const situation = {
    village: village.name,
    district: village.district,
    state: village.state,
    river: village.river,
    population: village.population,
    nearest_high_ground: village.higherGround,
    nearby_villages: village.nearby,
    danger_level_cm: village.peakLevelCm,
    warning_level_cm: village.peakLevelCm - WARNING_BAND_CM,
    assessment: {
      severity: assessment.severity,
      confidence: assessment.confidence,
      predicted_peak_cm: assessment.predicted_peak_cm,
      predicted_peak_in_hours: assessment.predicted_peak_in_hours,
      hours_to_breach: assessment.hours_to_breach,
      reasoning: assessment.reasoning,
      key_factors: assessment.key_factors,
      data_quality_concern: assessment.data_quality_concern,
    },
  };

  try {
    const response = await getClient().messages.parse({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      output_config: { effort: EFFORT, format: zodOutputFormat(AdvisorySchema) },
      messages: [
        {
          role: 'user',
          content: `Write the alert for this situation:\n\n${JSON.stringify(situation, null, 2)}`,
        },
      ],
    });

    usage.add(response.usage);
    trace.latencyMs = Date.now() - startedAt;
    trace.usage = usage.get();
    trace.stopReason = response.stop_reason;

    if (response.stop_reason === 'refusal') {
      return {
        advisory: null,
        error: new Error(`Model declined (${response.stop_details?.category || 'unspecified'})`),
        trace,
      };
    }

    if (!response.parsed_output) {
      return { advisory: null, error: new Error('No parsable advisory returned'), trace };
    }

    // SMS length is a hard constraint of the delivery channel, not a preference.
    // Record overruns rather than silently shipping a message that will be split.
    const advisory = response.parsed_output;
    trace.smsLengths = {
      en: advisory.sms_en.length,
      gu: advisory.sms_gu.length,
      hi: advisory.sms_hi.length,
    };
    trace.smsOverLimit = Object.entries(trace.smsLengths)
      .filter(([, len]) => len > 160)
      .map(([lang]) => lang);

    return { advisory, error: null, trace };
  } catch (error) {
    trace.latencyMs = Date.now() - startedAt;
    trace.usage = usage.get();
    trace.error = error.message;
    return { advisory: null, error, trace };
  }
}

module.exports = { generateAdvisory, needsAdvisory, SYSTEM_PROMPT };
