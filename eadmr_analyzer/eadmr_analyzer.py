#!/usr/bin/env python3
"""
eadmr_analyzer.py

Offline batch analysis pipeline for the RehabReach EAMDR framework.

Reads one or many RehabReach session JSON logs (as produced by
validation_logger.js) and generates a full set of publication-quality
figures (300 dpi PNG) and CSV summary tables for use in a scientific
manuscript. Input files are never modified -- this tool is read-only.

Usage:
    python3 eadmr_analyzer.py                          # scan the script's own folder
    python3 eadmr_analyzer.py --input session.json      # single session
    python3 eadmr_analyzer.py --input /path/to/folder   # batch of sessions
    python3 eadmr_analyzer.py --input /path --output out/

Outputs (written to --output, default "<input>/results"):
    Figure1_IntentSpace.png        Continuous intent space (u/x, pinch vs grasp)
    Figure2_Timeline_<session>.png Per-session synchronized timeline
    Figure3_StateTransitions.png   Pooled intent transition diagram
    Figure4_Distributions.png      Pooled distributions of core signals
    Figure5_Tracking.png           Tracking quality across sessions
    Figure6_ActivationHeatmap.png  2D activation density in intent space
    Figure7_ThresholdOverlay_<session>.png  Threshold-crossing overlay
    Figure8_ClinicalDuration.png   Pinch/grasp gesture duration distributions
    Table1_SessionSummary.csv
    Table2_ClinicalMetrics.csv
    Table3_MotorIntentStatistics.csv
    Table4_TransitionMatrix.csv
    Table5_ContextAcceptanceRate.csv (only if CONTEXT_ACCEPTED/REJECTED events exist)
    Table6_Layer3Summary.csv (only if the log contains the 'eadmr' debug block;
                               support statistics only -- deliberately NOT a figure)
    summary.txt

Dependencies: pandas, numpy, matplotlib, networkx
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
import pandas as pd

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import FancyArrowPatch

try:
    import networkx as nx
except ImportError:  # pragma: no cover
    nx = None

DPI = 300
INTENT_COLORS = {
    "neutral": "#8C8C8C",
    "open": "#3B6EA5",
    "pinch": "#C0392B",
    "grasp": "#2E8B57",
    "transition": "#B8860B",
}
DEFAULT_COLOR = "#5B4B8A"
MIN_N_FOR_FIGURE = 3

plt.rcParams.update({
    "figure.dpi": 100,
    "savefig.dpi": DPI,
    "font.size": 10,
    "axes.titlesize": 11,
    "axes.labelsize": 10,
})


# --------------------------------------------------------------------------
# Small helpers
# --------------------------------------------------------------------------

def dget(d: Any, path: str, default: Any = None) -> Any:
    """Safe dotted-path getter: dget(event, 'thresholds.pinchGrab')."""
    cur = d
    for part in path.split("."):
        if isinstance(cur, dict) and part in cur:
            cur = cur[part]
        else:
            return default
    return cur


def parse_iso(ts: Any) -> Optional[datetime]:
    if not isinstance(ts, str):
        return None
    try:
        return datetime.fromisoformat(ts.replace("Z", "+00:00"))
    except ValueError:
        return None


def safe_color(intent: Any) -> str:
    return INTENT_COLORS.get(intent, DEFAULT_COLOR)


# --------------------------------------------------------------------------
# Data model
# --------------------------------------------------------------------------

@dataclass
class SessionData:
    tag: str                       # short label used in filenames / legends
    source_file: str
    raw: Dict[str, Any]
    events: pd.DataFrame           # one row per eventHistory entry
    duration_sec: Optional[float]
    warnings: List[str] = field(default_factory=list)


# --------------------------------------------------------------------------
# Loading & parsing
# --------------------------------------------------------------------------

def find_json_files(input_path: Path) -> List[Path]:
    if input_path.is_file():
        return [input_path]
    if input_path.is_dir():
        return sorted(p for p in input_path.glob("*.json") if p.is_file())
    return []


def load_session(path: Path) -> Tuple[Optional[Dict[str, Any]], List[str]]:
    warnings: List[str] = []
    try:
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, json.JSONDecodeError) as exc:
        return None, [f"Could not read/parse {path.name}: {exc}"]
    if not isinstance(data, dict):
        return None, [f"{path.name}: top-level JSON is not an object, skipped."]
    return data, warnings


EVENT_NUMERIC_FIELDS = ["u_pinch", "u_grasp", "x_pinch", "x_grasp", "activation"]
EVENT_THRESHOLD_FIELDS = [
    "thresholds.pinchGrab", "thresholds.pinchRelease",
    "thresholds.graspGrab", "thresholds.graspRelease",
    "thresholds.modulatedGraspThreshold",
]
# New in schema v5: per-event Layer-3 debug snapshot (added after the
# quiescent-detection fix). Older logs simply won't have this key -> NaN/None.
# Read directly in build_event_dataframe as eadmr_velocity, eadmr_stableFrames,
# eadmr_sigma_pinch, eadmr_sigma_grasp, eadmr_quiescent, eadmr_baselineUpdated.


def build_event_dataframe(raw: Dict[str, Any], tag: str, source_file: str) -> pd.DataFrame:
    rows = []
    for ev in raw.get("eventHistory", []) or []:
        if not isinstance(ev, dict):
            continue
        row: Dict[str, Any] = {
            "session_tag": tag,
            "source_file": source_file,
            "timestamp": ev.get("timestamp"),
            "event": ev.get("event"),
            "taskId": ev.get("taskId"),
            "hand": ev.get("hand"),
            "intent": ev.get("intent"),
            "game": dget(ev, "context.game"),
        }
        for f_ in EVENT_NUMERIC_FIELDS:
            row[f_] = ev.get(f_)
        for f_ in EVENT_THRESHOLD_FIELDS:
            row[f_.split(".")[-1]] = dget(ev, f_)
        row["eadmr_velocity"] = dget(ev, "eadmr.velocity")
        row["eadmr_stableFrames"] = dget(ev, "eadmr.stableFrames")
        row["eadmr_sigma_pinch"] = dget(ev, "eadmr.noiseLevel.pinch")
        row["eadmr_sigma_grasp"] = dget(ev, "eadmr.noiseLevel.grasp")
        row["eadmr_quiescent"] = dget(ev, "eadmr.quiescent")
        row["eadmr_baselineUpdated"] = dget(ev, "eadmr.baselineUpdated")
        rows.append(row)
    df = pd.DataFrame(rows)
    if not df.empty:
        df["timestamp"] = pd.to_numeric(df["timestamp"], errors="coerce")
        for f_ in EVENT_NUMERIC_FIELDS:
            if f_ in df.columns:
                df[f_] = pd.to_numeric(df[f_], errors="coerce")
        for f_ in ["eadmr_velocity", "eadmr_stableFrames", "eadmr_sigma_pinch", "eadmr_sigma_grasp"]:
            if f_ in df.columns:
                df[f_] = pd.to_numeric(df[f_], errors="coerce")
        df = df.sort_values("timestamp").reset_index(drop=True)
    return df


def compute_duration(raw: Dict[str, Any], events: pd.DataFrame) -> Optional[float]:
    start = parse_iso(raw.get("startTime"))
    end = parse_iso(raw.get("endTime"))
    if start is not None and end is not None:
        return (end - start).total_seconds()
    if not events.empty and events["timestamp"].notna().any():
        return float(events["timestamp"].max() - events["timestamp"].min())
    return None


def load_all_sessions(json_paths: List[Path]) -> List[SessionData]:
    sessions: List[SessionData] = []
    for i, path in enumerate(json_paths, start=1):
        raw, warnings = load_session(path)
        if raw is None:
            print(f"[skip] {path.name}: {warnings}")
            continue
        tag = path.stem
        events = build_event_dataframe(raw, tag, path.name)
        duration = compute_duration(raw, events)
        sd = SessionData(tag=tag, source_file=path.name, raw=raw, events=events,
                          duration_sec=duration, warnings=warnings)
        if events.empty:
            sd.warnings.append("No eventHistory entries found; figures/tables for this session will be limited.")
        sessions.append(sd)
    return sessions


# --------------------------------------------------------------------------
# Table builders
# --------------------------------------------------------------------------

def build_table1_session_summary(sessions: List[SessionData]) -> pd.DataFrame:
    rows = []
    for sd in sessions:
        raw = sd.raw
        summary = raw.get("summaryStatistics", {}) or {}
        stats = raw.get("stats", {}) or {}
        meta = raw.get("metadata", {}) or {}
        games = sorted(g for g in sd.events["game"].dropna().unique()) if not sd.events.empty else []
        rows.append({
            "session_tag": sd.tag,
            "source_file": sd.source_file,
            "sessionId": raw.get("sessionId"),
            "games": ",".join(games) if games else np.nan,
            "duration_sec": sd.duration_sec,
            "sourceFPS": meta.get("sourceFPS"),
            "n_events": len(sd.events),
            "tracking_uptime_percent": summary.get("tracking_uptime_percent", stats.get("trackedFrames") and
                                                     (100.0 * stats.get("trackedFrames", 0) / stats.get("activeFrames", 1)
                                                      if stats.get("activeFrames") else np.nan)),
            "trackingLostEvents": stats.get("trackingLostEvents"),
            "trackingRecoveredEvents": stats.get("trackingRecoveredEvents"),
            "pinchCount": stats.get("pinchCount"),
            "graspCount": stats.get("graspCount"),
            "rapidTransitions": stats.get("rapidTransitions"),
            "completedGames": stats.get("completedGames"),
            "totalGames": stats.get("totalGames"),
            "successRateTotal_percent": stats.get("successRateTotal"),
            "execution_success_rate_percent": summary.get("execution_success_rate_percent"),
            "number_of_accepted_actions": summary.get("number_of_accepted_actions"),
            "number_of_rejected_actions": summary.get("number_of_rejected_actions"),
        })
    return pd.DataFrame(rows)


def build_table2_clinical_metrics(sessions: List[SessionData]) -> pd.DataFrame:
    rows = []
    for sd in sessions:
        clinical = sd.raw.get("clinicalStats", {}) or {}
        summary = sd.raw.get("summaryStatistics", {}) or {}
        durations = clinical.get("clinicalGestureDurations", {}) or {}
        pinch_durs = [v for v in durations.get("pinch", []) if isinstance(v, (int, float))]
        grasp_durs = [v for v in durations.get("grasp", []) if isinstance(v, (int, float))]
        activation = sd.events["activation"].dropna() if "activation" in sd.events.columns else pd.Series(dtype=float)
        rows.append({
            "session_tag": sd.tag,
            "clinicalPinchCount": clinical.get("clinicalPinchCount"),
            "clinicalGraspCount": clinical.get("clinicalGraspCount"),
            "mean_pinch_duration_sec": float(np.mean(pinch_durs)) if pinch_durs else np.nan,
            "median_pinch_duration_sec": float(np.median(pinch_durs)) if pinch_durs else np.nan,
            "std_pinch_duration_sec": float(np.std(pinch_durs, ddof=1)) if len(pinch_durs) > 1 else np.nan,
            "n_pinch_durations": len(pinch_durs),
            "mean_grasp_duration_sec": float(np.mean(grasp_durs)) if grasp_durs else np.nan,
            "median_grasp_duration_sec": float(np.median(grasp_durs)) if grasp_durs else np.nan,
            "std_grasp_duration_sec": float(np.std(grasp_durs, ddof=1)) if len(grasp_durs) > 1 else np.nan,
            "n_grasp_durations": len(grasp_durs),
            "peak_activation": float(activation.max()) if len(activation) else np.nan,
            "activation_variance": float(activation.var(ddof=1)) if len(activation) > 1 else np.nan,
            "tracking_uptime_percent": summary.get("tracking_uptime_percent"),
        })
    return pd.DataFrame(rows)


def build_table3_motor_intent_statistics(sessions: List[SessionData]) -> pd.DataFrame:
    rows = []
    cols = ["u_pinch", "u_grasp", "x_pinch", "x_grasp"]
    for sd in sessions:
        row = {"session_tag": sd.tag}
        for c in cols:
            series = sd.events[c].dropna() if c in sd.events.columns else pd.Series(dtype=float)
            row[f"{c}_mean"] = float(series.mean()) if len(series) else np.nan
            row[f"{c}_sd"] = float(series.std(ddof=1)) if len(series) > 1 else np.nan
            row[f"{c}_n"] = len(series)
        rows.append(row)

    all_events = pd.concat([sd.events for sd in sessions if not sd.events.empty], ignore_index=True) \
        if any(not sd.events.empty for sd in sessions) else pd.DataFrame()
    if not all_events.empty:
        pooled = {"session_tag": "ALL_SESSIONS_POOLED"}
        for c in cols:
            series = all_events[c].dropna() if c in all_events.columns else pd.Series(dtype=float)
            pooled[f"{c}_mean"] = float(series.mean()) if len(series) else np.nan
            pooled[f"{c}_sd"] = float(series.std(ddof=1)) if len(series) > 1 else np.nan
            pooled[f"{c}_n"] = len(series)
        rows.append(pooled)

    return pd.DataFrame(rows)


def build_transition_matrix(all_events: pd.DataFrame) -> pd.DataFrame:
    if all_events.empty or "intent" not in all_events.columns:
        return pd.DataFrame()
    states = sorted(s for s in all_events["intent"].dropna().unique())
    matrix = pd.DataFrame(0, index=states, columns=states, dtype=int)
    for _, grp in all_events.groupby("session_tag"):
        grp = grp.sort_values("timestamp")
        intents = grp["intent"].tolist()
        for a, b in zip(intents[:-1], intents[1:]):
            if a in matrix.index and b in matrix.columns:
                matrix.loc[a, b] += 1
    matrix.index.name = "From"
    matrix.columns.name = "To"
    return matrix


def build_table5_context_acceptance(all_events: pd.DataFrame) -> pd.DataFrame:
    """Context Acceptance Rate: how often the downstream game logic accepted
    vs rejected a candidate action, per session and per game. Built purely
    from measured CONTEXT_ACCEPTED / CONTEXT_REJECTED events -- these are
    only present in logs that emit them, so sessions/games without such
    events simply do not contribute rows (never fabricated as zero)."""
    if all_events.empty or "event" not in all_events.columns:
        return pd.DataFrame()
    ctx = all_events[all_events["event"].isin(["CONTEXT_ACCEPTED", "CONTEXT_REJECTED"])]
    if ctx.empty:
        return pd.DataFrame()

    rows = []
    group_cols = ["session_tag", "game"] if "game" in ctx.columns else ["session_tag"]
    for key, grp in ctx.groupby(group_cols, dropna=False):
        key = key if isinstance(key, tuple) else (key,)
        n_accepted = int((grp["event"] == "CONTEXT_ACCEPTED").sum())
        n_rejected = int((grp["event"] == "CONTEXT_REJECTED").sum())
        total = n_accepted + n_rejected
        row = dict(zip(group_cols, key))
        row.update({
            "n_context_accepted": n_accepted,
            "n_context_rejected": n_rejected,
            "n_context_events_total": total,
            "acceptance_rate_percent": round(100.0 * n_accepted / total, 2) if total else np.nan,
        })
        rows.append(row)
    return pd.DataFrame(rows)


def build_table6_layer3_summary(sessions: List[SessionData]) -> pd.DataFrame:
    """Layer-3 support statistics: a compact, non-visual summary confirming
    the adaptive-equilibrium mechanism operated normally throughout each
    session (baseline update count, mean noise floor, tracking uptime).
    This intentionally does NOT get a dedicated figure -- Layer 3 is a
    supporting mechanism, not a claim the manuscript needs to visualize on
    its own; a compact table is sufficient evidence that it ran as expected.
    Only sessions whose logs actually contain the 'eadmr' debug block
    contribute a row (older logs without it are silently skipped, never
    filled with fabricated zeros)."""
    rows = []
    for sd in sessions:
        df = sd.events
        has_eadmr = any(
            c in df.columns and df[c].notna().any()
            for c in ("eadmr_baselineUpdated", "eadmr_sigma_pinch", "eadmr_sigma_grasp")
        ) if not df.empty else False
        if not has_eadmr:
            continue

        n_updates = int(df["eadmr_baselineUpdated"].fillna(False).astype(bool).sum()) \
            if "eadmr_baselineUpdated" in df.columns else np.nan
        mean_sigma_pinch = float(df["eadmr_sigma_pinch"].dropna().mean()) \
            if "eadmr_sigma_pinch" in df.columns and df["eadmr_sigma_pinch"].notna().any() else np.nan
        mean_sigma_grasp = float(df["eadmr_sigma_grasp"].dropna().mean()) \
            if "eadmr_sigma_grasp" in df.columns and df["eadmr_sigma_grasp"].notna().any() else np.nan
        mean_velocity = float(df["eadmr_velocity"].dropna().mean()) \
            if "eadmr_velocity" in df.columns and df["eadmr_velocity"].notna().any() else np.nan

        summary = sd.raw.get("summaryStatistics", {}) or {}
        rows.append({
            "session_tag": sd.tag,
            "n_baseline_updates": n_updates,
            "mean_sigma_pinch": round(mean_sigma_pinch, 4) if pd.notna(mean_sigma_pinch) else np.nan,
            "mean_sigma_grasp": round(mean_sigma_grasp, 4) if pd.notna(mean_sigma_grasp) else np.nan,
            "mean_velocity": round(mean_velocity, 5) if pd.notna(mean_velocity) else np.nan,
            "tracking_uptime_percent": summary.get("tracking_uptime_percent"),
        })
    return pd.DataFrame(rows)


# --------------------------------------------------------------------------
# Figure builders
# --------------------------------------------------------------------------

def fig1_intent_space(all_events: pd.DataFrame, outdir: Path) -> Optional[str]:
    if all_events.empty:
        return "Figure 1 skipped: no event data available across sessions."
    needed = ["u_pinch", "u_grasp", "x_pinch", "x_grasp"]
    if not all(c in all_events.columns for c in needed):
        return "Figure 1 skipped: u_pinch/u_grasp/x_pinch/x_grasp not found."
    df = all_events.dropna(subset=needed)
    if len(df) < MIN_N_FOR_FIGURE:
        return f"Figure 1 skipped: only {len(df)} fully paired observations."

    fig, axes = plt.subplots(1, 2, figsize=(12, 5.5))
    for ax, (xcol, ycol, title) in zip(
        axes,
        [("u_grasp", "u_pinch", "Raw Feature Space (u)"),
         ("x_grasp", "x_pinch", "Standardized Intent Space (x)")],
    ):
        for intent, grp in df.groupby("intent"):
            ax.scatter(grp[xcol], grp[ycol], s=14, alpha=0.6,
                       color=safe_color(intent), label=str(intent))
        ax.set_xlabel(xcol)
        ax.set_ylabel(ycol)
        ax.set_title(title)
        ax.axhline(0, color="gray", linewidth=0.6, linestyle=":")
        ax.axvline(0, color="gray", linewidth=0.6, linestyle=":")
    axes[0].legend(loc="upper right", fontsize=8, title="intent")
    fig.suptitle(f"Figure 1: Continuous Intent Space (N={len(df)} events, {df['session_tag'].nunique()} session(s))")
    fig.tight_layout()
    out = outdir / "Figure1_IntentSpace.png"
    fig.savefig(out, dpi=DPI, bbox_inches="tight")
    plt.close(fig)
    return f"Figure 1 written: {out.name} (N={len(df)} events pooled across {df['session_tag'].nunique()} session(s))"


def fig2_timeline(sd: SessionData, outdir: Path) -> Optional[str]:
    df = sd.events
    if df.empty or df["timestamp"].isna().all():
        return f"Figure 2 skipped for {sd.tag}: no timestamped events."

    fig, axes = plt.subplots(3, 1, figsize=(10, 6.5), sharex=True,
                              gridspec_kw={"height_ratios": [0.6, 1.6, 1]})

    # Row 1: intent color strip
    ax0 = axes[0]
    for i in range(len(df) - 1):
        ax0.axvspan(df["timestamp"].iloc[i], df["timestamp"].iloc[i + 1],
                    color=safe_color(df["intent"].iloc[i]), alpha=0.85)
    ax0.set_yticks([])
    ax0.set_ylabel("intent")
    ax0.set_title(f"Figure 2: Motor Intent Timeline -- {sd.tag}")

    # Row 2: x_pinch / x_grasp traces
    ax1 = axes[1]
    if "x_pinch" in df.columns:
        ax1.plot(df["timestamp"], df["x_pinch"], color=INTENT_COLORS["pinch"], marker="o",
                  markersize=2.5, linewidth=1.0, label="x_pinch")
    if "x_grasp" in df.columns:
        ax1.plot(df["timestamp"], df["x_grasp"], color=INTENT_COLORS["grasp"], marker="o",
                  markersize=2.5, linewidth=1.0, label="x_grasp")
    ax1.axhline(0, color="black", linewidth=0.6, linestyle=":")
    ax1.set_ylabel("x(t)\nstandardized")
    ax1.legend(loc="upper right", fontsize=8)

    # Row 3: discrete game / task events
    ax2 = axes[2]
    game_events = df[~df["event"].isin(["SESSION_STARTED", "SESSION_FINISHED"])]
    for _, r in game_events.iterrows():
        ax2.annotate(
            r["event"], xy=(r["timestamp"], 0.5), xytext=(0, 8),
            textcoords="offset points", rotation=90, fontsize=6, ha="center", va="bottom",
        )
    ax2.scatter(game_events["timestamp"], [0.5] * len(game_events), s=10, color="black")
    ax2.set_ylim(0, 1.6)
    ax2.set_yticks([])
    ax2.set_ylabel("events")
    ax2.set_xlabel("timestamp (measured, seconds)")

    fig.tight_layout()
    out = outdir / f"Figure2_Timeline_{sd.tag}.png"
    fig.savefig(out, dpi=DPI, bbox_inches="tight")
    plt.close(fig)
    return f"Figure 2 written: {out.name} (N={len(df)} events)"


def fig3_state_transitions(matrix: pd.DataFrame, outdir: Path) -> Optional[str]:
    if matrix.empty:
        return "Figure 3 skipped: no intent transitions found across sessions."
    if nx is None:
        return "Figure 3 skipped: networkx is not installed."

    total_transitions = int(matrix.values.sum())
    fig, axes = plt.subplots(1, 2, figsize=(13, 5.5))

    # Heatmap of the raw transition matrix
    ax0 = axes[0]
    im = ax0.imshow(matrix.values, cmap="Blues")
    ax0.set_xticks(range(len(matrix.columns)))
    ax0.set_xticklabels(matrix.columns, rotation=45, ha="right")
    ax0.set_yticks(range(len(matrix.index)))
    ax0.set_yticklabels(matrix.index)
    for i in range(matrix.shape[0]):
        for j in range(matrix.shape[1]):
            ax0.text(j, i, str(matrix.values[i, j]), ha="center", va="center", fontsize=8)
    ax0.set_xlabel("To")
    ax0.set_ylabel("From")
    ax0.set_title("Transition Matrix (counts)")
    fig.colorbar(im, ax=ax0, fraction=0.046)

    # Directed graph (self-loops excluded for clarity)
    ax1 = axes[1]
    G = nx.DiGraph()
    for s in matrix.index:
        G.add_node(s)
    for a in matrix.index:
        for b in matrix.columns:
            if a != b and matrix.loc[a, b] > 0:
                G.add_edge(a, b, weight=int(matrix.loc[a, b]))
    pos = nx.circular_layout(G)
    node_sizes = [300 + 40 * matrix.loc[n].sum() for n in G.nodes()]
    node_colors = [safe_color(n) for n in G.nodes()]
    nx.draw_networkx_nodes(G, pos, ax=ax1, node_size=node_sizes, node_color=node_colors, alpha=0.9)
    nx.draw_networkx_labels(G, pos, ax=ax1, font_size=8, font_color="white")
    weights = [G[u][v]["weight"] for u, v in G.edges()]
    max_w = max(weights) if weights else 1
    nx.draw_networkx_edges(
        G, pos, ax=ax1, width=[1 + 4 * w / max_w for w in weights],
        edge_color="#555555", alpha=0.7, arrows=True, arrowsize=14,
        connectionstyle="arc3,rad=0.12",
    )
    edge_labels = {(u, v): G[u][v]["weight"] for u, v in G.edges()}
    nx.draw_networkx_edge_labels(G, pos, ax=ax1, edge_labels=edge_labels, font_size=7)
    ax1.set_title("Directed Transition Graph (self-loops excluded)")
    ax1.axis("off")

    fig.suptitle(f"Figure 3: Intent State Transition Diagram (N={total_transitions} transitions, pooled)")
    fig.tight_layout()
    out = outdir / "Figure3_StateTransitions.png"
    fig.savefig(out, dpi=DPI, bbox_inches="tight")
    plt.close(fig)
    return f"Figure 3 written: {out.name} (N={total_transitions} transitions pooled across sessions)"


def fig4_distributions(all_events: pd.DataFrame, outdir: Path) -> Optional[str]:
    if all_events.empty:
        return "Figure 4 skipped: no event data available."
    cols = [c for c in ["u_pinch", "u_grasp", "x_pinch", "x_grasp", "activation"] if c in all_events.columns]
    cols = [c for c in cols if all_events[c].notna().sum() >= MIN_N_FOR_FIGURE]
    if not cols:
        return "Figure 4 skipped: none of u_pinch/u_grasp/x_pinch/x_grasp/activation had sufficient data."

    fig, axes = plt.subplots(1, len(cols), figsize=(3.6 * len(cols), 4.2))
    if len(cols) == 1:
        axes = [axes]
    for ax, c in zip(axes, cols):
        series = all_events[c].dropna()
        ax.hist(series, bins=min(25, max(6, len(series) // 3)), color=DEFAULT_COLOR, alpha=0.85, edgecolor="black")
        ax.axvline(series.mean(), color="red", linestyle="--", linewidth=1, label=f"mean={series.mean():.3f}")
        ax.set_title(c)
        ax.set_xlabel(c)
        ax.legend(fontsize=7)
    axes[0].set_ylabel("frequency (measured observations)")
    fig.suptitle(f"Figure 4: Distributions of Core Motor-Intent Signals (pooled, N up to {len(all_events)})")
    fig.tight_layout()
    out = outdir / "Figure4_Distributions.png"
    fig.savefig(out, dpi=DPI, bbox_inches="tight")
    plt.close(fig)
    return f"Figure 4 written: {out.name}"


def fig5_tracking(sessions: List[SessionData], table1: pd.DataFrame, outdir: Path) -> Optional[str]:
    df = table1.dropna(subset=["tracking_uptime_percent"]) if "tracking_uptime_percent" in table1.columns else pd.DataFrame()
    if df.empty:
        return "Figure 5 skipped: no tracking_uptime_percent available for any session."

    fig, axes = plt.subplots(1, 2, figsize=(12, 4.5))
    ax0 = axes[0]
    ax0.bar(df["session_tag"], df["tracking_uptime_percent"], color=DEFAULT_COLOR)
    ax0.set_ylabel("tracking uptime (%)")
    ax0.set_ylim(0, 105)
    ax0.set_title("Tracking Uptime per Session")
    ax0.tick_params(axis="x", rotation=45)

    ax1 = axes[1]
    lost = df["trackingLostEvents"].fillna(0) if "trackingLostEvents" in df.columns else pd.Series(0, index=df.index)
    recovered = df["trackingRecoveredEvents"].fillna(0) if "trackingRecoveredEvents" in df.columns else pd.Series(0, index=df.index)
    width = 0.35
    x = np.arange(len(df))
    ax1.bar(x - width / 2, lost, width, label="tracking lost", color="#C0392B")
    ax1.bar(x + width / 2, recovered, width, label="tracking recovered", color="#2E8B57")
    ax1.set_xticks(x)
    ax1.set_xticklabels(df["session_tag"], rotation=45, ha="right")
    ax1.set_ylabel("event count")
    ax1.set_title("Tracking Interruptions per Session")
    ax1.legend(fontsize=8)

    fig.suptitle(f"Figure 5: Tracking Quality Across {len(df)} Session(s)")
    fig.tight_layout()
    out = outdir / "Figure5_Tracking.png"
    fig.savefig(out, dpi=DPI, bbox_inches="tight")
    plt.close(fig)
    return f"Figure 5 written: {out.name} ({len(df)} session(s))"


def fig6_activation_heatmap(all_events: pd.DataFrame, outdir: Path) -> Optional[str]:
    if all_events.empty or not {"x_pinch", "x_grasp"}.issubset(all_events.columns):
        return "Figure 6 skipped: x_pinch/x_grasp not found."
    df = all_events.dropna(subset=["x_pinch", "x_grasp"])
    if len(df) < MIN_N_FOR_FIGURE:
        return f"Figure 6 skipped: only {len(df)} paired x_pinch/x_grasp observations."

    fig, ax = plt.subplots(figsize=(6.5, 5.5))
    h = ax.hist2d(df["x_grasp"], df["x_pinch"], bins=30, cmap="inferno")
    fig.colorbar(h[3], ax=ax, label="measured event density")
    ax.set_xlabel("x_grasp")
    ax.set_ylabel("x_pinch")
    ax.set_title(f"Figure 6: Intent Activation Heatmap (N={len(df)}, pooled)")
    fig.tight_layout()
    out = outdir / "Figure6_ActivationHeatmap.png"
    fig.savefig(out, dpi=DPI, bbox_inches="tight")
    plt.close(fig)
    return f"Figure 6 written: {out.name} (N={len(df)})"


def fig7_threshold_overlay(sd: SessionData, outdir: Path) -> Optional[str]:
    df = sd.events
    required = ["x_pinch", "pinchGrab", "pinchRelease"]
    if df.empty or not all(c in df.columns for c in required):
        return f"Figure 7 skipped for {sd.tag}: required threshold fields not found."
    d = df.dropna(subset=["timestamp", "x_pinch"])
    if len(d) < MIN_N_FOR_FIGURE:
        return f"Figure 7 skipped for {sd.tag}: insufficient paired observations."

    fig, ax = plt.subplots(figsize=(9, 4))
    ax.plot(d["timestamp"], d["x_pinch"], color=INTENT_COLORS["pinch"], linewidth=1.2, marker="o", markersize=2.5)
    if d["pinchGrab"].notna().any():
        ax.plot(d["timestamp"], d["pinchGrab"], color="gray", linestyle="--", linewidth=1.0, label="pinchGrab threshold")
    if d["pinchRelease"].notna().any():
        ax.plot(d["timestamp"], d["pinchRelease"], color="gray", linestyle=":", linewidth=1.0, label="pinchRelease threshold")
    above = d["x_pinch"] > d["pinchGrab"]
    ax.fill_between(d["timestamp"], d["x_pinch"], d["pinchGrab"], where=above, color=INTENT_COLORS["pinch"], alpha=0.15)
    ax.set_xlabel("timestamp (measured, seconds)")
    ax.set_ylabel("x_pinch")
    ax.set_title(f"Figure 7: Threshold Overlay -- {sd.tag}\n"
                 f"time above pinchGrab threshold: {d.loc[above, 'timestamp'].count()} of {len(d)} measured events")
    ax.legend(fontsize=8)
    fig.tight_layout()
    out = outdir / f"Figure7_ThresholdOverlay_{sd.tag}.png"
    fig.savefig(out, dpi=DPI, bbox_inches="tight")
    plt.close(fig)
    return f"Figure 7 written: {out.name}"


def fig8_clinical_duration(sessions: List[SessionData], outdir: Path) -> Optional[str]:
    pinch_all: List[float] = []
    grasp_all: List[float] = []
    for sd in sessions:
        durations = dget(sd.raw, "clinicalStats.clinicalGestureDurations", {}) or {}
        pinch_all.extend(v for v in durations.get("pinch", []) if isinstance(v, (int, float)))
        grasp_all.extend(v for v in durations.get("grasp", []) if isinstance(v, (int, float)))

    if len(pinch_all) < MIN_N_FOR_FIGURE and len(grasp_all) < MIN_N_FOR_FIGURE:
        return "Figure 8 skipped: not enough clinical gesture duration samples for pinch or grasp."

    fig, ax = plt.subplots(figsize=(6, 5))
    data, labels = [], []
    if len(pinch_all) >= MIN_N_FOR_FIGURE:
        data.append(pinch_all)
        labels.append(f"Pinch\n(N={len(pinch_all)})")
    if len(grasp_all) >= MIN_N_FOR_FIGURE:
        data.append(grasp_all)
        labels.append(f"Grasp\n(N={len(grasp_all)})")
    parts = ax.violinplot(data, showmeans=True, showmedians=True)
    ax.boxplot(data, widths=0.12)
    ax.set_xticks(range(1, len(labels) + 1))
    ax.set_xticklabels(labels)
    ax.set_ylabel("gesture duration (s, measured)")
    stats_txt = []
    if len(pinch_all) >= MIN_N_FOR_FIGURE:
        stats_txt.append(f"pinch: mean={np.mean(pinch_all):.2f}s, median={np.median(pinch_all):.2f}s, sd={np.std(pinch_all, ddof=1):.2f}s")
    if len(grasp_all) >= MIN_N_FOR_FIGURE:
        stats_txt.append(f"grasp: mean={np.mean(grasp_all):.2f}s, median={np.median(grasp_all):.2f}s, sd={np.std(grasp_all, ddof=1):.2f}s")
    ax.set_title("Figure 8: Clinical Gesture Duration Distribution (pooled)\n" + "\n".join(stats_txt), fontsize=9)
    fig.tight_layout()
    out = outdir / "Figure8_ClinicalDuration.png"
    fig.savefig(out, dpi=DPI, bbox_inches="tight")
    plt.close(fig)
    return f"Figure 8 written: {out.name}"


# --------------------------------------------------------------------------
# Orchestration
# --------------------------------------------------------------------------

def run(input_path: Path, output_path: Path) -> None:
    output_path.mkdir(parents=True, exist_ok=True)
    json_paths = find_json_files(input_path)
    log_lines: List[str] = []

    if not json_paths:
        log_lines.append(f"No .json files found at {input_path}. Nothing to analyze.")
        (output_path / "summary.txt").write_text("\n".join(log_lines), encoding="utf-8")
        print("\n".join(log_lines))
        return

    sessions = load_all_sessions(json_paths)
    log_lines.append(f"Input: {input_path}")
    log_lines.append(f"JSON files found: {len(json_paths)}")
    log_lines.append(f"Sessions successfully parsed: {len(sessions)}")
    for sd in sessions:
        n_ev = len(sd.events)
        dur = f"{sd.duration_sec:.2f}s" if sd.duration_sec is not None else "unknown"
        log_lines.append(f"  - {sd.source_file}: tag={sd.tag}, events={n_ev}, duration={dur}")
        for w in sd.warnings:
            log_lines.append(f"      warning: {w}")

    all_events = pd.concat([sd.events for sd in sessions if not sd.events.empty], ignore_index=True) \
        if any(not sd.events.empty for sd in sessions) else pd.DataFrame()

    # ---- Tables ----
    table1 = build_table1_session_summary(sessions)
    table2 = build_table2_clinical_metrics(sessions)
    table3 = build_table3_motor_intent_statistics(sessions)
    matrix = build_transition_matrix(all_events)
    table5 = build_table5_context_acceptance(all_events)
    table6 = build_table6_layer3_summary(sessions)

    table1.to_csv(output_path / "Table1_SessionSummary.csv", index=False)
    table2.to_csv(output_path / "Table2_ClinicalMetrics.csv", index=False)
    table3.to_csv(output_path / "Table3_MotorIntentStatistics.csv", index=False)
    if not matrix.empty:
        matrix.to_csv(output_path / "Table4_TransitionMatrix.csv")
    else:
        log_lines.append("Table 4 (transition matrix) skipped: no intent data found.")
    if not table5.empty:
        table5.to_csv(output_path / "Table5_ContextAcceptanceRate.csv", index=False)
    else:
        log_lines.append("Table 5 (context acceptance rate) skipped: no CONTEXT_ACCEPTED/CONTEXT_REJECTED events found.")
    if not table6.empty:
        table6.to_csv(output_path / "Table6_Layer3Summary.csv", index=False)
    else:
        log_lines.append("Table 6 (Layer-3 summary) skipped: no 'eadmr' debug block found in any session log.")

    log_lines.append("")
    log_lines.append("Tables written: Table1_SessionSummary.csv, Table2_ClinicalMetrics.csv, "
                      "Table3_MotorIntentStatistics.csv"
                      + (", Table4_TransitionMatrix.csv" if not matrix.empty else "")
                      + (", Table5_ContextAcceptanceRate.csv" if not table5.empty else "")
                      + (", Table6_Layer3Summary.csv" if not table6.empty else ""))

    # ---- Figures ----
    log_lines.append("")
    log_lines.append("Figure generation log:")
    log_lines.append("  " + (fig1_intent_space(all_events, output_path) or ""))
    for sd in sessions:
        log_lines.append("  " + (fig2_timeline(sd, output_path) or ""))
    log_lines.append("  " + (fig3_state_transitions(matrix, output_path) or ""))
    log_lines.append("  " + (fig4_distributions(all_events, output_path) or ""))
    log_lines.append("  " + (fig5_tracking(sessions, table1, output_path) or ""))
    log_lines.append("  " + (fig6_activation_heatmap(all_events, output_path) or ""))
    for sd in sessions:
        log_lines.append("  " + (fig7_threshold_overlay(sd, output_path) or ""))
    log_lines.append("  " + (fig8_clinical_duration(sessions, output_path) or ""))

    (output_path / "summary.txt").write_text("\n".join(log_lines), encoding="utf-8")
    print("\n".join(log_lines))
    print(f"\nAll outputs written to: {output_path.resolve()}")


def main() -> None:
    script_dir = Path(__file__).resolve().parent
    parser = argparse.ArgumentParser(description="EAMDR/RehabReach offline batch analyzer.")
    parser.add_argument("--input", type=str, default=None,
                         help="Session JSON file or folder of session JSON files. "
                              "Defaults to the folder containing this script.")
    parser.add_argument("--output", type=str, default=None,
                         help="Output folder for figures/tables. Defaults to <input_folder>/results.")
    args = parser.parse_args()

    input_path = Path(args.input).resolve() if args.input else script_dir
    if args.output:
        output_path = Path(args.output).resolve()
    else:
        base = input_path if input_path.is_dir() else input_path.parent
        output_path = base / "results"

    run(input_path, output_path)


if __name__ == "__main__":
    main()
