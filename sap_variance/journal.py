"""Confirmation journals exported from ByDesign with signed quantities.

Each row is one stock posting: ``Effective Qty`` is negative where stock left a
logistics area and positive where it arrived. Only ``Production Confirmation``
rows are consumption and output; ``Goods and Activity`` and ``Warehouse``
confirmations move stock between areas (e.g. store -> line, line -> store).

This module decides each material's role (input or output) from those signs,
picks out the confirmations that belong to one job when a file holds several,
and checks batch movements against consumption.
"""

from __future__ import annotations

import pandas as pd

from .config import Settings


def is_signed(j: pd.DataFrame) -> bool:
    return "doc_type" in j.columns and j["doc_type"].notna().any()


def apply_signed_roles(j: pd.DataFrame, settings: Settings) -> pd.DataFrame:
    """Set is_prod, dir, qty (consumed/produced, positive) and is_reversal."""
    doc = j["doc_type"].fillna("").astype(str).str.lower()
    is_prod = doc.eq("") | doc.map(lambda d: any(k in d for k in settings.production_doc_keywords))
    j["is_prod"] = is_prod.values
    q = j["quantity"].astype(float).fillna(0.0)
    net = q[is_prod].groupby([j.loc[is_prod, "order_id"], j.loc[is_prod, "material_id"]]).sum()
    role = [("in" if net.get((o, m), 0) < 0 else "out") if p else None
            for o, m, p in zip(j["order_id"], j["material_id"], is_prod)]
    j["dir"] = role
    j["qty"] = [(-v if r == "in" else v) if r else v for v, r in zip(q, role)]
    j["is_reversal"] = [(r == "in" and v > 0) or (r == "out" and v < 0) for v, r in zip(q, role)]
    return j


def cancelled_confirmations(lines: pd.DataFrame) -> set:
    """Confirmations that were reversed in full by a later one, and those reversals.

    A reversal posts every line of the original again with the opposite sign.
    """
    if "confirmation_id" not in lines.columns or lines["confirmation_id"].isna().all():
        return set()
    sig = {}
    for conf, rows in lines[lines["kind"] != "movement"].groupby("confirmation_id"):
        sig[conf] = frozenset((m, b, round(float(q), 3)) for m, b, q in
                              zip(rows["material_id"], rows["batch"].fillna(""), rows["quantity"].fillna(0)))
    by_sig: dict = {}
    for conf, key in sig.items():
        by_sig.setdefault(key, []).append(conf)
    out = set()
    for conf, key in sig.items():
        if conf in out:
            continue
        negated = frozenset((m, b, -q) for m, b, q in key)
        partner = next((c for c in by_sig.get(negated, []) if c not in out and c != conf), None)
        if partner is not None:
            out.update({conf, partner})
    return out


def _when(ts) -> str:
    return pd.Timestamp(ts).strftime("%d.%m %H:%M") if ts is not None and not pd.isna(ts) else "?"


def _conf_label(rows: pd.DataFrame) -> str:
    locs = ", ".join(sorted(set(rows["location"].dropna())))
    return f"{rows['confirmation_id'].iat[0]} ({_when(rows['date'].min())}{', ' + locs if locs else ''})"


def select_job(lines: pd.DataFrame, fg: str | None, settings: Settings) -> tuple[pd.DataFrame, dict]:
    """Keep the confirmations that belong to this order's finished product.

    A journal pulled for one order can still contain other products' postings.
    Kept: every confirmation that outputs the FG, plus confirmations with no
    output on the same line within ``unmatched_window_minutes`` of the job.
    """
    info: dict = {"other_outputs": {}, "no_output_confs": [], "fg_found": True}
    prod = lines[lines["kind"] != "movement"]
    if prod.empty or "confirmation_id" not in prod.columns or prod["confirmation_id"].isna().all():
        return lines, info

    def outputs(df):
        return df[df["dir"] == "out"]

    others = prod[prod["kind"] == "other_output"]
    fg_confs = set(prod.loc[prod["kind"] == "fg", "confirmation_id"].dropna())
    keep = prod
    if fg and not fg_confs and not others.empty:
        info["fg_found"] = False
    if fg_confs and not others.empty:
        fg_rows = prod[prod["confirmation_id"].isin(fg_confs)]
        job_locs = set(fg_rows.loc[fg_rows["dir"] == "in", "location"].dropna())
        window = pd.Timedelta(minutes=settings.unmatched_window_minutes)
        start, end = fg_rows["date"].min() - window, fg_rows["date"].max() + window
        keep_confs = set(fg_confs)
        for conf, rows in prod.groupby("confirmation_id"):
            if conf in keep_confs or not outputs(rows).empty:
                continue
            same_line = bool(set(rows["location"].dropna()) & job_locs) if job_locs else True
            t = rows["date"].min()
            in_window = pd.isna(t) or pd.isna(start) or (start <= t <= end)
            if same_line and in_window:
                keep_confs.add(conf)
        keep = prod[prod["confirmation_id"].isin(keep_confs)]
        dropped = prod[~prod["confirmation_id"].isin(keep_confs)]
        for mat, rows in outputs(dropped).groupby("material_id"):
            info["other_outputs"][mat] = (float(rows["qty"].sum()), rows["confirmation_id"].nunique(),
                                          ", ".join(sorted(set(rows["location"].dropna()) | set())))
    cancelled = cancelled_confirmations(keep)
    for conf, rows in keep.groupby("confirmation_id"):
        if conf in cancelled:
            continue
        # Cheese/starch issued to the line on their own is normal; anything else with no output is not
        raw_only = rows["kind"].isin(["cheese", "starch", "offcut"]).all()
        if outputs(rows).empty and not rows[rows["dir"] == "in"].empty and not raw_only:
            info["no_output_confs"].append(_conf_label(rows))

    materials = set(keep["material_id"])
    moves = lines[(lines["kind"] == "movement") & lines["material_id"].isin(materials)]
    return pd.concat([keep, moves]).sort_index(), info


