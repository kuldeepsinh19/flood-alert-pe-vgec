#!/usr/bin/env node
/**
 * Eval harness for the risk agent.
 *
 *   npm run evals                 # full run against every scenario
 *   npm run evals -- --baseline   # score the 2024 threshold rule only (free, no API calls)
 *   npm run evals -- --limit 5    # first 5 scenarios, for a cheap smoke test
 *
 * WHY THIS EXISTS
 *
 * "The AI makes it better" is not a claim, it is a hypothesis. The 2024
 * threshold rule is a real system that gets 58% of these scenarios right on its
 * own. If the agent cannot beat that by enough to justify its latency and its
 * cost, the honest conclusion is to ship the rule and delete the agent.
 *
 * THE METRIC THAT MATTERS
 *
 * Headline accuracy is reported, but it is the wrong thing to optimise on its
 * own, because the errors are not symmetric. Calling EVACUATE on a calm river
 * costs credibility. Calling NORMAL on a river that is about to take a village
 * costs lives. So MISSED EVACUATIONS — life-critical scenarios where the system
 * predicted a lower tier than the truth — are counted and reported separately,
 * and a run with a better accuracy but a worse missed-evacuation rate is a
 * regression, not an improvement.
 */

const fs = require('fs');
const path = require('path');

const { scenarios } = require('./scenarios.json');
const { createFixtureDataSource } = require('../agents/tools');
const { assessRisk } = require('../agents/riskAgent');
const { applyGuardrails, deterministicSeverity } = require('../agents/guardrails');
const { rankOf, SEVERITY_LEVELS } = require('../agents/schemas');
const { getVillage } = require('../lib/villages');
const { isConfigured, MODEL } = require('../agents/client');

const args = process.argv.slice(2);
const BASELINE_ONLY = args.includes('--baseline') || !isConfigured();
const LIMIT = (() => {
  const i = args.indexOf('--limit');
  return i >= 0 ? Number(args[i + 1]) : Infinity;
})();

const pad = (s, n) => String(s).padEnd(n);
const padL = (s, n) => String(s).padStart(n);
const pct = (n, d) => (d === 0 ? '  n/a' : `${((100 * n) / d).toFixed(1)}%`);

/** Score one prediction against its label. */
function score(scenario, predictedSeverity, dataQualityConcern) {
  const expectedRank = rankOf(scenario.expectedSeverity);
  const predictedRank = rankOf(predictedSeverity);
  return {
    exact: predictedRank === expectedRank,
    under: predictedRank < expectedRank,
    over: predictedRank > expectedRank,
    missedEvacuation: scenario.lifeCritical && predictedRank < expectedRank,
    dataQualityExpected: Boolean(scenario.expectDataQualityFlag),
    dataQualityCaught: Boolean(scenario.expectDataQualityFlag && dataQualityConcern),
  };
}

function summarise(label, rows) {
  const n = rows.length;
  const exact = rows.filter((r) => r.exact).length;
  const under = rows.filter((r) => r.under).length;
  const over = rows.filter((r) => r.over).length;
  const critical = rows.filter((r) => r.scenario.lifeCritical);
  const missed = rows.filter((r) => r.missedEvacuation);
  const dq = rows.filter((r) => r.dataQualityExpected);
  const dqCaught = dq.filter((r) => r.dataQualityCaught);

  return {
    label,
    n,
    accuracy: exact / n,
    exact,
    under,
    over,
    lifeCritical: critical.length,
    missedEvacuations: missed.length,
    missedEvacuationRate: critical.length ? missed.length / critical.length : 0,
    missedIds: missed.map((r) => r.scenario.id),
    dataQualityExpected: dq.length,
    dataQualityCaught: dqCaught.length,
    meanLatencyMs: n ? Math.round(rows.reduce((s, r) => s + (r.latencyMs || 0), 0) / n) : 0,
    totalCostUsd: rows.reduce((s, r) => s + (r.costUsd || 0), 0),
  };
}

