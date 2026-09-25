"""Check each production order against the confirmation journal of a ByDesign workbook.

The workbook holds (sheet names do not matter, sheets are recognised by headers):

* Production Order (OUT+IN)   - per order: status, line (Resource ID), output product,
                                every input with planned / fulfilled quantity
* Production order (output)   - per order: output and by-products (offcut bins),
                                planned / fulfilled, actual production start
* Production Order (INPUT)    - optional: units of measure per input
* Confirmation Journal        - every posting, with NO production order column
* Stock Overview              - optional: stock per logistics area and batch now

Because the journal has no order ID, bookings are tied to orders by product,
line and time:

* finished-goods output rows go to the latest order of that product that had
  started when the output was posted;
* cheese moved to an order's line during its run goes to that order (on a line
  shared by two orders, to the one whose next output follows soonest).

The journal export may contain only the receiving side of each posting (no
consumption rows). Cheese used is then taken as cheese moved to the line minus
cheese moved away from it again.
"""

from __future__ import annotations

import argparse
import math
import re
import sys
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

import pandas as pd

from .config import alias_key

SEVERITY_ORDER = {"HIGH": 0, "MEDIUM": 1, "LOW": 2, "INFO": 3}


@dataclass
class Rules:
    # Resource ID on the order -> logistics area the journal books that line to
    line_areas: dict = field(default_factory=lambda: {
        "SLICING_L1": "SL_1", "SLICING_L2": "SL_2", "SLICING_L3": "SL_3",
        "GRATING_L4": "GRATINGLINES", "GRATING_L5": "GRATINGLINES",
    })
    skip_resources: tuple = ("FLOOR_WASTE", "LINE_RECOVERY")
    cheese_prefixes: tuple = ("RM",)
    not_cheese_prefixes: tuple = ("RMPS",)          # potato starch
    offcut_pattern: str = r"^MB.*OFF$"               # offcut bins, cheese when used as input
    box_prefixes: tuple = ("BO",)
    lead_hours: float = 2.0          # cheese can arrive this long before the first posting
    tail_hours: float = 1.0          # ... and this long after the last regular output
    return_hours: float = 24.0       # cheese leaving the line this soon after arriving is a return
    order_start_slack_hours: float = 1.0
    max_order_age_hours: float = 72.0
    bulk_pallets: int = 4            # this many pallets in one confirmation = posted in bulk
    late_hours: float = 2.0          # output posted this long after the last regular output = late
    tolerance_pct: float = 0.05
    tolerance_kg: float = 50.0
    blend_tolerance: float = 0.08


# ---------------------------------------------------------------- reading the workbook

def _key(v) -> str:
    return alias_key(v) if v is not None and not (isinstance(v, float) and math.isnan(v)) else ""


SHEET_SIGNATURES = {
    "journal": {"confid", "effectiveqty"},
    "components": {"inputmaterialid", "resourceid"},
    "outputs": {"productionorderoutputproduct", "product", "productionstartdatetime"},
    "inputs": {"inputproduct", "operationid"},
    "stock": {"onhandstock", "logisticsarea"},
}


def _find_header(raw: pd.DataFrame) -> tuple[str | None, int]:
    for i in range(min(6, len(raw))):
        keys = {_key(v) for v in raw.iloc[i]}
        for kind, sig in SHEET_SIGNATURES.items():
            if sig <= keys:
                return kind, i
    return None, -1


def _frame(raw: pd.DataFrame, header_row: int) -> pd.DataFrame:
    """Headers by position; repeated names get .1, .2 suffixes."""
    names, seen = [], {}
    for v in raw.iloc[header_row]:
        k = _key(v) or "col"
        seen[k] = seen.get(k, -1) + 1
        names.append(k if seen[k] == 0 else f"{k}.{seen[k]}")
    df = raw.iloc[header_row + 1:].copy()
    df.columns = names
    return df.reset_index(drop=True)


def _num(s: pd.Series) -> pd.Series:
    if s.dtype == object:
        s = s.map(lambda v: re.sub(r"[^0-9.\-]", "", v.replace(",", "")) if isinstance(v, str) else v)
    return pd.to_numeric(s, errors="coerce")


def _time(s: pd.Series) -> pd.Series:
    txt = s.astype(str).str.replace(r"\s*GMT\w*$", "", regex=True).str.strip()
    out = pd.to_datetime(txt, format="%d.%m.%Y %H:%M:%S", errors="coerce")
    missing = out.isna() & s.notna()
    if missing.any():
        out[missing] = pd.to_datetime(s[missing], errors="coerce", dayfirst=True)
    return out


