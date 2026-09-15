/**
 * Risk & Reasoning Agent.
 *
 * This is the component the 2024 About page promised and never had. That page
 * claimed the system used "advanced algorithms and predictive models" to
 * "anticipate when water levels are likely to rise to dangerous levels". The
 * code behind it compared one random number to a constant.
 *
 * This agent does the anticipation part for real. It runs in two phases:
 *
 *   Phase 1 — INVESTIGATE (agentic tool loop)
 *     The model is given a village name and four instruments, not a finished
 *     report. It decides what to examine and in what order: usually the level
 *     trend first, then the rain forecast if the river is rising, then the
 *     neighbouring villages if the rain is heavy. Different situations produce
 *     different call sequences, and the trace records which.
 *
 *   Phase 2 — DECIDE (structured output)
 *     With the evidence gathered, one final call constrained by
 *     RiskAssessmentSchema through output_config.format. The API enforces the
 *     shape, so there is no JSON parsing, no regex, and no "the model forgot a
 *     field" failure mode.
 *
 * What comes out of here is a PROPOSAL. It goes to agents/guardrails.js before
 * anyone sees it, and the guardrail can overrule it.
 */

const { zodOutputFormat } = require('@anthropic-ai/sdk/helpers/zod');
const { RiskAssessmentSchema } = require('./schemas');
const { buildTools } = require('./tools');
const { MODEL, EFFORT, getClient, isConfigured, newUsageAccumulator } = require('./client');

const MAX_ITERATIONS = 6; // bounds cost; an assessment needing more than this is a bug
const MAX_TOKENS = 16000;

/**
 * Stable system prompt — deliberately free of timestamps, village names, or any
 * per-request value, so it caches cleanly across every village on every cycle.
 * Anything that varies goes in the user message.
 */
const SYSTEM_PROMPT = `You are the risk assessment agent for FloodSense, a flood early-warning system for rural villages in India.

Your job is ANTICIPATION. A simple threshold rule already handles "the river is over the line right now" — it runs independently of you and it cannot be overridden. What that rule cannot do is see a flood coming. That is your job: given the trend, the rain still to fall, and the shape of the catchment, decide whether this village is heading for trouble and how long they have.

HOW TO WORK
Call the tools before forming a view. A sensible order is usually:
1. get_village_profile — you need the thresholds and how fast this catchment responds before any number means anything.
2. get_level_history — the trend matters more than the current reading.
3. get_rainfall_forecast — rain that has not fallen yet is the main reason to warn early.
4. get_nearby_village_levels — only when it could change your answer, e.g. heavy regional rain.

Stop calling tools once you can justify a decision. Do not call the same tool twice with the same arguments.

HOW TO JUDGE
- All levels are centimetres. All times are hours.
- A catchment with responseHours of 3 gives people very little time; one with responseHours of 16 gives most of a day. The same rising trend means different urgency in each.
- Rain already fallen is in the level data. Rain in the forecast is NOT yet reflected in the river — that is the lead time you are buying.
- Severity tiers:
    NORMAL   — within the usual range, nothing developing.
    WATCH    — rising, worth monitoring, but not expected to reach the warning level.
    WARNING  — expected to cross the WARNING level. Tell people to prepare.
    EVACUATE — expected to cross, or has already crossed, the DANGER level. Move people now.
- Raising the alarm early costs credibility. Raising it late costs lives. When genuinely balanced, choose the higher tier — but do not flag EVACUATE on a flat river under a clear sky, because a system that cries wolf gets ignored and then it kills people too.

DATA QUALITY
Real gauges fail. Say so in data_quality_concern when you see it:
- a perfectly flat reading over many hours (stuck sensor),
- a large jump and immediate return (electrical spike, not water),
- heavy rain hours ago with no river response at all in a fast catchment.
Lower your confidence when the inputs look untrustworthy. Do not silently treat bad data as good news — a stuck sensor reading 80 cm is not reassurance.

Write reasoning for a district flood officer at 2am: concrete numbers, plain words, no hedging and no jargon.`;

