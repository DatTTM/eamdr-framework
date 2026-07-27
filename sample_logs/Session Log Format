# Session Log Format

## Structure

```json
{
  "loggerVersion": "1.2.0",
  "sessionId": "S_...",
  "startTime": "2026-07-19T00:38:05.535Z",
  "endTime":   "2026-07-19T00:39:11.320Z",
  "metadata":          { },
  "summaryStatistics": { },
  "stats":             { },
  "clinicalStats":     { },
  "eventHistory":      [ ]
}
```

## Key fields in each event

| Field | Description |
|-------|-------------|
| `timestamp` | Seconds since session start |
| `event` | Event type (see below) |
| `u_pinch`, `u_grasp` | Raw features, Layer 1 — range [0, 1] |
| `x_pinch`, `x_grasp` | EAMDR-normalized deviation, Layer 4 — units: SD |
| `activation` | Continuous intent activation, Layer 5 — range [0, 1] |
| `eamdr.quiescent` | True when hand at rest; equilibrium update eligible |
| `eamdr.baselineUpdated` | True when equilibrium estimate was updated this frame |
| `thresholds.pinchGrab` | Task-specific activation threshold τ (SD units) |
| `thresholds.modulatedGraspThreshold` | Context-gated grasp threshold |

## Event types

| Event | Meaning |
|-------|---------|
| `SESSION_STARTED` | Thresholds initialized |
| `TRACKING_STARTED` | First valid hand; equilibrium estimation begins |
| `CONTEXT_REJECTED` | Signal below threshold — action suppressed |
| `OBJECT_PICKED` | Pick intent confirmed |
| `OBJECT_RELEASED` | Release intent confirmed |
| `TASK_FAILED` / `TASK_SUCCESS` | Task outcome |

## Reproducing Figures 4 and 5

**Figure 4** — `sample_logs/fishhunt_2_4.json`, `t ≈ 46.820 s`
```
u_pinch = 0.592  →  x_pinch = 0.58 SD  <  τ = 1.20 SD  →  CONTEXT_REJECTED
```
Raw posture would trigger a conventional detector. EAMDR suppressed it.

**Figure 5** — `sample_logs/balldrop_2_4.json`, `t ≈ 9.121 s`
```
u_pinch = 0.303  →  x_pinch = 2.90 SD  >  τ = 1.16 SD  →  OBJECT_PICKED
```
Low absolute pinch accepted because equilibrium-normalized deviation
exceeded threshold.