function confusionMatrix(rows) {
  const matrix = {};
  for (const expected of SEVERITY_LEVELS) {
    matrix[expected] = {};
    for (const predicted of SEVERITY_LEVELS) matrix[expected][predicted] = 0;
  }
  for (const r of rows) matrix[r.scenario.expectedSeverity][r.predicted] += 1;
  return matrix;
}

function printMatrix(matrix) {
  console.log(`\n  ${pad('expected \\ predicted', 22)}${SEVERITY_LEVELS.map((s) => padL(s, 10)).join('')}`);
  for (const expected of SEVERITY_LEVELS) {
    const cells = SEVERITY_LEVELS.map((predicted) => {
      const v = matrix[expected][predicted];
      const mark = v === 0 ? '.' : String(v);
      return padL(expected === predicted && v > 0 ? `[${mark}]` : mark, 10);
    }).join('');
    console.log(`  ${pad(expected, 22)}${cells}`);
  }
  console.log('\n  Cells below the diagonal are UNDER-calls. In the EVACUATE row they are missed evacuations.');
}

function printSummary(s) {
  console.log(`\n${'='.repeat(78)}`);
  console.log(`  ${s.label}`);
  console.log('='.repeat(78));
  console.log(`  Scenarios              ${s.n}`);
  console.log(`  Accuracy               ${pct(s.exact, s.n)}  (${s.exact}/${s.n} exact)`);
  console.log(`  Under-called           ${s.under}`);
  console.log(`  Over-called            ${s.over}`);
  console.log(`  ---`);
  console.log(`  Life-critical          ${s.lifeCritical}`);
  console.log(`  MISSED EVACUATIONS     ${s.missedEvacuations}  (${pct(s.missedEvacuations, s.lifeCritical)} of life-critical)`);
  if (s.missedIds.length) {
    for (const id of s.missedIds) console.log(`      missed: ${id}`);
  }
  console.log(`  ---`);
  console.log(`  Bad-data cases caught  ${s.dataQualityCaught}/${s.dataQualityExpected}`);
  if (s.meanLatencyMs) console.log(`  Mean latency           ${(s.meanLatencyMs / 1000).toFixed(1)}s`);
  if (s.totalCostUsd) {
    console.log(`  Total cost             $${s.totalCostUsd.toFixed(4)}`);
    console.log(`  Cost per assessment    $${(s.totalCostUsd / s.n).toFixed(4)}`);
  }
}

