# Self-Heal Hardening Rollout Runbook

## Scope

This runbook covers safe rollout and rollback for self-heal hardening features:

- Structured patch mode
- Full rewrite fallback policy
- Patch-size guardrails
- Self-heal observability checks

## Environment Flags

- `SELF_HEAL_STRUCTURED_PATCH`
  - `1`: enable structured patch mode (recommended)
  - `0`: disable structured patch mode
- `SELF_HEAL_ALLOW_FULL_REWRITE_FALLBACK`
  - `1`: fallback to full rewrite if structured patch fails
  - `0`: fail self-heal attempt instead of full rewrite fallback
- `SELF_HEAL_MAX_PATCH_OPS`
  - max operation count accepted from model
- `SELF_HEAL_MAX_PATCH_TEXT`
  - max text payload for `find/replace/insert/pattern`
- `SELF_HEAL_MAX_CHANGED_LINES`
  - cap for patch diff line count
- `SELF_HEAL_MAX_BYTES_DELTA`
  - cap for bytes changed in spec

## Recommended Rollout

### Stage 1 (canary / low risk)

- `SELF_HEAL_STRUCTURED_PATCH=1`
- `SELF_HEAL_ALLOW_FULL_REWRITE_FALLBACK=1`
- Keep current guardrail defaults.

Monitor:

- Self-heal attempt success rate
- Structured fallback reason frequency
- Rerun pass rate after self-heal

Duration:

- 24-72 hours or at least 50+ healing attempts.

### Stage 2 (hardening mode)

If Stage 1 is stable, switch:

- `SELF_HEAL_ALLOW_FULL_REWRITE_FALLBACK=0`

This enforces structured-only healing behavior.

Monitor for:

- sudden increase in failed healing attempts
- drop in mean time to green

### Stage 3 (tighten policy)

If needed, tighten:

- `SELF_HEAL_MAX_PATCH_OPS` from `8` to `6`
- `SELF_HEAL_MAX_PATCH_TEXT` from `8000` to `6000`

Only tighten one knob at a time.

## Rollback

If self-heal regressions appear:

1. Immediate rollback:
   - `SELF_HEAL_ALLOW_FULL_REWRITE_FALLBACK=1`
2. If needed:
   - `SELF_HEAL_STRUCTURED_PATCH=0`
3. Redeploy and verify:
   - new runs complete
   - no queue growth on self-heal jobs

## Incident Checks

When self-heal incidents occur, capture:

- `attemptId`, `runId`
- mode (`structured` / `full-rewrite`)
- `structuredFallbackReason`
- operation count/types (if structured)
- final validation failure reason

## Invariants

- Never disable patch validation guardrails.
- Never allow tokens/secrets in telemetry/logs.
- Prefer deterministic fixes over broad rewrite behavior.