def movement_checks(job: pd.DataFrame, file_lines: pd.DataFrame, settings: Settings) -> list[tuple]:
    """Batch-level checks using every posting in the file (stock is shared between jobs).

    Returns (severity, code, message, kg) tuples.
    """
    out: list[tuple] = []
    if "location" not in file_lines.columns or file_lines["location"].isna().all():
        return out
    job_in = job[(job["kind"] != "movement") & (job["dir"] == "in")]
    if job_in.empty:
        return out
    batches = {(m, b): k for m, b, k in zip(job_in["material_id"], job_in["batch"], job_in["kind"]) if b}
    prod_locs = set(file_lines.loc[file_lines["kind"] != "movement", "location"].dropna())
    ts = file_lines.assign(signed=file_lines["quantity"].astype(float).fillna(0.0))

    for (mat, batch), kind in sorted(batches.items()):
        cheese = kind == "cheese"
        rows = ts[(ts["material_id"] == mat) & (ts["batch"] == batch)]
        what = f"batch {batch} of {mat}" + (" (cheese)" if cheese else "")

        # Same batch consumed on two lines at overlapping times
        used = rows[(rows["kind"] != "movement") & (rows["signed"] < 0) & rows["location"].notna()]
        spans = {loc: (g["date"].min(), g["date"].max(), -g["signed"].sum()) for loc, g in used.groupby("location")}
        if len(spans) > 1:
            locs = sorted(spans, key=lambda l: spans[l][0])
            overlap = any(spans[a][0] <= spans[b][1] and spans[b][0] <= spans[a][1]
                          for i, a in enumerate(locs) for b in locs[i + 1:])
            if overlap:
                detail = "; ".join(f"{l}: {spans[l][2]:,.2f} from {_when(spans[l][0])} to {_when(spans[l][1])}" for l in locs)
                out.append(("HIGH" if cheese else "LOW", "BATCH_ON_TWO_LINES",
                            f"{what} was consumed on {len(locs)} lines at the same time ({detail}). "
                            f"One pallet/roll can only be on one line - postings were probably made against "
                            f"the batch SAP showed rather than the one physically used.", None))

        for loc, g in rows[rows["location"].isin(prod_locs)].groupby("location"):
            g = g.sort_values(["date", "signed"], ascending=[True, False])
            moves = g[g["kind"] == "movement"]
            # Consumed on a line before SAP shows it arriving there
            balance, first_short = 0.0, None
            for d, v, k in zip(g["date"], g["signed"], g["kind"]):
                balance += v
                if balance < -0.5 and first_short is None and k != "movement":
                    first_short = (d, balance)
            if first_short is not None:
                later = moves[(moves["signed"] > 0) & (moves["date"] > first_short[0])]
                if not later.empty:
                    out.append(("MEDIUM" if cheese else "LOW", "USED_BEFORE_ARRIVAL",
                                f"{what} was consumed on {loc} from {_when(first_short[0])} but was only moved to "
                                f"{loc} at {_when(later['date'].iat[0])} ({later['signed'].iat[0]:,.2f}). "
                                f"Check which batch was physically on the line.", None))
            # Moved to the line but neither consumed nor returned
            moved_in = moves.loc[moves["signed"] > 0, "signed"].sum()
            moved_out = abs(moves.loc[moves["signed"] < 0, "signed"].sum())
            consumed = -g.loc[g["kind"] != "movement", "signed"].sum() + 0.0
            left = moved_in - consumed - moved_out
            if moved_in > 0 and left > max(1.0, 0.01 * moved_in):
                code = "LEFTOVER_NOT_RETURNED" if cheese else "LEFT_ON_LINE"
                out.append(("HIGH" if cheese else "LOW", code,
                            f"{what}: {moved_in:,.2f} moved to {loc}, {consumed:,.2f} consumed, {moved_out:,.2f} "
                            f"returned - {left:,.2f} still on {loc} in SAP at the end of this journal.",
                            left if cheese else None))
    return out
