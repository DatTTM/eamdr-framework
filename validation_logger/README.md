# Reference Implementation

This directory contains the reference implementation used to generate the execution traces analyzed in the manuscript.

## Files

### validation_logger.js

Research-oriented event logger used in the RehabReach prototype.

It records:

- raw biomechanical features (u)
- adaptive equilibrium estimates (μ)
- dynamic noise estimates (σ)
- standardized motor deviations (x)
- context-gating decisions
- intent transitions
- representative execution events

The logger is intended for computational validation and reproducibility rather than production deployment.
