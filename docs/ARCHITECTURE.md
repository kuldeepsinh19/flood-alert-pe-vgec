# Architecture

Design notes for FloodSense AI — why the pieces are shaped the way they are. The README covers what it does; this covers the decisions.

---

## 1. Why an agent at all

The 2024 system compared a number to a constant. That is not a bad rule — it is right about the present, and it is right for free, instantly, forever. It has exactly one flaw: it is blind to the future.

The eval set makes the cost of that blindness concrete. Three of its 24 scenarios are life-critical events where the river is **below** its danger level at assessment time:

- `flash-flood-incoming-bhangarh` — 104→148 cm and climbing, with 115 mm forecast into a catchment that responds in 3 hours.
- `cloudburst-calm-river-adarshnagar` — river at 86 cm against a 130 cm danger level, under a cloudburst delivering ~130 mm.
- `rapid-approach-danger-sihor` — 94→107 cm at 8 cm/hr against a 110 cm threshold, with more rain coming.

The threshold rule scores all three as `NORMAL` or `WARNING`, and it is not malfunctioning when it does — the water genuinely is not there yet. But a warning that arrives with the water is not a warning.

Judging those requires combining a trend, an unfallen rainfall forecast, and a catchment's response time into a call about the next few hours. That is a reasoning task over heterogeneous evidence, which is what an LLM is actually good at.

**The argument for the agent is narrow and falsifiable:** it should convert those three misses into hits without inventing alarms elsewhere. `npm run evals` prints exactly that comparison and returns a verdict. If the agent does not beat the rule, the honest answer is to delete the agent.

---

## 2. Agentic, not prompt-shaped

The Risk agent is not handed a pre-built situation report. It gets a village name and four tools, and decides what to look at:

| Tool | Returns |
|---|---|
| `get_village_profile` | thresholds, catchment area, response hours, flashiness, population, local high ground |
| `get_level_history` | hourly-downsampled level series with summary statistics and trend |
| `get_rainfall_forecast` | hours ahead, with a `source` field marking live vs. simulated |
| `get_nearby_village_levels` | other monitored villages, for regional signal |

It runs in two phases:

1. **Investigate** — a manual tool-use loop (`client.messages.create` with `tools`), bounded at 6 iterations. A manual loop rather than the SDK tool runner because every tool call, its arguments, and its duration goes into the trace, and because `pause_turn` and `refusal` are handled explicitly.
2. **Decide** — one `client.messages.parse()` call with `output_config.format` bound to `RiskAssessmentSchema`. The API constrains generation to the schema, so there is no JSON parsing, no regex, and no missing-field failure mode.

Splitting them costs one extra call, bought back by prompt caching on the (deliberately value-free) system prompt. What it buys is a clean separation: gathering evidence and committing to a verdict are different operations and fail differently.

### Tool design notes

**Token hygiene.** 24 hours at 10-minute resolution is 144 readings — a few thousand tokens of mostly-redundant numbers on every call. `get_level_history` downsamples to hourly, but computes min/max/net-change from the **full** series, so a brief spike or the true maximum is never lost to downsampling.

**Dependency injection.** Tools read through an injected `dataSource`, not by importing `lib/hydrology` directly. That is what lets the eval harness substitute fixed scenario fixtures and test the agent on a stuck sensor or a cloudburst — situations that would take months to occur naturally. Same agent code, same tool surface, deterministic inputs.

**Honest provenance.** Every payload carries where it came from (`open-meteo`, `simulated`, `scenario-fixture`) so the model can weigh a live forecast differently from a synthetic one, and so a reader of the trace can too.

---

## 3. The guardrail contract

> The model may **escalate** severity. It may never **downgrade** below the level physics has already established.

`agents/guardrails.js` is the only place severity is finalised. The order of operations is load-bearing:

```
1. deterministicSeverity(village, level)   ← the 2024 rule, runs independently
2. repair repairable fields                ← clamp confidence into [0,1]
3. validate against the schema             ← all-or-nothing
4. severity = max(floor, proposal)         ← escalation passes, downgrade blocked
5. consistency fixes                       ← breached rivers cannot "breach in 4h"
6. record every intervention
```

### Why repair precedes validation

This ordering came from a real bug caught by a failing test. Validation is all-or-nothing. With validation first, a `confidence` of `1.02` — a rounding artefact on an otherwise perfect assessment — failed the schema, dropped to the deterministic fallback, and **discarded a genuine `EVACUATE` escalation on a physically calm river**. That is precisely the early warning the AI layer exists to produce, thrown away over a cosmetic field.

The rule: a field you can obviously fix must never cost you a warning. Fix it, record that you did, then validate what remains. `test/guardrails.test.js` has a regression test named for this.

### Failure modes and what each does

