/**
 * Incident Summary Agent.
 *
 * After an event is over, somebody has to write it up. In practice that is a
 * district officer reconstructing a night from a WhatsApp group and memory,
 * days later, which is why so little is ever learned from a near-miss.
 *
 * This agent takes the traces the system already recorded — every assessment,
 * every alert, every guardrail intervention, with timestamps — and produces the
 * after-action report.
 *
 * The number that matters in that report is LEAD TIME: minutes between the
 * first alert going out and the river crossing its danger level. It is the only
 * honest measure of whether the system did its job. A perfectly accurate
 * warning issued as the water arrives is worth nothing. The whole architecture
 * exists to make that one number larger, so it is computed deterministically
 * from the timestamps and handed to the model as a fact, not left to be
 * estimated from prose.
 */

const { zodOutputFormat } = require('@anthropic-ai/sdk/helpers/zod');
const { IncidentReportSchema } = require('./schemas');
const { getVillage } = require('../lib/villages');
const { MODEL, EFFORT, getClient, isConfigured, newUsageAccumulator } = require('./client');

const MAX_TOKENS = 16000;

const SYSTEM_PROMPT = `You write post-event reports for a flood early-warning system, for district disaster management officers.

Your reader is deciding what to change before the next monsoon. They want to know what happened, whether the warning was early enough to be useful, and what to fix. They do not want reassurance.

RULES
- Use only the events and timestamps provided. Never invent a reading, an action taken, or an outcome. If the record does not say whether anyone evacuated, do not say that anyone did.
- Lead time is given to you as a computed fact. Do not recalculate or round it away. If it is small or negative, say plainly that the warning was late and treat that as the main finding.
- The timeline is the spine of the report. Each entry: when, and what happened or what the system did.
- Recommendations must be specific and actionable by this office — a threshold to change, a gauge to service, a procedure to rewrite. Not "improve monitoring".
- If the record shows the AI proposed a lower severity than the physical reading and the guardrail overruled it, that belongs in the report. Suppressing it would defeat the point of logging it.
- Plain administrative English. No drama, no marketing.`;

/**
 * Compute lead time deterministically from the event record.
 * Returns minutes between the first alert at WARNING-or-above and the first
 * reading at or over the danger level. Null when the river never breached.
 */
function computeLeadTimeMinutes(events, dangerLevelCm) {
  const firstAlert = events.find(
    (e) => e.severity === 'WARNING' || e.severity === 'EVACUATE'
  );
  const firstBreach = events.find((e) => e.levelCm >= dangerLevelCm);
  if (!firstAlert || !firstBreach) return null;
  return Math.round((firstBreach.tsMs - firstAlert.tsMs) / 60000);
}

/**
 * @param {object} incident
 * @param {string} incident.villageId
 * @param {Array<{tsMs:number, levelCm:number, severity:string, note?:string,
 *                interventions?:Array}>} incident.events  chronological
 * @returns {Promise<{report: object|null, error: Error|null, trace: object}>}
 */
async function summariseIncident(incident) {
  const startedAt = Date.now();
  const usage = newUsageAccumulator();
  const village = getVillage(incident.villageId);
  const events = [...(incident.events || [])].sort((a, b) => a.tsMs - b.tsMs);

  const leadTimeMinutes = computeLeadTimeMinutes(events, village.peakLevelCm);
  const peakLevelCm = events.length ? Math.max(...events.map((e) => e.levelCm)) : 0;

  const trace = {
    agent: 'incidentAgent',
    model: MODEL,
    effort: EFFORT,
    computedLeadTimeMinutes: leadTimeMinutes,
    computedPeakLevelCm: peakLevelCm,
    eventCount: events.length,
    latencyMs: 0,
    usage: null,
  };

  if (!isConfigured()) {
    trace.latencyMs = Date.now() - startedAt;
    trace.usage = usage.get();
    return { report: null, error: new Error('ANTHROPIC_API_KEY not set'), trace };
  }

  const record = {
    village: village.name,
    district: village.district,
    state: village.state,
    river: village.river,
    population: village.population,
    danger_level_cm: village.peakLevelCm,
    computed_facts: {
      peak_level_cm: peakLevelCm,
      lead_time_minutes: leadTimeMinutes,
      lead_time_note:
        leadTimeMinutes === null
          ? 'River did not cross the danger level, or no alert was issued. Lead time undefined.'
          : 'Minutes between the first WARNING-or-above alert and the danger level being crossed.',
    },
    events: events.map((e) => ({
      time: new Date(e.tsMs).toISOString(),
      level_cm: e.levelCm,
      severity: e.severity,
      note: e.note || null,
      guardrail_interventions: e.interventions || [],
    })),
  };

  try {
    const response = await getClient().messages.parse({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      output_config: { effort: EFFORT, format: zodOutputFormat(IncidentReportSchema) },
      messages: [
        {
          role: 'user',
          content: `Write the after-action report for this event:\n\n${JSON.stringify(record, null, 2)}`,
        },
      ],
    });

    usage.add(response.usage);
    trace.latencyMs = Date.now() - startedAt;
    trace.usage = usage.get();
    trace.stopReason = response.stop_reason;

    if (!response.parsed_output) {
      return { report: null, error: new Error('No parsable report returned'), trace };
    }

    // The computed facts win over anything the model wrote for these two fields.
    const report = {
      ...response.parsed_output,
      peak_level_cm: peakLevelCm,
      lead_time_minutes: leadTimeMinutes ?? response.parsed_output.lead_time_minutes,
    };

    return { report, error: null, trace };
  } catch (error) {
    trace.latencyMs = Date.now() - startedAt;
    trace.usage = usage.get();
    trace.error = error.message;
    return { report: null, error, trace };
  }
}

module.exports = { summariseIncident, computeLeadTimeMinutes, SYSTEM_PROMPT };
