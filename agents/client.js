/**
 * Shared Anthropic client, model configuration, and cost accounting.
 *
 * Cost is tracked per call and rolled into every trace rather than being left
 * as a surprise on a billing page. For a system that would run assessments for
 * hundreds of villages on a monsoon night, "what does one assessment cost and
 * how long does it take" is a design constraint, not a footnote — so it is
 * measured from the first commit.
 */

require('dotenv').config({ quiet: true });

const Anthropic = require('@anthropic-ai/sdk');

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-opus-5';
const EFFORT = process.env.ANTHROPIC_EFFORT || 'medium';

/**
 * USD per million tokens. Cache reads are ~0.1x input, cache writes ~1.25x.
 * Kept here so `npm run evals` can report real money rather than token counts.
 */
const PRICING = {
  'claude-opus-5': { input: 5.0, output: 25.0 },
  'claude-sonnet-5': { input: 2.0, output: 10.0 },
  'claude-haiku-4-5': { input: 1.0, output: 5.0 },
};

let client = null;

/** True when an API key is configured. When false the whole system runs on the deterministic floor. */
function isConfigured() {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

function getClient() {
  if (!isConfigured()) {
    throw new Error(
      'ANTHROPIC_API_KEY is not set. Copy .env.example to .env and add your key, ' +
        'or run without one — the system falls back to the deterministic threshold rule.'
    );
  }
  if (!client) client = new Anthropic();
  return client;
}

/** Dollar cost of one API response. */
function costOf(usage, model = MODEL) {
  if (!usage) return 0;
  const rate = PRICING[model] || PRICING['claude-opus-5'];
  const input = usage.input_tokens || 0;
  const output = usage.output_tokens || 0;
  const cacheRead = usage.cache_read_input_tokens || 0;
  const cacheWrite = usage.cache_creation_input_tokens || 0;

  return (
    (input * rate.input +
      output * rate.output +
      cacheRead * rate.input * 0.1 +
      cacheWrite * rate.input * 1.25) /
    1_000_000
  );
}

/** Running totals across the calls that make up one assessment. */
function newUsageAccumulator() {
  const total = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    calls: 0,
    costUsd: 0,
  };
  return {
    add(usage, model = MODEL) {
      if (!usage) return;
      total.input_tokens += usage.input_tokens || 0;
      total.output_tokens += usage.output_tokens || 0;
      total.cache_read_input_tokens += usage.cache_read_input_tokens || 0;
      total.cache_creation_input_tokens += usage.cache_creation_input_tokens || 0;
      total.calls += 1;
      total.costUsd += costOf(usage, model);
    },
    get() {
      return { ...total, costUsd: Math.round(total.costUsd * 1e6) / 1e6 };
    },
  };
}

module.exports = {
  MODEL,
  EFFORT,
  PRICING,
  isConfigured,
  getClient,
  costOf,
  newUsageAccumulator,
};