| Situation | Behaviour |
|---|---|
| No `ANTHROPIC_API_KEY` | Deterministic fallback, `mode: DETERMINISTIC_FALLBACK`, surfaced in the UI |
| API timeout / network failure | Same, with the error recorded in the trace |
| `stop_reason: "refusal"` | Treated as unavailable → fallback |
| Malformed or unparsable output | `SCHEMA_INVALID` → fallback |
| Model proposes below the floor | `DOWNGRADE_BLOCKED`, floor held, **confidence cut to ≤0.5** |
| Repairable out-of-range field | `CONFIDENCE_CLAMPED`, assessment survives |

The system never returns "no assessment". It returns a worse one, and says so.

### Why confidence is cut on a blocked downgrade

A model that says `NORMAL` about a river 15 cm over its danger mark has demonstrably misread the situation. Whatever calibration its 0.99 confidence claimed does not survive that, and the displayed number should reflect it.

---

## 4. Severity tiers

Four tiers, deliberately ordered so `maxSeverity` is a rank comparison:

```
NORMAL(0) → WATCH(1) → WARNING(2) → EVACUATE(3)
```

The 2024 system had three states (green / orange / red) driven purely by level. `WATCH` is the new one, and it exists specifically to hold *"nothing is wrong yet but something is developing"* — the state the threshold rule cannot represent because no threshold has been crossed. It maps to `AUTHORITIES_ONLY` in the advisory: worth a district officer knowing, not worth waking a village for.

That mapping is the false-alarm budget. A system that wakes people for nothing gets ignored, and then it kills people too.

---

## 5. Cost and latency

Real constraints, not footnotes — this would run for hundreds of villages on a monsoon night.

| Decision | Reason |
|---|---|
| Assessments cached per village, 10 min | A page refresh must not spend money |
| Advisory only for `WATCH`+ | A `NORMAL` river needs no alert; this is most of the potential spend |
| First paint is model-free | The villages page renders instantly from `quickSnapshot()`; agents run on click |
| Sequential, not parallel | Seven concurrent runs is a rate-limit risk with no user-visible benefit |
| System prompts contain no per-request values | Keeps the cache prefix stable across every village and cycle |
| Per-call token + USD accounting | `agents/client.js`; rolled into every trace and the eval report |

Effort is `medium` by default (`ANTHROPIC_EFFORT`). The risk assessment is a bounded judgement over a handful of numbers, not a research task; `high` is available when correctness matters more than cost.

---

## 6. The hydrology simulator

`lib/hydrology.js` replaces `Math.random()`. It routes seeded synthetic storms through two cascaded linear reservoirs — a Nash cascade, the standard textbook rainfall-runoff model:

```
rainfall → × runoff coefficient × area factor → [reservoir k] → [reservoir k] → level
```

This produces what forecasting needs and a random number cannot have:

1. **Lag** between rain falling and the river responding (`responseHours`).
2. **Shape** — a smooth rising limb and an exponential recession, so a trend means something.
3. **Per-village character** — Bhangarh (95 km², flashiness 0.85, 3 h) spikes and drains fast; Sarai (610 km², flashiness 0.18, 16 h) rises slowly and stays up, which is why the same rainfall warrants different urgency.

**Self-calibrating gain.** Each village's output is scaled by running a reference storm (30 mm/hr for 4 h) through its own routing and solving for the gain that puts a severe event just above its danger threshold. Without it, all seven would need hand-tuned magic numbers, and adding a village would mean tuning another.

**Determinism.** Everything is a pure function of absolute wall-clock time and a per-village seed. Demos and evals reproduce exactly — and because it is a function of time, it can be evaluated *ahead* of now, which is where the fallback rainfall forecast comes from when Open-Meteo is unreachable.

---

## 7. What is deliberately not here

- **No SMS gateway.** Messages are generated; nothing sends them. That is a credential, not an engineering problem, and faking it would repeat the 2024 mistake.
- **No database for assessments.** The event log is in-memory and bounded at 200 entries. Persisting it is a schema decision that depends on deployment, and inventing one would be speculative.
- **No streaming.** Outputs are small structured objects; streaming would add complexity for no user benefit.
- **No React rewrite.** The 2024 Express + EJS app works. Replacing it would have been churn dressed as progress, and would have destroyed the before/after comparison that makes this repository worth reading.
- **The admin page's "Resolved" button still does not persist.** It removes the card from the DOM and a refresh brings it back — a 2024 limitation, left visible. Fixing it means deciding how submission state is stored, which is the same deployment-dependent schema decision as above. It is listed here rather than silently half-fixed.

The scope rule throughout: fix what is broken *and* in the way (the shared-session bug, the `onValue` crash, the dead dependencies), leave what is merely unfinished, and never quietly rework something without saying so. The 2024 project's real failure was not that it was incomplete — it was that it described itself as complete.