async function main() {
  const selected = scenarios.slice(0, LIMIT);

  console.log(`\nFloodSense eval harness`);
  console.log(`  scenarios : ${selected.length}`);
  console.log(`  model     : ${BASELINE_ONLY ? '(baseline only — no model calls)' : MODEL}`);
  if (!isConfigured() && !args.includes('--baseline')) {
    console.log(`  note      : ANTHROPIC_API_KEY is not set, so only the deterministic`);
    console.log(`              baseline can be scored. Set it in .env for the full run.`);
  }
  console.log('');

  // ---- Baseline: the 2024 threshold rule, no model involved. ----
  const baselineRows = selected.map((scenario) => {
    const village = getVillage(scenario.villageId);
    const last = scenario.levelSeriesCm[scenario.levelSeriesCm.length - 1];
    const predicted = deterministicSeverity(village, last);
    return { scenario, predicted, ...score(scenario, predicted, null) };
  });

  if (BASELINE_ONLY) {
    printSummary(summarise('BASELINE — 2024 threshold rule (no AI)', baselineRows));
    printMatrix(confusionMatrix(baselineRows));
    console.log('');
    return;
  }

  // ---- Agent run ----
  const agentRows = [];
  for (const [i, scenario] of selected.entries()) {
    process.stdout.write(`  [${padL(i + 1, 2)}/${selected.length}] ${pad(scenario.id, 42)}`);

    const dataSource = createFixtureDataSource(scenario);
    const reading = dataSource.getCurrent(scenario.villageId);
    const { proposed, error, trace } = await assessRisk(scenario.villageId, dataSource);
    const { assessment } = applyGuardrails(scenario.villageId, reading, proposed, error);

    const row = {
      scenario,
      predicted: assessment.severity,
      latencyMs: trace.latencyMs,
      costUsd: trace.usage?.costUsd || 0,
      toolCalls: trace.toolCalls.map((t) => t.name),
      reasoning: assessment.reasoning,
      dataQualityConcern: assessment.data_quality_concern,
      error: error ? error.message : null,
      ...score(scenario, assessment.severity, assessment.data_quality_concern),
    };
    agentRows.push(row);

    const mark = row.exact ? 'ok  ' : row.missedEvacuation ? 'MISS' : row.under ? 'under' : 'over';
    console.log(
      `${pad(scenario.expectedSeverity, 10)}-> ${pad(row.predicted, 10)} ${pad(mark, 6)} ` +
        `${padL((row.latencyMs / 1000).toFixed(1) + 's', 7)} ${padL('$' + row.costUsd.toFixed(4), 9)}`
    );
  }

  const baseline = summarise('BASELINE — 2024 threshold rule (no AI)', baselineRows);
  const agent = summarise(`AGENT — ${MODEL} + guardrails`, agentRows);

  printSummary(baseline);
  printSummary(agent);
  printMatrix(confusionMatrix(agentRows));

  // ---- The verdict: did the AI layer earn its keep? ----
  console.log(`\n${'='.repeat(78)}`);
  console.log('  VERDICT');
  console.log('='.repeat(78));
  const accDelta = (agent.accuracy - baseline.accuracy) * 100;
  const missDelta = baseline.missedEvacuations - agent.missedEvacuations;
  console.log(`  Accuracy            ${pct(baseline.exact, baseline.n)} -> ${pct(agent.exact, agent.n)}   (${accDelta >= 0 ? '+' : ''}${accDelta.toFixed(1)} pts)`);
  console.log(`  Missed evacuations  ${baseline.missedEvacuations} -> ${agent.missedEvacuations}   (${missDelta >= 0 ? '-' : '+'}${Math.abs(missDelta)})`);
  console.log(`  Cost per assessment $${(agent.totalCostUsd / agent.n).toFixed(4)}`);
  console.log(`  Mean latency        ${(agent.meanLatencyMs / 1000).toFixed(1)}s`);
  console.log('');
  if (agent.missedEvacuations > baseline.missedEvacuations) {
    console.log('  REGRESSION: the agent misses more life-critical events than the plain rule.');
    console.log('  That is disqualifying regardless of headline accuracy.');
  } else if (agent.accuracy <= baseline.accuracy && agent.missedEvacuations === baseline.missedEvacuations) {
    console.log('  The agent is not beating the rule. It is not earning its cost or latency.');
  } else {
    console.log('  The agent improves on the rule, including on life-critical scenarios.');
  }

  const outPath = path.join(__dirname, 'results.json');
  fs.writeFileSync(
    outPath,
    JSON.stringify(
      {
        ranAt: new Date().toISOString(),
        model: MODEL,
        baseline,
        agent,
        confusion: confusionMatrix(agentRows),
        rows: agentRows.map((r) => ({
          id: r.scenario.id,
          expected: r.scenario.expectedSeverity,
          predicted: r.predicted,
          exact: r.exact,
          missedEvacuation: r.missedEvacuation,
          toolCalls: r.toolCalls,
          latencyMs: r.latencyMs,
          costUsd: r.costUsd,
          dataQualityConcern: r.dataQualityConcern,
          reasoning: r.reasoning,
        })),
      },
      null,
      2
    )
  );
  console.log(`\n  Full results written to ${path.relative(process.cwd(), outPath)}\n`);
}

main().catch((error) => {
  console.error('\neval run failed:', error.message);
  process.exit(1);
});