/**
 * Run an assessment.
 *
 * @param {string} villageId
 * @param {object} dataSource  from agents/tools.js — live or an eval fixture
 * @returns {Promise<{proposed: object|null, error: Error|null, trace: object}>}
 */
async function assessRisk(villageId, dataSource) {
  const startedAt = Date.now();
  const usage = newUsageAccumulator();
  const trace = {
    agent: 'riskAgent',
    model: MODEL,
    effort: EFFORT,
    dataSource: dataSource.name,
    toolCalls: [],
    iterations: 0,
    stopReason: null,
    latencyMs: 0,
    usage: null,
  };

  if (!isConfigured()) {
    trace.latencyMs = Date.now() - startedAt;
    trace.usage = usage.get();
    trace.stopReason = 'no_api_key';
    return {
      proposed: null,
      error: new Error('ANTHROPIC_API_KEY not set'),
      trace,
    };
  }

  const client = getClient();
  const tools = buildTools(dataSource);
  const runners = new Map(tools.map((t) => [t.name, t.run]));
  // The API must not see our local `run` functions.
  const toolDefs = tools.map(({ run, ...definition }) => definition);

  const messages = [
    {
      role: 'user',
      content:
        `Assess flood risk for village "${villageId}". Investigate with the tools, then I will ` +
        `ask you for the structured assessment.`,
    },
  ];

  try {
    // ---------- Phase 1: investigate ----------
    for (let i = 0; i < MAX_ITERATIONS; i++) {
      trace.iterations = i + 1;

      const response = await client.messages.create({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
        output_config: { effort: EFFORT },
        tools: toolDefs,
        messages,
      });

      usage.add(response.usage);
      trace.stopReason = response.stop_reason;

      // A safety decline on flood data would be surprising, but if it happens we
      // want the deterministic floor, not a crash.
      if (response.stop_reason === 'refusal') {
        throw new Error(
          `Model declined the request (${response.stop_details?.category || 'unspecified'})`
        );
      }

      messages.push({ role: 'assistant', content: response.content });

      if (response.stop_reason === 'pause_turn') continue;

      const toolUses = response.content.filter((b) => b.type === 'tool_use');
      if (toolUses.length === 0) break;

      // Parallel tool calls must all come back in ONE user message.
      const results = [];
      for (const call of toolUses) {
        const toolStarted = Date.now();
        let payload;
        let isError = false;
        try {
          const run = runners.get(call.name);
          if (!run) throw new Error(`No such tool: ${call.name}`);
          payload = await run(call.input);
        } catch (toolError) {
          isError = true;
          payload = { error: toolError.message };
        }
        trace.toolCalls.push({
          name: call.name,
          input: call.input,
          durationMs: Date.now() - toolStarted,
          isError,
        });
        results.push({
          type: 'tool_result',
          tool_use_id: call.id,
          content: JSON.stringify(payload),
          ...(isError ? { is_error: true } : {}),
        });
      }
      messages.push({ role: 'user', content: results });
    }

    // ---------- Phase 2: decide ----------
    messages.push({
      role: 'user',
      content:
        'Now give your structured assessment based on what you found. Cite the actual numbers ' +
        'you saw in your reasoning.',
    });

    const decision = await client.messages.parse({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      output_config: { effort: EFFORT, format: zodOutputFormat(RiskAssessmentSchema) },
      messages,
    });

    usage.add(decision.usage);
    trace.stopReason = decision.stop_reason;
    trace.latencyMs = Date.now() - startedAt;
    trace.usage = usage.get();

    if (!decision.parsed_output) {
      return {
        proposed: null,
        error: new Error('Model returned no parsable structured assessment'),
        trace,
      };
    }

    return { proposed: decision.parsed_output, error: null, trace };
  } catch (error) {
    trace.latencyMs = Date.now() - startedAt;
    trace.usage = usage.get();
    trace.error = error.message;
    return { proposed: null, error, trace };
  }
}

module.exports = { assessRisk, SYSTEM_PROMPT, MAX_ITERATIONS };