def _id(s: pd.Series) -> pd.Series:
    return s.map(lambda v: None if v is None or (isinstance(v, float) and math.isnan(v))
                 else str(int(v)) if isinstance(v, float) and v.is_integer() else str(v).strip())


@dataclass
class Workbook:
    orders: pd.DataFrame
    components: pd.DataFrame
    byproducts: pd.DataFrame
    journal: pd.DataFrame
    stock: pd.DataFrame
    sheets: dict


def read_workbook(paths: list[str]) -> Workbook:
    found: dict[str, pd.DataFrame] = {}
    names: dict[str, str] = {}
    for p in paths:
        path = Path(p)
        if path.suffix.lower() in (".csv", ".txt"):
            sheets = {path.name: pd.read_csv(path, header=None, dtype=object, sep=None, engine="python")}
        else:
            sheets = pd.read_excel(path, sheet_name=None, header=None, dtype=object)
        for name, raw in sheets.items():
            kind, row = _find_header(raw)
            if kind:
                df = _frame(raw, row)
                found[kind] = pd.concat([found[kind], df], ignore_index=True) if kind in found else df
                names[kind] = f"{path.name} [{name}]"
    missing = [k for k in ("journal", "components") if k not in found]
    if missing:
        raise ValueError("Could not find these sheets (by their column headers): " + ", ".join(missing))

    # --- inputs per order (OUT+IN sheet) ---
    c = found["components"]
    for col in ("productionorderid", "productionorderstatus", "outputproductid", "resourceid",
                "earlieststartdatetime", "requestedstartdatetime"):
        c[col] = c[col].ffill()
    comp = pd.DataFrame({
        "order_id": _id(c["productionorderid"]), "status": c["productionorderstatus"],
        "fg": c["outputproductid"].astype(str).str.strip(), "resource": c["resourceid"],
        "requested_start": _time(c["requestedstartdatetime"]),
        "material": c["inputmaterialid"].astype(str).str.strip(),
        "planned": _num(c["plannedquantity"]), "open": _num(c["openquantity"]),
        "fulfilled": _num(c["fulfilledquantity"]),
        "out_open": _num(c.get("openquantity.1")), "out_fulfilled": _num(c.get("fulfilledquantity.1")),
    })
    comp = comp[comp["order_id"].notna()]

    # --- outputs and by-products per order ---
    byp = pd.DataFrame(columns=["order_id", "material", "text", "planned", "fulfilled"])
    head = pd.DataFrame(columns=["order_id", "planned_out", "fulfilled_out", "start_actual", "latest_end", "fg_text"])
    if "outputs" in found:
        o = found["outputs"]
        for col in ("productionorder", "productionorderoutputproduct", "productionorderoutputproducttext"):
            o[col] = o[col].ffill()
        o = pd.DataFrame({
            "order_id": _id(o["productionorder"]), "fg": o["productionorderoutputproduct"].astype(str).str.strip(),
            "fg_text": o["productionorderoutputproducttext"], "material": o["product"].astype(str).str.strip(),
            "text": o["producttext"], "planned": _num(o["plannedquantity"]), "fulfilled": _num(o["fulfilledquantity"]),
            "start_actual": _time(o["productionstartdatetime"]), "latest_end": _time(o["productionorderlatestenddatetime"]),
        })
        main = o[o["material"] == o["fg"]]
        head = main.groupby("order_id").agg(planned_out=("planned", "sum"), fulfilled_out=("fulfilled", "sum"),
                                             start_actual=("start_actual", "min"), latest_end=("latest_end", "max"),
                                             fg_text=("fg_text", "first")).reset_index()
        byp = o[o["material"] != o["fg"]][["order_id", "material", "text", "planned", "fulfilled"]]

    orders = (comp.groupby("order_id", sort=False)
              .agg(status=("status", "first"), fg=("fg", "first"), resource=("resource", "first"),
                   requested_start=("requested_start", "first"), out_open=("out_open", "first"),
                   out_fulfilled=("out_fulfilled", "first"))
              .reset_index().merge(head, on="order_id", how="left"))
    orders["planned_out"] = orders["planned_out"].fillna(orders["out_open"] + orders["out_fulfilled"])
    orders["fulfilled_out"] = orders["fulfilled_out"].fillna(orders["out_fulfilled"])
    orders["start"] = orders["start_actual"].fillna(orders["requested_start"])

    # --- journal ---
    j = found["journal"]
    journal = pd.DataFrame({
        "site": j["site"], "material": j["product"].astype(str).str.strip(),
        "batch": _id(j[[c for c in j.columns if c.startswith("identifiedstock")][0]]),
        "area": j[[c for c in j.columns if c.startswith("logisticsarea")][0]].astype(str).str.strip(),
        "time": _time(j["createdon"]), "doc": j["confdocumenttype"].astype(str),
        "conf": _id(j["confid"]), "qty": _num(j["effectiveqty"]),
    }).dropna(subset=["time", "qty"])
    journal["is_prod"] = journal["doc"].str.contains("Production", case=False)

    # --- stock overview ---
    stock = pd.DataFrame(columns=["area", "material", "batch", "qty"])
    if "stock" in found:
        s = found["stock"]
        s = s[s["material"].astype(str) != "Result"]
        stock = pd.DataFrame({"area": s["logisticsarea"].astype(str), "material": s["material"].astype(str).str.strip(),
                              "batch": _id(s[[c for c in s.columns if c.startswith("identifiedstockidentifiedstockid")][0]]),
                              "qty": _num(s["onhandstock"])})
    return Workbook(orders, comp, byp, journal, stock, names)


