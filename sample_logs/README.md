# Sample Execution Logs

This directory contains representative execution traces used in the computational validation of the EAMDR framework.

## Included sessions

| File | Task | Primary interaction |
|------|------|---------------------|
| `balldrop.json` | BallDrop | Pinch-dominant |
| `stack.json` | Stack Blocks | Grasp-dominant |
| `fishhunt.json` | Fish Hunt | Mixed pinch–grasp |

Each log contains timestamped events together with:

- Raw biomechanical features (`u_pinch`, `u_grasp`)
- Adaptive equilibrium estimates
- Dynamic noise estimates
- Standardized intent coordinates (`x_pinch`, `x_grasp`)
- Intent transitions
- Context-gating decisions
- Task-specific thresholds

These logs correspond to the representative validation sessions reported in the accompanying manuscript.
