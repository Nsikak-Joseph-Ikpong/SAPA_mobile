"""Per-order cheese balance, rule checks, and cross-order / cross-file checks.

Sign convention: variance = cheese issued - (expected cheese + offcuts).
Positive = more cheese booked than the output explains (over-issued).
Negative = output with no cheese behind it (under-issued / missed issue).
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass, field

import numpy as np
import pandas as pd

from .config import Settings
from .journal import apply_signed_roles, cancelled_confirmations, is_signed, movement_checks, select_job
from .loader import Dataset, is_blank
from .products import ProductCatalog

SEVERITY_ORDER = {"HIGH": 0, "MEDIUM": 1, "LOW": 2, "INFO": 3}


@dataclass
class Flag:
    order_id: str
    severity: str
    code: str
    message: str
    kg: float | None = None
    related_orders: str = ""


@dataclass
class OrderResult:
    order_id: str
    metrics: dict
    components: pd.DataFrame
    flags: list[Flag] = field(default_factory=list)

    def flag(self, severity: str, code: str, message: str, kg: float | None = None, related: str = ""):
        self.flags.append(Flag(self.order_id, severity, code, message, kg, related))


@dataclass
class Analysis:
    results: dict[str, OrderResult]
    requested: list[str]
    missing: list[str]
    swaps: pd.DataFrame
    batches: pd.DataFrame
    tables: pd.DataFrame
    settings: Settings

    @property
    def flags(self) -> list[Flag]:
        out = [f for oid in self.requested if oid in self.results for f in self.results[oid].flags]
        return sorted(out, key=lambda f: (SEVERITY_ORDER[f.severity], f.order_id))


def _num(value) -> float | None:
    if is_blank(value):
        return None
    value = float(value)
    return None if math.isnan(value) else value


def fmt_kg(value: float | None, signed: bool = False) -> str:
    if value is None or (isinstance(value, float) and math.isnan(value)):
        return "n/a"
    return f"{value:+,.1f} kg" if signed else f"{value:,.1f} kg"


def fmt_qty(value: float | None) -> str:
    if value is None:
        return "n/a"
    return f"{value:,.0f}" if float(value).is_integer() else f"{value:,.2f}"


# ---------------------------------------------------------------- order headers

HEADER_FIELDS = ["date", "material_id", "material_desc", "status", "planned_qty",
                 "fulfilled_qty", "open_qty", "output_kg", "issued_kg", "line"]
CONFLICT_FIELDS = ["material_id", "planned_qty", "fulfilled_qty", "open_qty", "status"]


def merge_headers(orders: pd.DataFrame) -> tuple[dict[str, dict], dict[str, list[str]]]:
    """Combine header rows for the same order from every file.

    Returns merged headers and, per order, a list of conflicts between sources.
    """
    headers: dict[str, dict] = {}
    conflicts: dict[str, list[str]] = {}
    if orders.empty:
        return headers, conflicts
    for oid, group in orders.groupby("order_id", sort=False):
        merged: dict = {"sources": sorted(set(group["_source"]))}
        for fld in HEADER_FIELDS:
            if fld not in group.columns:
                continue
            values = [v for v in group[fld] if not is_blank(v)]
            merged[fld] = values[0] if values else None
            if fld in CONFLICT_FIELDS:
                distinct = {}
                for v, src in zip(group[fld], group["_source"]):
                    if is_blank(v):
                        continue
                    key = round(float(v), 3) if isinstance(v, (int, float)) else str(v).strip().lower()
                    distinct.setdefault(key, (v, src))
                if len(distinct) > 1:
                    shown = "; ".join(f"{fmt_qty(v) if isinstance(v, (int, float)) else v} in {src}"
                                      for v, src in distinct.values())
                    conflicts.setdefault(oid, []).append(f"{fld}: {shown}")
        headers[oid] = merged
    return headers, conflicts


# ---------------------------------------------------------------- journal lines

def _direction(value) -> str | None:
    if is_blank(value):
        return None
    v = str(value).lower()
    if any(w in v for w in ("output", "receipt", "produc", "yield", "by-product", "byproduct")):
        return "out"
    if any(w in v for w in ("input", "consum", "issue", "component")):
        return "in"
    return None


def classify_material(material_id: str, desc: str | None, fg_material: str | None,
                      catalog: ProductCatalog, settings: Settings) -> str:
    override = catalog.component_type(material_id)
    if override:
        for kind in ("cheese", "offcut", "starch", "packaging", "fg"):
            if kind in override:
                return kind
        if "finished" in override:
            return "fg"
        return "other"
    if fg_material and material_id == fg_material:
        return "fg"
    text = f"{material_id} {desc or ''}".lower()
    if any(k in text for k in settings.offcut_keywords):
        return "offcut"
    if any(k in text for k in settings.starch_keywords) or \
            any(material_id.upper().startswith(p.upper()) for p in settings.starch_id_prefixes):
        return "starch"
    if any(material_id.upper().startswith(p.upper()) for p in settings.packaging_id_prefixes):
        return "packaging"
    words = set(re.findall(r"[a-z]+", text))
    for k in settings.packaging_keywords:
        # Short keywords ("box", "bag") must be whole words; long ones ("basefilm") may be embedded
        if k in words or f"{k}s" in words or (len(k) >= 6 and k in text):
            return "packaging"
    if any(material_id.upper().startswith(p.upper()) for p in settings.cheese_id_prefixes):
        return "cheese"
    if desc and any(k in desc.lower() for k in settings.cheese_keywords):
        return "cheese"
    return "other"


def prepare_journal(journal: pd.DataFrame, headers: dict[str, dict], catalog: ProductCatalog,
                    settings: Settings) -> pd.DataFrame:
    if journal.empty:
        return journal
    j = journal.copy()
    for col in ("material_desc", "batch", "direction", "reversal", "uom", "date", "line",
                "doc_type", "location", "confirmation_id"):
        if col not in j.columns:
            j[col] = None
    j["reversal"] = j["reversal"].fillna(False).astype(bool)

    qty = j["quantity"].astype(float)
    qty = np.where(j["reversal"] & (qty > 0), -qty, qty)
    uom = j["uom"].fillna("").astype(str).str.strip().str.lower()
    qty = np.where(uom.isin(["g", "gram", "grams"]), qty / 1000, qty)
    qty = np.where(uom.isin(["t", "to", "ton", "tonne", "tonnes"]), qty * 1000, qty)
    j["qty"] = qty
    j["is_reversal"] = j["reversal"] | (j["quantity"].astype(float) < 0)
    j["dir"] = [_direction(v) for v in j["direction"]]
    j["is_prod"] = True
    if is_signed(j):
        j = apply_signed_roles(j, settings)

    kinds = []
    for oid, mid, desc, direction, prod in zip(j["order_id"], j["material_id"], j["material_desc"],
                                               j["dir"], j["is_prod"]):
        if not prod:
            kinds.append("movement")   # stock moved between areas, not consumed or produced
            continue
        fg = headers.get(oid, {}).get("material_id")
        kind = classify_material(mid, desc or catalog.description(mid), fg, catalog, settings)
        if kind == "cheese" and direction == "out":
            kind = "offcut"        # cheese coming back off the line
        elif kind == "offcut" and direction == "in":
            kind = "cheese"        # offcuts fed back in as rework
        elif kind == "other" and direction == "out":
            kind = "other_output" if fg else "fg"
        kinds.append(kind)
    j["kind"] = kinds
    return j


# ---------------------------------------------------------------- per-order rules

def _lines_used(lines: pd.DataFrame) -> str | None:
    """Production line(s) where this job consumed materials."""
    if lines.empty:
        return None
    for col in ("line", "location"):
        if col in lines.columns:
            used = lines.loc[lines["dir"] != "out", col].dropna() if "dir" in lines.columns else lines[col].dropna()
            if not used.empty:
                return ", ".join(sorted(set(map(str, used))))
    return None


def analyse_order(oid: str, header: dict, lines: pd.DataFrame, conflicts: list[str],
                  catalog: ProductCatalog, settings: Settings, journal_loaded: bool) -> OrderResult:
    s = settings
    fg = header.get("material_id")
    pending: list[tuple] = []   # flags worked out before the result object exists
    if not fg and not lines.empty:
        outs = sorted(set(lines.loc[lines["kind"] == "fg", "material_id"]))
        if len(outs) == 1:
            fg = outs[0]
        elif len(outs) > 1:
            lines = lines.assign(kind=lines["kind"].replace("fg", "other_output"))
            pending.append(("MEDIUM", "UNKNOWN_PRODUCT",
                            f"The journal outputs {len(outs)} products ({', '.join(outs)}) and no order list says "
                            f"which is this order's. Load the order list (or a product master) so the right "
                            f"confirmations can be picked out.", None))
    info = catalog.get(fg) if fg else None

    file_lines = lines
    if not lines.empty and is_signed(lines) and lines["confirmation_id"].notna().any():
        lines, job = select_job(lines, fg, s)
        if not job["fg_found"]:
            pending.append(("HIGH", "FG_NOT_IN_JOURNAL",
                            f"This order makes {fg}, but the journal has no output of {fg}. "
                            f"Either the wrong journal was loaded for this order or the export is incomplete.", None))
        if job["other_outputs"]:
            parts = [f"{m} ({q:,.2f} on {n} confirmation(s){', ' + loc if loc else ''})"
                     for m, (q, n, loc) in sorted(job["other_outputs"].items())]
            pending.append(("MEDIUM", "OTHER_PRODUCTS_IN_JOURNAL",
                            f"The journal also records output of {'; '.join(parts)}. It looks like it covers more "
                            f"than one job; only confirmations for {fg} (and unmatched ones on the same line) were "
                            f"used for this order.", None))
        if job["no_output_confs"]:
            n = len(job["no_output_confs"])
            pending.append(("MEDIUM", "CONFIRMATION_WITHOUT_OUTPUT",
                            f"{n} production confirmation(s) consumed materials but record no output: "
                            f"{'; '.join(job['no_output_confs'])}. The output may be missing from the export, "
                            f"or materials were booked without output.", None))
        pending.extend(movement_checks(lines, file_lines, s))
    movements = lines[lines["kind"] == "movement"] if not lines.empty else lines
    lines = lines[lines["kind"] != "movement"] if not lines.empty else lines

    planned = _num(header.get("planned_qty"))
    fulfilled = _num(header.get("fulfilled_qty"))
    open_qty = _num(header.get("open_qty"))
    status = header.get("status")

    cheese = lines[lines["kind"] == "cheese"] if not lines.empty else lines
    offcuts = lines[lines["kind"] == "offcut"] if not lines.empty else lines
    fg_lines = lines[lines["kind"] == "fg"] if not lines.empty else lines
    fg_journal = float(fg_lines["qty"].sum()) if not fg_lines.empty else None

    if fulfilled is None and fg_journal is not None:
        fulfilled = fg_journal

    pack = info.pack_kg if info else None
    output_kg = fulfilled * pack if (fulfilled is not None and pack) else _num(header.get("output_kg"))
    starch = info.starch_pct if info else 0.0
    expected = output_kg * (1 - starch) if output_kg is not None else None
    plan_expected = planned * pack * (1 - starch) if (planned and pack) else None

    if not cheese.empty:
        issued = float(cheese["qty"].sum())
    else:
        issued = _num(header.get("issued_kg"))
        if issued is None and not lines.empty:
            issued = 0.0
    offcut_kg = float(offcuts["qty"].sum()) if not offcuts.empty else 0.0

    variance = issued - expected - offcut_kg if (issued is not None and expected is not None) else None
    tolerance = max(s.tolerance_pct * expected, s.tolerance_kg) if expected is not None else None
    variance_pct = variance / expected if (variance is not None and expected) else None

    cheese_by_material = (cheese.groupby("material_id")["qty"].sum().to_dict() if not cheese.empty else {})

    # Balance against the output the journal itself confirms, when that differs from the order list
    journal_expected = fg_journal * pack * (1 - starch) if (fg_journal and pack) else None
    variance_journal = (issued - journal_expected - offcut_kg
                        if (issued is not None and journal_expected is not None) else None)

    # What each input says the output was, in cases
    boxes = lines[(lines["kind"] == "packaging") & lines["material_id"].map(
        lambda m: any(str(m).upper().startswith(p.upper()) for p in s.box_id_prefixes))] if not lines.empty else lines
    starch_lines = lines[lines["kind"] == "starch"] if not lines.empty else lines
    implied = {}
    if issued and pack:
        implied["cheese"] = (issued - offcut_kg) / (pack * (1 - starch))
    if not boxes.empty:
        implied["boxes"] = float(boxes["qty"].sum()) / s.boxes_per_case
    if not starch_lines.empty and pack and starch:
        implied["starch"] = float(starch_lines["qty"].sum()) / (pack * starch)
    if fg_journal is not None:
        implied["journal output"] = fg_journal
    if _num(header.get("fulfilled_qty")) is not None:
        implied["order list"] = _num(header.get("fulfilled_qty"))

    metrics = {
        "order_id": oid,
        "date": header.get("date") if header.get("date") is not None else
                (lines["date"].dropna().max() if not lines.empty and lines["date"].notna().any() else None),
        "fg_material": fg,
        "fg_description": info.description if info else header.get("material_desc"),
        "status": status,
        "line": header.get("line") or _lines_used(lines),
        "planned_qty": planned,
        "fulfilled_qty": fulfilled,
        "open_qty": open_qty,
        "fg_in_journal": fg_journal,
        "pack_kg": pack,
        "pack_source": info.pack_source if info else "unknown",
        "starch_pct": starch,
        "blend": "/".join(f"{p * 100:.0f}" for p in info.blend) if info and info.blend else None,
        "output_kg": output_kg,
        "expected_cheese_kg": expected,
        "expected_for_planned_kg": plan_expected,
        "cheese_issued_kg": issued,
        "offcuts_kg": offcut_kg,
        "variance_kg": variance,
        "variance_pct": variance_pct,
        "tolerance_kg": tolerance,
        "variance_vs_journal_output_kg": variance_journal,
        "cases_from_cheese": implied.get("cheese"),
        "cases_from_boxes": implied.get("boxes"),
        "cases_from_starch": implied.get("starch"),
        "cheese_materials": ", ".join(f"{m} {q:,.1f}kg" for m, q in cheese_by_material.items()),
        "journal_lines": len(lines),
        "sources": ", ".join(sorted(set(header.get("sources", []))
                                    | (set(lines["_source"]) if not lines.empty else set()))),
    }

    components = pd.DataFrame()
    if not lines.empty:
        components = (lines.assign(batch=lines["batch"].fillna("(no batch)"))
                      .groupby(["kind", "material_id", "batch"], dropna=False)
                      .agg(net_qty=("qty", "sum"), lines=("qty", "size"),
                           reversals=("is_reversal", "sum"), description=("material_desc", "first"))
                      .reset_index())
        components.insert(0, "order_id", oid)

    result = OrderResult(oid, metrics, components)
    for sev, code, msg, kg in pending:
        result.flag(sev, code, msg, kg)
    if not lines.empty and cheese.empty:
        result.flag("MEDIUM", "NO_CHEESE_IN_JOURNAL",
                    "No cheese found among this job's journal lines (cheese is recognised by material IDs "
                    f"starting {', '.join(s.cheese_id_prefixes)}, a cheese word in the description, or "
                    "Component Type = cheese in the product master). Either none was issued, the export is "
                    "cut off, or the cheese codes need adding to the product master.")

    # --- data completeness / cross-file ---
    for c in conflicts:
        result.flag("HIGH", "SOURCE_CONFLICT", f"Files disagree on this order - {c}")
    if not header:
        result.flag("LOW", "NO_ORDER_HEADER",
                    "Journal lines found but no order header (planned/fulfilled) in any loaded file.")
    if journal_loaded and lines.empty and header:
        result.flag("MEDIUM", "NO_JOURNAL_LINES",
                    "Order header found but no confirmation journal lines in any loaded file.")
    if fg and not pack and output_kg is None:
        result.flag("MEDIUM", "NO_PACK_WEIGHT",
                    f"Cannot work out kg per case for {fg} - add it to the product master (pack_kg).")
    if info and info.master_pack_kg and info.parsed_pack_kg and abs(info.master_pack_kg - info.parsed_pack_kg) > 0.01:
        result.flag("LOW", "PACK_WEIGHT_CONFLICT",
                    f"Product master says {info.master_pack_kg:g} kg/case but the description "
                    f"'{info.description}' implies {info.parsed_pack_kg:g} kg/case.")

    # --- quantities on the header ---
    if planned and fulfilled is not None:
        if (open_qty is not None and open_qty == 0 and fulfilled < planned * s.closed_short_ratio):
            result.flag("MEDIUM", "CLOSED_SHORT",
                        f"Only {fmt_qty(fulfilled)} of {fmt_qty(planned)} planned were confirmed "
                        f"({fulfilled / planned:.0%}) but open quantity is 0 - the rest was closed off. "
                        f"Check whether more was produced than confirmed.")
        if fulfilled > planned * s.over_produced_ratio:
            result.flag("LOW", "OVER_PRODUCED",
                        f"Fulfilled {fmt_qty(fulfilled)} vs planned {fmt_qty(planned)} "
                        f"({fulfilled / planned - 1:+.0%}).")
    if (open_qty == 0 and fulfilled and status
            and not any(cs in str(status).lower() for cs in s.closed_statuses)):
        result.flag("INFO", "NOT_CLOSED",
                    f"Nothing left open but status is still '{status}' - order has not been closed.")
    if (fg_journal is not None and fulfilled is not None and header.get("fulfilled_qty") is not None
            and fg_journal > 0 and abs(fg_journal - fulfilled) > max(1, 0.01 * fulfilled)
            and not (pack and abs(fg_journal - fulfilled * pack) <= max(1, 0.01 * fulfilled * pack))):
        result.flag("MEDIUM", "OUTPUT_MISMATCH",
                    f"Header says {fmt_qty(fulfilled)} fulfilled but the journal confirms "
                    f"{fmt_qty(fg_journal)} of {fg}.")

    # --- inputs that disagree about how much was made ---
    # Cheese alone against output is the cheese balance below; this needs boxes or starch as a second witness
    if len(implied) >= 2 and ("boxes" in implied or "starch" in implied):
        lo, hi = min(implied.values()), max(implied.values())
        if hi - lo > max(2, s.implied_output_tolerance * hi):
            shown = "; ".join(f"{k} {v:,.0f}" for k, v in implied.items())
            result.flag("HIGH" if hi - lo > 0.10 * hi else "MEDIUM", "INPUTS_DISAGREE",
                        f"Inputs and output tell different stories about how many cases were made: {shown}. "
                        f"Whichever is right, the others were booked wrongly.")

    # --- output confirmed without boxes ---
    if not boxes.empty and "confirmation_id" in lines.columns and lines["confirmation_id"].notna().any():
        no_box = []
        cancelled = cancelled_confirmations(lines) if is_signed(lines) else set()
        for conf, rows in lines.groupby("confirmation_id"):
            if conf in cancelled:
                continue
            cases = float(rows.loc[rows["kind"] == "fg", "qty"].sum())
            boxed = float(rows.loc[rows.index.isin(boxes.index), "qty"].sum()) / s.boxes_per_case
            if cases > 0 and cases - boxed > max(1, 0.02 * cases):
                no_box.append((conf, rows["date"].min(), cases - boxed))
        if no_box:
            total = sum(n for _, _, n in no_box)
            listed = "; ".join(f"{c} ({pd.Timestamp(d).strftime('%d.%m %H:%M') if d is not None and not pd.isna(d) else '?'}, "
                               f"{fmt_qty(n)} cases)" for c, d, n in no_box)
            result.flag("HIGH" if total > 0.1 * max(fg_journal or 0, 1) else "MEDIUM", "OUTPUT_WITHOUT_BOXES",
                        f"{fmt_qty(total)} cases were confirmed as output without boxes booked: {listed}. "
                        f"Either those cases were never made, or their packaging (and possibly starch) "
                        f"was never confirmed.")

    # --- cheese balance ---
    matches_journal = (variance is not None and variance_journal is not None and fg_journal != fulfilled
                       and abs(variance) > tolerance
                       and abs(variance_journal) <= max(s.tolerance_pct * journal_expected, s.tolerance_kg))
    if matches_journal:
        result.flag("HIGH", "CHEESE_MATCHES_JOURNAL_NOT_ORDER",
                    f"Cheese issued ({fmt_kg(issued)}) matches the {fmt_qty(fg_journal)} cases the journal confirms "
                    f"({fmt_kg(journal_expected)} expected, {fmt_kg(variance_journal, signed=True)}), not the "
                    f"{fmt_qty(fulfilled)} in the order list ({fmt_kg(variance, signed=True)}). The cheese is "
                    f"probably not missing: check whether {fmt_qty(fg_journal)} cases physically exist and why the "
                    f"order shows {fmt_qty(fulfilled)}.", kg=variance)
    elif variance is not None and expected:
        detail = (f"Issued {fmt_kg(issued)} vs expected {fmt_kg(expected)} "
                  f"({fmt_qty(fulfilled)} x {pack:g} kg" if pack else
                  f"Issued {fmt_kg(issued)} vs expected {fmt_kg(expected)} (")
        detail += f", less {starch:.1%} starch)" + (f" + offcuts {fmt_kg(offcut_kg)}" if offcut_kg else "")
        big = abs(variance) > max(s.high_severity_multiple * tolerance, s.high_severity_kg)
        sev = "HIGH" if big else "MEDIUM"

        if issued <= s.no_issue_ratio * expected:
            result.flag("HIGH", "NO_CHEESE_ISSUED",
                        f"Output completed with almost no cheese issued. {detail}. "
                        f"About {fmt_kg(expected - issued)} of cheese is missing from the books.",
                        kg=variance)
        elif variance < -tolerance:
            result.flag(sev, "CHEESE_UNDER_ISSUED",
                        f"{fmt_kg(-variance)} less cheese issued than the output needs ({variance_pct:+.1%}). "
                        f"{detail}. Likely a missed issue or cheese confirmed against another order.",
                        kg=variance)
        elif variance > tolerance:
            msg = (f"{fmt_kg(variance)} more cheese issued than the output explains ({variance_pct:+.1%}). "
                   f"{detail}.")
            if (plan_expected and fulfilled is not None and planned and fulfilled < planned * s.closed_short_ratio
                    and abs(issued - plan_expected) <= max(s.tolerance_pct * plan_expected, s.tolerance_kg)):
                result.flag("HIGH", "ISSUED_TO_PLAN",
                            f"Cheese issued ({fmt_kg(issued)}) matches the PLANNED quantity "
                            f"({fmt_qty(planned)} cases = {fmt_kg(plan_expected)}), not the "
                            f"{fmt_qty(fulfilled)} actually confirmed. Either output was under-confirmed, "
                            f"or about {fmt_kg(variance)} of leftover cheese was never returned to stores.",
                            kg=variance)
            else:
                result.flag(sev, "CHEESE_OVER_ISSUED",
                            msg + " Possible leftover not returned, unrecorded offcuts, "
                                  "or another order's cheese confirmed here.", kg=variance)

    # --- blend composition ---
    if info and info.blend and issued and issued > 0 and expected:
        present = {m: q for m, q in cheese_by_material.items() if q > 1}
        if len(present) < len(info.blend):
            ratio = "/".join(f"{p * 100:.0f}" for p in info.blend)
            result.flag("HIGH", "HALF_ISSUED_BLEND",
                        f"{ratio} blend but only {len(present)} cheese material(s) issued "
                        f"({', '.join(present) or 'none'}). The other component "
                        f"(~{fmt_kg(max(expected - issued, 0))}) looks to be missing.",
                        kg=variance)
        else:
            shares = sorted((q / issued for q in present.values()), reverse=True)[:len(info.blend)]
            worst = max(abs(a - b) for a, b in zip(shares, info.blend))
            if worst > s.blend_share_tolerance:
                actual = "/".join(f"{x * 100:.0f}" for x in shares)
                target = "/".join(f"{p * 100:.0f}" for p in info.blend)
                result.flag("MEDIUM", "BLEND_RATIO_OFF",
                            f"Cheese issued in a {actual} split, recipe is {target}. "
                            f"({metrics['cheese_materials']})")

    # --- batch level ---
    if not cheese.empty:
        by_batch = cheese.groupby(["material_id", "batch"], dropna=False)["qty"].sum()
        for (mid, batch), q in by_batch.items():
            if q < -0.5:
                result.flag("MEDIUM", "NEGATIVE_BATCH",
                            f"Batch {batch or '(none)'} of {mid} nets to {fmt_kg(q)} on this order - "
                            f"more was reversed than issued.", kg=q)
        rev = cheese[cheese["is_reversal"]]
        if not rev.empty:
            rev_batches = sorted({str(b) for b in rev["batch"].dropna()})
            final_batches = sorted({str(b) for b, q in by_batch.groupby(level=1).sum().items() if q > 0.5})
            result.flag("INFO", "REVERSALS",
                        f"{len(rev)} cheese confirmation(s) reversed ({fmt_kg(float(rev['qty'].sum()))}) "
                        f"on batch(es) {', '.join(rev_batches) or '(none)'}; final batches: "
                        f"{', '.join(final_batches) or '(none)'}.")
    if offcut_kg and issued and offcut_kg > s.offcut_max_ratio * issued:
        result.flag("LOW", "HIGH_OFFCUTS",
                    f"Offcuts {fmt_kg(offcut_kg)} are {offcut_kg / issued:.0%} of cheese issued.")
    if journal_loaded is False and issued is None:
        result.flag("INFO", "NO_CONSUMPTION_DATA",
                    "No journal loaded, so cheese consumption could not be checked for this order.")
    return result


# ---------------------------------------------------------------- cross-order checks

def match_swaps(results: dict[str, OrderResult], lines: pd.DataFrame, settings: Settings) -> pd.DataFrame:
    """Pair over-issued with under-issued orders that share a cheese material.

    One order's cheese confirmed against another order shows up as a
    positive variance on one and a roughly equal negative on the other.
    """
    cols = ["order_a", "order_b", "variance_a_kg", "variance_b_kg", "net_kg", "residual",
            "days_apart", "shared_materials", "shared_batches"]
    cands = []
    for oid, r in results.items():
        m = r.metrics
        if m["variance_kg"] is None or m["tolerance_kg"] is None or abs(m["variance_kg"]) <= m["tolerance_kg"]:
            continue
        mats, batches = set(), set()
        if not lines.empty:
            ol = lines[(lines["order_id"] == oid) & (lines["kind"] == "cheese")]
            mats = set(ol["material_id"].dropna())
            batches = set(ol["batch"].dropna())
        cands.append((oid, m["variance_kg"], m["date"], mats, batches, m["fg_material"]))
    pos = [c for c in cands if c[1] > 0]
    neg = [c for c in cands if c[1] < 0]
    if not pos or not neg:
        return pd.DataFrame(columns=cols)

    big = 1e6
    cost = np.full((len(pos), len(neg)), big)
    info = {}
    for i, a in enumerate(pos):
        for k, b in enumerate(neg):
            shared = a[3] & b[3]
            # An order with no cheese issued shares no material; fall back to same FG product
            if not shared and not (a[5] and a[5] == b[5]):
                continue
            days = None
            if a[2] is not None and b[2] is not None and not pd.isna(a[2]) and not pd.isna(b[2]):
                days = abs((pd.Timestamp(a[2]) - pd.Timestamp(b[2])).days)
                if days > settings.swap_window_days:
                    continue
            residual = abs(a[1] + b[1]) / max(abs(a[1]), abs(b[1]))
            if residual > settings.swap_max_residual:
                continue
            shared_batches = a[4] & b[4]
            cost[i, k] = residual + 0.02 * (days or 0) - (0.1 if shared_batches else 0)
            info[(i, k)] = (days, shared, shared_batches, residual)

    try:
        from scipy.optimize import linear_sum_assignment
        rows, cols_idx = linear_sum_assignment(cost)
        pairs = list(zip(rows, cols_idx))
    except ImportError:  # greedy fallback
        pairs, used_i, used_k = [], set(), set()
        for (i, k) in sorted(info, key=lambda ik: cost[ik]):
            if i not in used_i and k not in used_k:
                pairs.append((i, k)); used_i.add(i); used_k.add(k)

    out = []
    for i, k in pairs:
        if cost[i, k] >= big:
            continue
        days, shared, shared_batches, residual = info[(i, k)]
        a, b = pos[i], neg[k]
        out.append({
            "order_a": a[0], "order_b": b[0], "variance_a_kg": a[1], "variance_b_kg": b[1],
            "net_kg": a[1] + b[1], "residual": residual, "days_apart": days,
            "shared_materials": ", ".join(sorted(shared)) or f"same product {a[5]}",
            "shared_batches": ", ".join(sorted(shared_batches)),
        })
    return pd.DataFrame(out, columns=cols).sort_values("residual") if out else pd.DataFrame(columns=cols)


def batch_usage(lines: pd.DataFrame) -> pd.DataFrame:
    cols = ["material_id", "batch", "orders", "order_count", "net_kg", "reversals", "first_date", "last_date"]
    if lines.empty:
        return pd.DataFrame(columns=cols)
    cheese = lines[(lines["kind"] == "cheese") & lines["batch"].notna()]
    if cheese.empty:
        return pd.DataFrame(columns=cols)
    g = cheese.groupby(["material_id", "batch"])
    out = g.agg(orders=("order_id", lambda s: ", ".join(sorted(set(s)))),
                order_count=("order_id", "nunique"), net_kg=("qty", "sum"),
                reversals=("is_reversal", "sum"),
                first_date=("date", "min"), last_date=("date", "max")).reset_index()
    return out.sort_values(["order_count", "net_kg"], ascending=[False, False])[cols]


# ---------------------------------------------------------------- entry point

def all_order_ids(dataset: Dataset) -> list[str]:
    ids: list[str] = []
    for df in (dataset.orders, dataset.journal):
        if not df.empty and "order_id" in df.columns:
            ids.extend(i for i in df["order_id"].dropna() if i not in ids)
    return ids


def analyse(dataset: Dataset, settings: Settings, order_ids: list[str] | None = None) -> Analysis:
    orders = dataset.orders
    headers, conflicts = merge_headers(orders)

    descriptions: dict[str, str] = {}
    for df in (dataset.products, orders, dataset.journal):
        if not df.empty and "material_desc" in df.columns:
            for mid, desc in zip(df["material_id"], df["material_desc"]):
                if mid and desc and mid not in descriptions:
                    descriptions[mid] = desc
    catalog = ProductCatalog(dataset.products, descriptions, settings)

    journal = prepare_journal(dataset.journal, headers, catalog, settings)
    journal_loaded = not journal.empty

    # Every order is analysed so cross-order checks can find partners outside the request
    every = all_order_ids(dataset)
    results: dict[str, OrderResult] = {}
    for oid in every:
        lines = journal[journal["order_id"] == oid] if journal_loaded else pd.DataFrame()
        results[oid] = analyse_order(oid, headers.get(oid, {}), lines, conflicts.get(oid, []),
                                     catalog, settings, journal_loaded)

    swaps = match_swaps(results, journal, settings)
    for row in swaps.itertuples():
        for me, other, mine, theirs in ((row.order_a, row.order_b, row.variance_a_kg, row.variance_b_kg),
                                        (row.order_b, row.order_a, row.variance_b_kg, row.variance_a_kg)):
            when = f", {row.days_apart} day(s) apart" if row.days_apart is not None and not pd.isna(row.days_apart) else ""
            batches = f", shared batch(es) {row.shared_batches}" if row.shared_batches else ""
            results[me].flag(
                "HIGH", "CROSS_ORDER_SWAP",
                f"This order is {fmt_kg(mine, signed=True)} and order {other} is {fmt_kg(theirs, signed=True)} "
                f"on {row.shared_materials}{when}{batches}. They nearly cancel (net {fmt_kg(row.net_kg, signed=True)}) "
                f"- cheese was probably confirmed against the wrong order.",
                kg=mine, related=other)

    batches = batch_usage(journal)
    for row in batches.itertuples():
        if row.net_kg < -0.5 and row.order_count > 1:
            for oid in row.orders.split(", "):
                results[oid].flag("MEDIUM", "BATCH_NEGATIVE_OVERALL",
                                  f"Across all loaded orders, batch {row.batch} of {row.material_id} nets to "
                                  f"{fmt_kg(row.net_kg)} (orders {row.orders}).", related=row.orders)

    requested = every if not order_ids else [o.upper() for o in order_ids]
    missing = [o for o in requested if o not in results]

    tables = pd.DataFrame([{
        "file": t.source, "sheet": t.sheet, "detected_as": t.kind, "header_row": t.header_row,
        "order": (t.df["order_id"].dropna().iat[0] if t.order_source not in ("", "column") and not t.df.empty
                  else ""),
        "order_from": t.order_source,
        "rows": len(t.df), "columns_recognised": ", ".join(f"{k} <- '{v}'" for k, v in t.mapping.items()),
    } for t in dataset.tables])

    return Analysis(results, [o for o in requested if o in results], missing, swaps, batches, tables, settings)