# ---------------------------------------------------------------- matching

@dataclass
class Finding:
    order_id: str
    severity: str
    code: str
    message: str


def is_cheese(material: str, rules: Rules) -> bool:
    m = str(material).upper()
    if any(m.startswith(p) for p in rules.not_cheese_prefixes):
        return False
    return any(m.startswith(p) for p in rules.cheese_prefixes) or bool(re.match(rules.offcut_pattern, m))


def assign_outputs(wb: Workbook, rules: Rules) -> pd.DataFrame:
    """Finished-goods output postings, each tied to the order most likely to own it."""
    fgs = set(wb.orders["fg"])
    out = wb.journal[wb.journal["is_prod"] & wb.journal["material"].isin(fgs)].copy()
    out["order_id"] = None
    slack = pd.Timedelta(hours=rules.order_start_slack_hours)
    max_age = pd.Timedelta(hours=rules.max_order_age_hours)
    starts = {fg: g.dropna(subset=["start"]).sort_values("start")[["order_id", "start"]].values.tolist()
              for fg, g in wb.orders.groupby("fg")}
    assigned = []
    for fg, t in zip(out["material"], out["time"]):
        best = None
        for oid, start in starts.get(fg, []):
            if start <= t + slack:
                best = (oid, start)
            else:
                break
        assigned.append(best[0] if best and t - best[1] <= max_age else None)
    out["order_id"] = assigned
    return out


def order_windows(orders: pd.DataFrame, outputs: pd.DataFrame, rules: Rules) -> pd.DataFrame:
    """Per order: start, end of regular output, and whether output posted in bulk."""
    per_conf = (outputs[outputs["qty"] > 0].groupby(["order_id", "conf"])
                .agg(time=("time", "min"), pallets=("batch", "nunique"), cases=("qty", "sum")).reset_index())
    per_conf["bulk"] = per_conf["pallets"] >= rules.bulk_pallets
    regular = per_conf[~per_conf["bulk"]].groupby("order_id")["time"].agg(["min", "max"])
    anyout = per_conf.groupby("order_id")["time"].agg(["min", "max"])
    w = orders[["order_id", "start", "latest_end", "resource"]].set_index("order_id")
    w["first_out"] = regular["min"].reindex(w.index).fillna(anyout["min"].reindex(w.index))
    w["last_regular"] = regular["max"].reindex(w.index).fillna(anyout["max"].reindex(w.index))
    w["begin"] = w[["start", "first_out"]].min(axis=1) - pd.Timedelta(hours=rules.lead_hours)
    w["end"] = w["last_regular"].fillna(w["latest_end"]) + pd.Timedelta(hours=rules.tail_hours)
    w["area"] = w["resource"].map(rules.line_areas)
    return w.reset_index(), per_conf


