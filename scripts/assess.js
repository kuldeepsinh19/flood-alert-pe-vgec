#!/usr/bin/env node
/**
 * CLI assessment runner — the fastest way to see the agent work.
 *
 *   npm run assess                    # every village
 *   npm run assess -- mangarh         # one village
 *   npm run assess -- mangarh --json  # raw result, for piping
 *
 * Runs the same orchestrator the web app uses, so what you see here is exactly
 * what /api/assess/:village returns. Works without an API key — it will just
 * report DETERMINISTIC_FALLBACK and show you the 2024 threshold logic instead.
 */

const orchestrator = require('../agents/orchestrator');
const { listVillages, isVillage } = require('../lib/villages');
const { isConfigured, MODEL } = require('../agents/client');

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const refresh = args.includes('--refresh');
const named = args.filter((a) => !a.startsWith('--'));

const BADGE = {
  NORMAL: '  NORMAL  ',
  WATCH: '  WATCH   ',
  WARNING: ' WARNING  ',
  EVACUATE: ' EVACUATE ',
};

function render(result) {
  const r = result.reading;
  const a = result.assessment;
  const t = result.thresholds;

  console.log(`\n${'─'.repeat(74)}`);
  console.log(
    `  ${result.villageName.toUpperCase()}   [${BADGE[a.severity].trim()}]   ` +
      `${result.mode === 'AI_ASSESSED' ? 'AI assessed' : 'deterministic fallback'}`
  );
  console.log('─'.repeat(74));
  console.log(
    `  level ${r.levelCm} cm   trend ${r.trendCmPerHr >= 0 ? '+' : ''}${r.trendCmPerHr} cm/hr   ` +
      `warning ${t.warningLevelCm} cm   danger ${t.dangerLevelCm} cm`
  );
  console.log(
    `  predicted peak ${a.predicted_peak_cm} cm in ${a.predicted_peak_in_hours}h   ` +
      `time to danger: ${a.hours_to_breach === null ? 'not expected' : a.hours_to_breach + 'h'}   ` +
      `confidence ${(a.confidence * 100).toFixed(0)}%`
  );

  console.log(`\n  REASONING`);
  console.log(`    ${a.reasoning.replace(/\n/g, '\n    ')}`);

  if (a.key_factors?.length) {
    console.log(`\n  KEY FACTORS`);
    for (const f of a.key_factors) console.log(`    - ${f}`);
  }

  if (a.data_quality_concern) {
    console.log(`\n  DATA QUALITY CONCERN`);
    console.log(`    ${a.data_quality_concern}`);
  }

  const g = result.guardrail;
  console.log(`\n  GUARDRAIL`);
  console.log(`    deterministic floor : ${g.deterministicFloor}`);
  console.log(`    final severity      : ${g.finalSeverity}${g.escalatedByModel ? '   <- escalated by the model' : ''}`);
  if (g.interventions.length) {
    for (const i of g.interventions) console.log(`    [${i.type}] ${i.detail}`);
  } else {
    console.log(`    no interventions`);
  }

  if (result.advisory) {
    const ad = result.advisory;
    console.log(`\n  ALERT TO BE SENT   (audience: ${ad.audience})`);
    console.log(`    ${ad.headline}`);
    console.log(`\n    SMS (en): ${ad.sms_en}`);
    console.log(`    SMS (gu): ${ad.sms_gu}`);
    console.log(`    SMS (hi): ${ad.sms_hi}`);
    console.log(`\n    LOUDSPEAKER:`);
    console.log(`    ${ad.loudspeaker_script.replace(/\n/g, '\n    ')}`);
    console.log(`\n    ACTIONS:`);
    for (const act of ad.actions) console.log(`      [${act.priority}] ${act.instruction}`);
  }

  console.log(
    `\n  ${result.trace.totalLatencyMs}ms   $${result.trace.totalCostUsd.toFixed(4)}   ` +
      `tools: ${result.trace.agents[0].toolCalls.map((c) => c.name).join(' -> ') || 'none'}`
  );
}

async function main() {
  const targets = named.length ? named : listVillages().map((v) => v.id);

  for (const name of targets) {
    if (!isVillage(name)) {
      console.error(`Unknown village "${name}". Known: ${listVillages().map((v) => v.id).join(', ')}`);
      process.exitCode = 1;
      return;
    }
  }

  if (!asJson) {
    console.log(`\nFloodSense assessment`);
    console.log(`  model : ${isConfigured() ? MODEL : 'none (ANTHROPIC_API_KEY not set — deterministic fallback)'}`);
    console.log(`  rivers: SIMULATED (lib/hydrology.js)   rainfall: live via Open-Meteo where reachable`);
  }

  const results = [];
  for (const name of targets) {
    const result = await orchestrator.assessVillage(name, { refresh });
    results.push(result);
    if (!asJson) render(result);
  }

  if (asJson) {
    console.log(JSON.stringify(results.length === 1 ? results[0] : results, null, 2));
  } else {
    const spend = results.reduce((s, r) => s + r.trace.totalCostUsd, 0);
    console.log(`\n${'─'.repeat(74)}`);
    console.log(`  ${results.length} village(s)   total spend $${spend.toFixed(4)}`);
    console.log('');
  }
}

main().catch((error) => {
  console.error('assessment failed:', error.message);
  process.exit(1);
});