def assign_cheese(wb: Workbook, windows: pd.DataFrame, outputs: pd.DataFrame, rules: Rules) -> pd.DataFrame:
    """Cheese moved to a line during an order's run; returns found by batch afterwards."""
    recipe = wb.components[wb.components["material"].map(lambda m: is_cheese(m, rules))]
    recipe_by_order = recipe.groupby("order_id")["material"].apply(set).to_dict()
    moves = wb.journal[(~wb.journal["is_prod"]) & (wb.journal["qty"] > 0)]
    arrivals = moves[moves["material"].map(lambda m: is_cheese(m, rules))
                     & moves["area"].isin(set(rules.line_areas.values()))]
    per_conf = (outputs[outputs["qty"] > 0].groupby(["order_id", "conf"])
                .agg(time=("time", "min"), pallets=("batch", "nunique")).reset_index())
    regular = per_conf[per_conf["pallets"] < rules.bulk_pallets]
    next_out = regular.sort_values("time").groupby("order_id")["time"].apply(list).to_dict()
    wins = windows.dropna(subset=["area", "begin", "end"])
    starts = dict(zip(windows["order_id"], windows["start"]))
    resources = dict(zip(windows["order_id"], windows["resource"]))
    rows = []
    for r in arrivals.itertuples():
        cands = wins[(wins["area"] == r.area) & (wins["begin"] <= r.time) & (wins["end"] >= r.time)]
        cands = [c for c in cands["order_id"] if r.material in recipe_by_order.get(c, set())]
        if not cands:
            continue
        def soonest(oid):
            later = [t for t in next_out.get(oid, []) if t >= r.time]
            return later[0] if later else pd.Timestamp.max
        # A job already running owns the cheese over the next job on the same line;
        # between jobs running side by side (L4 and L5 share GRATINGLINES), the next regular output decides.
        running = [c for c in cands if not pd.isna(starts.get(c)) and starts[c] <= r.time]
        if running:
            latest = {}
            for c in running:
                res = resources.get(c)
                if res not in latest or starts[c] > starts[latest[res]]:
                    latest[res] = c
            owner = min(latest.values(), key=soonest)
        else:
            owner = min(cands, key=lambda c: starts.get(c) if not pd.isna(starts.get(c)) else pd.Timestamp.max)
        rows.append({"order_id": owner, "material": r.material, "batch": r.batch, "area": r.area,
                     "time": r.time, "conf": r.conf, "sent": r.qty, "candidates": len(cands),
                     "other_orders": ", ".join(c for c in cands if c != owner)})
    sends = pd.DataFrame(rows, columns=["order_id", "material", "batch", "area", "time", "conf", "sent",
                                        "candidates", "other_orders"])
    if sends.empty:
        sends["returned"] = []
        sends["returned_to"] = []
        return sends
    # Returns: the same batch arriving somewhere else soon after, before it is sent to the line again
    by_batch = {k: g.sort_values("time") for k, g in moves[moves["batch"].isin(set(sends["batch"]))]
                .groupby(["material", "batch"])}
    returned, where = [], []
    for s in sends.itertuples():
        g = by_batch.get((s.material, s.batch))
        qty, dest = 0.0, []
        if g is not None:
            later = g[(g["time"] > s.time) & (g["time"] <= s.time + pd.Timedelta(hours=rules.return_hours))]
            for m in later.itertuples():
                if m.area == s.area:
                    break                      # sent to the line again
                if not m.area.startswith("#"):
                    qty += m.qty
                    dest.append(f"{m.qty:,.2f} to {m.area} ({m.time:%H:%M})")
        returned.append(min(qty, s.sent))
        where.append("; ".join(dest))
    sends["returned"] = returned
    sends["returned_to"] = where
    return sends


# ---------------------------------------------------------------- checks

def check_order(oid: str, wb: Workbook, windows: pd.DataFrame, outputs: pd.DataFrame, per_conf: pd.DataFrame,
                sends: pd.DataFrame, typical_pallet: dict, rules: Rules) -> tuple[dict, list[Finding]]:
    o = wb.orders[wb.orders["order_id"] == oid].iloc[0]
    comps = wb.components[wb.components["order_id"] == oid]
    w = windows[windows["order_id"] == oid].iloc[0]
    out = outputs[outputs["order_id"] == oid]
    confs = per_conf[per_conf["order_id"] == oid].sort_values("time")
    cheese = sends[sends["order_id"] == oid]
    findings: list[Finding] = []
    cheese_diff = cheese_tol = None

    def flag(sev, code, msg):
        findings.append(Finding(oid, sev, code, msg))

    fg = o["fg"]
    planned_out = o["planned_out"] if not pd.isna(o["planned_out"]) else None
    order_out = o["fulfilled_out"] if not pd.isna(o["fulfilled_out"]) else 0.0
    journal_out = float(out["qty"].sum()) if not out.empty else 0.0
    area = w["area"]

    # ---- output: journal vs order ----
    if not out.empty and abs(journal_out - order_out) > max(2, 0.02 * max(journal_out, order_out)):
        flag("HIGH", "OUTPUT_NOT_ON_ORDER",
             f"The journal shows {journal_out:,.0f} cases of {fg} posted for this job, the order shows "
             f"{order_out:,.0f} fulfilled ({journal_out - order_out:+,.0f}).")
    if out.empty and order_out > 0:
        flag("MEDIUM", "OUTPUT_NOT_IN_JOURNAL",
             f"The order shows {order_out:,.0f} fulfilled but no output of {fg} was found in the journal "
             f"for this job (outside the journal's dates, or posted as another product).")

    # ---- bulk / late output postings ----
    last_regular = w["last_regular"]
    odd = []
    for c in confs.itertuples():
        late = (not pd.isna(last_regular) and c.time > last_regular
                and (c.time - last_regular) > pd.Timedelta(hours=rules.late_hours))
        if c.bulk or late:
            why = []
            if c.bulk:
                why.append(f"{c.pallets} pallets at once")
            if late:
                why.append(f"{(c.time - last_regular).total_seconds() / 3600:.1f} h after the line's last regular output")
            odd.append(f"{c.conf} at {c.time:%d.%m %H:%M}: {c.cases:,.0f} cases ({', '.join(why)})")
    if odd:
        flag("MEDIUM", "OUTPUT_POSTED_IN_BULK_OR_LATE", "Output posted in bulk or late: " + "; ".join(odd) + ".")

    # ---- pallets ----
    typ = typical_pallet.get(fg)
    if typ and not out.empty:
        over, odd_size = [], []
        for b, g in out.groupby("batch"):
            gross, net = g.loc[g["qty"] > 0, "qty"].sum(), g["qty"].sum()
            if gross > 1.5 * typ:
                over.append(f"{b}: {gross:,.0f} cases confirmed on one pallet"
                            + (f", corrected to {net:,.0f}" if net != gross else ""))
            elif net > typ * 1.02:
                odd_size.append(f"{b}: {net:,.0f}")
        if over:
            flag("MEDIUM", "PALLET_CONFIRMED_MORE_THAN_ONCE",
                 f"Usual pallet for {fg} is {typ:,.0f} cases. " + "; ".join(over) + ".")
        if odd_size:
            flag("LOW", "UNUSUAL_PALLET_SIZE", f"Usual pallet for {fg} is {typ:,.0f} cases; larger pallets: "
                 + ", ".join(odd_size) + ". Worth a physical count.")
    rev = out[out["qty"] < 0]
    if not rev.empty:
        flag("INFO", "OUTPUT_REVERSED", "Output reversed: " + "; ".join(
            f"{r.conf} at {r.time:%d.%m %H:%M} ({r.qty:,.0f} on pallet {r.batch})" for r in rev.itertuples()) + ".")

    # ---- inputs on the order vs recipe ----
    scale_j = journal_out / planned_out if planned_out else None
    scale_o = order_out / planned_out if planned_out else None
    comp_rows, short = [], []
    cheese_comps = comps[comps["material"].map(lambda m: is_cheese(m, rules))]
    for c in comps.itertuples():
        exp_j = c.planned * scale_j if scale_j is not None else None
        comp_rows.append({"material": c.material, "planned": c.planned, "fulfilled": c.fulfilled,
                          "expected_for_journal_output": exp_j,
                          "expected_for_order_output": c.planned * scale_o if scale_o is not None else None})
        if is_cheese(c.material, rules) or exp_j is None or exp_j <= 0:
            continue
        if c.fulfilled < exp_j - max(2, 0.03 * exp_j):
            short.append((c.material, c.fulfilled, exp_j))
    if short:
        worst = max((e - f) / e for _, f, e in short)
        flag("HIGH" if worst > 0.10 else "MEDIUM", "INPUTS_SHORT_FOR_OUTPUT",
             f"For {journal_out:,.0f} cases the recipe needs more than was booked: " + "; ".join(
                 f"{m} {f:,.2f} booked vs {e:,.2f} needed" for m, f, e in short) + ".")
    if not cheese_comps.empty and cheese_comps["fulfilled"].fillna(0).sum() == 0 and order_out > 0:
        flag("LOW", "CHEESE_NOT_BOOKED_ON_ORDER",
             "No cheese is booked against this order's inputs. Cheese use below is worked out from "
             "cheese moved to the line and back.")

    # ---- cheese on the line ----
    per_case = (cheese_comps["planned"].sum() / planned_out) if planned_out and not cheese_comps.empty else None
    sent = float(cheese["sent"].sum()) if not cheese.empty else 0.0
    back = float(cheese["returned"].sum()) if not cheese.empty else 0.0
    used = sent - back
    exp_journal = per_case * journal_out if per_case else None
    exp_order = per_case * order_out if per_case else None
    if per_case and (journal_out or order_out):
        if cheese.empty:
            flag("MEDIUM", "NO_CHEESE_SENT_TO_LINE",
                 f"No cheese from this job's recipe ({', '.join(sorted(cheese_comps['material']))}) was moved to "
                 f"{area or 'the line'} during the run. It may have used cheese already on the line, or the "
                 f"cheese was booked elsewhere.")
        else:
            tol = max(rules.tolerance_pct * (exp_journal or 0), rules.tolerance_kg)
            base = exp_journal if journal_out else exp_order
            diff = used - base
            cheese_diff, cheese_tol = diff, tol
            matches_order = exp_order is not None and abs(used - exp_order) <= max(rules.tolerance_pct * exp_order, rules.tolerance_kg)
            msg = (f"Cheese moved to {area}: {sent:,.1f} kg, moved away again: {back:,.1f} kg, so {used:,.1f} kg used. "
                   f"Recipe ({per_case:.3f} kg/case) needs {exp_journal:,.1f} kg for the {journal_out:,.0f} cases in the "
                   f"journal" + (f" and {exp_order:,.1f} kg for the {order_out:,.0f} on the order" if exp_order is not None
                                  and order_out != journal_out else "") + ".")
            if abs(diff) <= tol:
                flag("INFO", "CHEESE_BALANCES", msg + f" Difference {diff:+,.1f} kg is within tolerance.")
            else:
                sev = "HIGH" if abs(diff) > max(3 * tol, 500) else "MEDIUM"
                extra = " It matches the order's output instead." if matches_order and journal_out != order_out else ""
                flag(sev, "CHEESE_OVER_USED" if diff > 0 else "CHEESE_UNDER_USED",
                     msg + f" Difference {diff:+,.1f} kg ({diff / base:+.1%})." + extra)
            # blend split
            plan_share = (cheese_comps.groupby("material")["planned"].sum() / cheese_comps["planned"].sum())
            if len(plan_share) > 1 and used > 0:
                net = (cheese.assign(net=cheese["sent"] - cheese["returned"]).groupby("material")["net"].sum() / used)
                off = [(m, net.get(m, 0.0), s) for m, s in plan_share.items() if abs(net.get(m, 0.0) - s) > rules.blend_tolerance]
                if off:
                    flag("MEDIUM", "BLEND_SPLIT_OFF", "Cheese split differs from the recipe: " + "; ".join(
                        f"{m} {a:.0%} vs {s:.0%} planned" for m, a, s in off) + ".")
            shared = cheese[cheese["candidates"] > 1]
            if not shared.empty:
                flag("INFO", "CHEESE_SHARED_LINE",
                     f"{len(shared)} cheese movement(s) ({shared['sent'].sum():,.1f} kg) on {area} could also belong to "
                     f"order(s) {', '.join(sorted(set(', '.join(shared['other_orders']).split(', ')) - {''}))}, also on "
                     f"{area} around that time; they were given to this order because it was already running or its next output followed soonest.")

    # ---- leftovers still on the line (stock overview) ----
    if not wb.stock.empty and not cheese.empty:
        left = wb.stock.merge(cheese[["material", "batch", "area"]].drop_duplicates(), on=["material", "batch", "area"])
        left = left[left["qty"] > 1]
        if not left.empty:
            flag("MEDIUM", "CHEESE_STILL_ON_LINE",
                 f"{left['qty'].sum():,.1f} kg of this job's cheese still shows on {area} in the stock overview: "
                 + ", ".join(f"{r.material} {r.batch} {r.qty:,.1f} kg" for r in left.itertuples()) + ".")

    offcuts = wb.byproducts[wb.byproducts["order_id"] == oid]
    summary = {
        "order_id": oid, "status": o["status"], "fg": fg, "fg_text": o.get("fg_text"), "line": o["resource"],
        "area": area, "start": o["start"], "last_regular_output": last_regular,
        "planned_out": planned_out, "order_out": order_out, "journal_out": journal_out,
        "output_confirmations": len(confs), "cheese_kg_per_case": per_case,
        "cheese_sent_kg": sent, "cheese_returned_kg": back, "cheese_used_kg": used,
        "cheese_expected_journal_kg": exp_journal, "cheese_expected_order_kg": exp_order,
        "offcuts_kg": float(offcuts["fulfilled"].sum()) if not offcuts.empty else 0.0,
        "cheese_diff_kg": cheese_diff, "cheese_tolerance_kg": cheese_tol,
        "components": comp_rows,
    }
    findings.sort(key=lambda f: SEVERITY_ORDER[f.severity])
    return summary, findings


@dataclass
class Result:
    summaries: list
    findings: list
    outputs: pd.DataFrame
    sends: pd.DataFrame
    unassigned: pd.DataFrame
    sheets: dict


def run(wb: Workbook, order_ids: list[str] | None = None, rules: Rules | None = None) -> Result:
    rules = rules or Rules()
    orders = wb.orders[~wb.orders["resource"].isin(rules.skip_resources)]
    outputs = assign_outputs(wb, rules)
    windows, per_conf = order_windows(orders, outputs, rules)
    sends = assign_cheese(wb, windows, outputs, rules)
    pos = outputs[outputs["qty"] > 0]
    typical = {}
    for fg, g in pos.groupby("material"):
        per_pallet = g.groupby("batch")["qty"].sum().round()
        if len(per_pallet) >= 5 and per_pallet.mode().iat[0] >= 10:
            typical[fg] = per_pallet.mode().iat[0]

    wanted = [str(o) for o in order_ids] if order_ids else [
        o for o in orders["order_id"] if o in set(outputs["order_id"].dropna()) or o in set(sends["order_id"])]
    summaries, findings = [], []
    for oid in wanted:
        if oid not in set(orders["order_id"]):
            findings.append(Finding(oid, "INFO", "ORDER_NOT_FOUND", "Order not found in the order sheets."))
            continue
        s, f = check_order(oid, wb, windows, outputs, per_conf, sends, typical, rules)
        summaries.append(s)
        findings.extend(f)
    findings = pair_carry_over(summaries, findings, orders, rules)
    unassigned = outputs[outputs["order_id"].isna()]
    return Result(summaries, findings, outputs, sends, unassigned, wb.sheets)


def pair_carry_over(summaries: list, findings: list, orders: pd.DataFrame, rules: Rules) -> list:
    """A job over on cheese followed on the same line by a job under by about the same amount:
    cheese left on the line in SAP after the first job was used by the next one."""
    by_id = {s["order_id"]: s for s in summaries}
    seq = orders[orders["order_id"].isin(by_id)].dropna(subset=["start"]).sort_values("start")
    replace: dict[str, Finding] = {}
    for res, g in seq.groupby("resource"):
        ids = list(g["order_id"])
        for a, b in zip(ids, ids[1:]):
            sa, sb = by_id[a], by_id[b]
            da, db = sa.get("cheese_diff_kg"), sb.get("cheese_diff_kg")
            if da is None or db is None or a in replace or b in replace:
                continue
            # First job over, next job under: the first job's leftover was used by the next
            if abs(da) <= sa["cheese_tolerance_kg"] or abs(db) <= sb["cheese_tolerance_kg"] or not (da > 0 > db):
                continue
            end_a = sa["last_regular_output"] if not pd.isna(sa["last_regular_output"]) else sa["start"]
            if pd.isna(end_a) or pd.isna(sb["start"]) or sb["start"] - end_a > pd.Timedelta(hours=12):
                continue
            residual = abs(da + db) / max(abs(da), abs(db))
            if residual > 0.35:
                continue
            first, second = (a, b)
            over, under = (a, b) if da > 0 else (b, a)
            msg = (f"Orders {first} and {second} ran one after the other on {res}: {over} is "
                   f"{by_id[over]['cheese_diff_kg']:+,.1f} kg on cheese moved to the line and {under} is "
                   f"{by_id[under]['cheese_diff_kg']:+,.1f} kg (net {da + db:+,.1f} kg). ")
            msg += ("Cheese left on the line after the first job was used by the next one without being "
                    "returned and re-issued in SAP.")
            for oid in (a, b):
                replace[oid] = Finding(oid, "MEDIUM", "CHEESE_CARRIED_OVER", msg)
    out = []
    for f in findings:
        if f.order_id in replace and f.code in ("CHEESE_OVER_USED", "CHEESE_UNDER_USED"):
            out.append(replace.pop(f.order_id))
        else:
            out.append(f)
    return out


# ---------------------------------------------------------------- reporting

def _fmt(v, d=0):
    return "n/a" if v is None or (isinstance(v, float) and math.isnan(v)) else f"{v:,.{d}f}"


def print_result(res: Result, show_info: bool = True) -> None:
    print("Sheets used:")
    for k, v in res.sheets.items():
        print(f"  - {k}: {v}")
    by_order = {}
    for f in res.findings:
        by_order.setdefault(f.order_id, []).append(f)
    for s in res.summaries:
        print("\n" + "=" * 100)
        print(f"Order {s['order_id']} - {s['fg']} {s['fg_text'] or ''} ({s['status']}) on {s['line']}"
              + (f", started {s['start']:%d.%m.%Y %H:%M}" if not pd.isna(s['start']) else ""))
        print(f"  Output: planned {_fmt(s['planned_out'])} | order {_fmt(s['order_out'])} | journal {_fmt(s['journal_out'])} "
              f"cases in {s['output_confirmations']} confirmation(s)")
        if s["cheese_kg_per_case"]:
            print(f"  Cheese on line: sent {_fmt(s['cheese_sent_kg'], 1)} - back {_fmt(s['cheese_returned_kg'], 1)} = "
                  f"{_fmt(s['cheese_used_kg'], 1)} kg | recipe {s['cheese_kg_per_case']:.3f} kg/case -> "
                  f"{_fmt(s['cheese_expected_journal_kg'], 1)} kg for journal output, "
                  f"{_fmt(s['cheese_expected_order_kg'], 1)} kg for order output")
        for f in by_order.get(s["order_id"], []):
            if show_info or f.severity != "INFO":
                print(f"  [{f.severity}] {f.code}: {f.message}")
    for f in res.findings:
        if f.code == "ORDER_NOT_FOUND":
            print(f"\nOrder {f.order_id}: not found in the order sheets.")
    counts = {}
    for f in res.findings:
        counts[f.severity] = counts.get(f.severity, 0) + 1
    print("\n" + "=" * 100)
    print(f"Checked {len(res.summaries)} order(s): " + ", ".join(f"{counts.get(k, 0)} {k}" for k in SEVERITY_ORDER))
    if not res.unassigned.empty:
        print(f"{len(res.unassigned)} output posting(s) could not be tied to any order (see Excel 'Unmatched output').")


def write_excel(res: Result, path: str) -> str:
    flags = pd.DataFrame([{"Order": f.order_id, "Severity": f.severity, "Check": f.code, "Finding": f.message,
                           "Reason code": "", "Resolved by": "", "Notes": ""} for f in res.findings])
    orders = pd.DataFrame([{k: v for k, v in s.items() if k != "components"} for s in res.summaries])
    comps = pd.DataFrame([{"order_id": s["order_id"], **c} for s in res.summaries for c in s["components"]])
    ids = {s["order_id"] for s in res.summaries}
    outs = res.outputs[res.outputs["order_id"].isin(ids)].sort_values(["order_id", "time"])
    sends = res.sends[res.sends["order_id"].isin(ids)].sort_values(["order_id", "time"])
    with pd.ExcelWriter(path, engine="openpyxl") as xw:
        for name, df in (("Flags", flags), ("Orders", orders), ("Inputs vs recipe", comps),
                         ("Output postings", outs), ("Cheese to line", sends),
                         ("Unmatched output", res.unassigned)):
            df.to_excel(xw, sheet_name=name, index=False)
            ws = xw.sheets[name]
            ws.freeze_panes = "A2"
            for col in ws.columns:
                width = max((len(str(c.value)) for c in col[:200] if c.value is not None), default=8)
                ws.column_dimensions[col[0].column_letter].width = min(max(width + 2, 10), 90)
    return path


def main(argv=None) -> int:
    p = argparse.ArgumentParser(prog="python -m sap_variance.reconcile",
                                description="Check production orders against the confirmation journal in a ByDesign workbook.")
    p.add_argument("files", nargs="+", help="Workbook(s) with the order, journal and stock sheets.")
    p.add_argument("-o", "--orders", help="Order IDs, e.g. '589, 590'. Omit to check every order with activity.")
    p.add_argument("-x", "--excel", help="Excel report path (default: order_check_<time>.xlsx).")
    p.add_argument("--no-excel", action="store_true")
    p.add_argument("--hide-info", action="store_true")
    a = p.parse_args(argv)
    wb = read_workbook(a.files)
    ids = [t for t in re.split(r"[\s,;]+", a.orders) if t] if a.orders else None
    res = run(wb, ids)
    print_result(res, show_info=not a.hide_info)
    if not a.no_excel:
        out = a.excel or f"order_check_{datetime.now():%Y%m%d_%H%M%S}.xlsx"
        print(f"\nExcel report: {write_excel(res, out)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
