"""Check each production order against the confirmation journal of a ByDesign workbook.

The workbook holds (sheet names do not matter, sheets are recognised by headers):

* Production Order (OUT+IN)   - per order: status, line (Resource ID), output product,
                                every input with planned / fulfilled quantity
* Production order (output)   - per order: output and by-products (offcut bins),
                                planned / fulfilled, actual production start
* Production Order (INPUT)    - optional: units of measure per input
* Confirmation Journal        - every posting, with NO production order column
* Stock Overview              - optional: stock per logistics area and batch now

The order sheet is the first point of truth: what was planned, what was
fulfilled (issued / made) and what is still open, for the output and every
input. Inputs are judged against what the fulfilled output needs.

The journal has no order ID, so journal rows are tied to orders by product,
line and time and used as supporting evidence only:

* finished-goods output rows go to the latest order of that product that had
  started when the output was posted (pallets, bulk or late postings);
* cheese moved to an order's line around its run is listed for reference. A
  move to the line is staging, not an issue to the job: operators issue cheese
  to the order explicitly, from wherever it is stored.
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
    consumption_grace_minutes: int = 15             # consumption this long after a job's last pallet can still be its
    handoff_minutes: int = 30
    start_anchor_seconds: int = 2                    # a posting this close to an order's start is its first                        # cheese consumed this soon before the next job starts is for it
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
    offcut_tolerance: float = 0.03                   # offcut rate this far above plan is flagged


# ---------------------------------------------------------------- reading the workbook

def _key(v) -> str:
    return alias_key(v) if v is not None and not (isinstance(v, float) and math.isnan(v)) else ""


SHEET_SIGNATURES = {
    "journal": {"confid", "effectiveqty"},
    "components": {"inputmaterialid", "resourceid"},
    "outputs": {"productionorderoutputproduct", "product", "productionstartdatetime"},
    "inputs": {"inputproduct", "operationid"},
    "stock": {"onhandstock", "logisticsarea"},
    "fulfilment": {"productionlot", "inputproduct", "confid", "inventoryvaluationqty"},
}


def _find_header(raw: pd.DataFrame) -> tuple[str | None, int]:
    for i in range(min(15, len(raw))):
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
    fulfilment: pd.DataFrame | None = None


def _journal(j: pd.DataFrame) -> pd.DataFrame:
    journal = pd.DataFrame({
        "site": j["site"], "material": j["product"].astype(str).str.strip(),
        "batch": _id(j[[c for c in j.columns if c.startswith("identifiedstock")][0]]),
        "area": j[[c for c in j.columns if c.startswith("logisticsarea")][0]].astype(str).str.strip(),
        "time": _time(j["createdon"]), "doc": j["confdocumenttype"].astype(str),
        "conf": _id(j["confid"]), "qty": _num(j["effectiveqty"]),
    }).dropna(subset=["time", "qty"])
    journal["is_prod"] = journal["doc"].str.contains("Production", case=False)
    return journal


def _merge_journals(journals: list) -> pd.DataFrame:
    """Several exports of the journal can overlap (e.g. one with only receiving rows, one with
    both sides). The fullest one is kept whole; the others only add postings it doesn't have."""
    journals = sorted(journals, key=len, reverse=True)
    base = journals[0]
    key = lambda d: d["conf"].astype(str) + "|" + d["material"] + "|" + d["batch"].astype(str)
    seen = set(key(base))
    extra = [d[~key(d).isin(seen)] for d in journals[1:]]
    return pd.concat([base, *extra], ignore_index=True) if extra else base


def read_workbook(paths: list[str]) -> Workbook:
    found: dict[str, pd.DataFrame] = {}
    names: dict = {}
    journals: list[pd.DataFrame] = []
    for p in paths:
        path = Path(p)
        if path.suffix.lower() in (".csv", ".txt"):
            sheets = {path.name: pd.read_csv(path, header=None, dtype=object, sep=None, engine="python")}
        else:
            sheets = pd.read_excel(path, sheet_name=None, header=None, dtype=object)
        for name, raw in sheets.items():
            kind, row = _find_header(raw)
            if kind == "journal":
                journals.append(_journal(_frame(raw, row)))
                names.setdefault("journal", [])
                names["journal"].append(f"{path.name} [{name}]")
            elif kind:
                df = _frame(raw, row)
                found[kind] = pd.concat([found[kind], df], ignore_index=True) if kind in found else df
                names[kind] = f"{path.name} [{name}]"
    if journals:
        found["journal"] = _merge_journals(journals)
        names["journal"] = ", ".join(names["journal"])
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
    byp = pd.DataFrame(columns=["order_id", "material", "text", "planned", "fulfilled", "open"])
    head = pd.DataFrame(columns=["order_id", "planned_out", "fulfilled_out", "start_actual", "latest_end", "fg_text"])
    if "outputs" in found:
        o = found["outputs"]
        for col in ("productionorder", "productionorderoutputproduct", "productionorderoutputproducttext"):
            o[col] = o[col].ffill()
        o = pd.DataFrame({
            "order_id": _id(o["productionorder"]), "fg": o["productionorderoutputproduct"].astype(str).str.strip(),
            "fg_text": o["productionorderoutputproducttext"], "material": o["product"].astype(str).str.strip(),
            "text": o["producttext"], "planned": _num(o["plannedquantity"]), "fulfilled": _num(o["fulfilledquantity"]),
            "open": _num(o["openquantity"]) if "openquantity" in o else float("nan"),
            "start_actual": _time(o["productionstartdatetime"]), "latest_end": _time(o["productionorderlatestenddatetime"]),
        })
        main = o[o["material"] == o["fg"]]
        head = main.groupby("order_id").agg(planned_out=("planned", "sum"), fulfilled_out=("fulfilled", "sum"),
                                             start_actual=("start_actual", "min"), latest_end=("latest_end", "max"),
                                             fg_text=("fg_text", "first")).reset_index()
        byp = o[o["material"] != o["fg"]][["order_id", "material", "text", "planned", "fulfilled", "open"]]

    orders = (comp.groupby("order_id", sort=False)
              .agg(status=("status", "first"), fg=("fg", "first"), resource=("resource", "first"),
                   requested_start=("requested_start", "first"), out_open=("out_open", "first"),
                   out_fulfilled=("out_fulfilled", "first"))
              .reset_index().merge(head, on="order_id", how="left"))
    orders["planned_out"] = orders["planned_out"].fillna(orders["out_open"] + orders["out_fulfilled"])
    orders["fulfilled_out"] = orders["fulfilled_out"].fillna(orders["out_fulfilled"])
    orders["start"] = orders["start_actual"].fillna(orders["requested_start"])

    journal = found["journal"]

    # --- stock overview ---
    stock = pd.DataFrame(columns=["area", "material", "batch", "qty"])
    if "stock" in found:
        s = found["stock"]
        s = s[s["material"].astype(str) != "Result"]
        stock = pd.DataFrame({"area": s["logisticsarea"].astype(str), "material": s["material"].astype(str).str.strip(),
                              "batch": _id(s[[c for c in s.columns if c.startswith("identifiedstockidentifiedstockid")][0]]),
                              "qty": _num(s["onhandstock"])})
    # --- production order fulfilment: every input confirmation with its production order (lot) ---
    fulfil = None
    if "fulfilment" in found:
        f = found["fulfilment"]
        for col in ("productionlot", "outputproduct", "inputproduct"):
            f[col] = f[col].ffill()
        fulfil = pd.DataFrame({
            "order_id": _id(f["productionlot"]), "material": f["inputproduct"].astype(str).str.strip(),
            "conf": _id(f["confid"]), "kg": _num(f["inventoryvaluationqty"]),     # in kg (Confirmed Qty can be in blocks)
            "planned": _num(f.get("inputproductplannedquantity")),
        })
        fulfil = fulfil[fulfil["order_id"].notna() & ~fulfil["material"].isin(["#", "Result", "nan"])
                        & fulfil["conf"].notna() & (fulfil["conf"] != "#") & fulfil["kg"].notna()].reset_index(drop=True)
    return Workbook(orders, comp, byp, journal, stock, names, fulfil)


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
    # Orders that never started (Released / Canceled with no production start) cannot own postings
    started = wb.orders[wb.orders["start_actual"].notna()
                        | ~wb.orders["status"].astype(str).str.lower().isin(["released", "canceled", "cancelled"])]
    starts = {fg: g.dropna(subset=["start"]).sort_values("start")[["order_id", "start"]].values.tolist()
              for fg, g in started.groupby("fg")}
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
    # A negative row is a reversal only for a pallet that was posted as output; otherwise it's
    # finished goods used as an input (rework) and not this product's output
    pos = out[out["qty"] > 0]
    made = set(zip(pos["order_id"], pos["material"], pos["batch"]))
    keep = (out["qty"] > 0) | pd.Series([k in made for k in zip(out["order_id"], out["material"], out["batch"])],
                                        index=out.index)
    return out[keep]


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


def _pick_owner(r, wins, recipe_by_order, next_out, starts, resources):
    """The order a cheese posting on a line belongs to: an order on that line's area whose run covers
    the posting and whose recipe has the cheese. A job already running owns it over the next job on
    the same line; between jobs running side by side (L4 and L5 share GRATINGLINES), the next regular
    output decides."""
    cands = wins[(wins["area"] == r.area) & (wins["begin"] <= r.time) & (wins["end"] >= r.time)]
    cands = [c for c in cands["order_id"] if r.material in recipe_by_order.get(c, set())]
    if not cands:
        return None

    def soonest(oid):
        later = [t for t in next_out.get(oid, []) if t >= r.time]
        return later[0] if later else pd.Timestamp.max
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
    return owner, cands


def _line_context(wb: Workbook, windows: pd.DataFrame, outputs: pd.DataFrame, rules: Rules):
    recipe = wb.components[wb.components["material"].map(lambda m: is_cheese(m, rules))]
    recipe_by_order = recipe.groupby("order_id")["material"].apply(set).to_dict()
    per_conf = (outputs[outputs["qty"] > 0].groupby(["order_id", "conf"])
                .agg(time=("time", "min"), pallets=("batch", "nunique")).reset_index())
    regular = per_conf[per_conf["pallets"] < rules.bulk_pallets]
    next_out = regular.sort_values("time").groupby("order_id")["time"].apply(list).to_dict()
    wins = windows.dropna(subset=["area", "begin", "end"])
    starts = dict(zip(windows["order_id"], windows["start"]))
    resources = dict(zip(windows["order_id"], windows["resource"]))
    return wins, recipe_by_order, next_out, starts, resources


def consumption_rows(journal: pd.DataFrame, rules: Rules) -> pd.DataFrame:
    """Cheese consumed on production confirmations: negative cheese rows (positive block-cheese rows
    are reversals). Positive offcut-bin rows are offcuts produced, not consumption."""
    ch = journal["is_prod"] & journal["material"].map(lambda m: is_cheese(m, rules)) & (journal["qty"] != 0)
    offcut_made = journal["material"].str.upper().str.match(rules.offcut_pattern) & (journal["qty"] > 0)
    return journal[ch & ~offcut_made]


def assign_consumption(wb: Workbook, windows: pd.DataFrame, outputs: pd.DataFrame, rules: Rules,
                       exclude_pairs: set | None = None, exclude_orders: set | None = None) -> pd.DataFrame:
    """Cheese consumption postings on a line, each tied to the order most likely to own it. Postings the
    order fulfilment report already ties to an order (exclude_pairs: Conf.ID + product) and the orders it
    covers (exclude_orders) are left out."""
    exclude_pairs, exclude_orders = exclude_pairs or set(), exclude_orders or set()
    wins, recipe_by_order, next_out, starts, resources = _line_context(wb, windows, outputs, rules)
    wins = wins[~wins["order_id"].isin(exclude_orders)]
    # Cheese isn't consumed for a job after its last pallet: once output stops (plus a short grace),
    # a job can no longer own consumption postings
    last_any = outputs[outputs["qty"] > 0].groupby("order_id")["time"].max()
    grace = pd.Timedelta(minutes=rules.consumption_grace_minutes)
    wins = wins.copy()
    cap = wins["order_id"].map(last_any) + grace
    wins["end"] = wins["end"].where(cap.isna() | (wins["end"] <= cap), cap)
    cons = consumption_rows(wb.journal, rules)
    cons = cons[cons["area"].isin(set(rules.line_areas.values()))]
    if exclude_pairs:
        cons = cons[[(c, m) not in exclude_pairs for c, m in zip(cons["conf"], cons["material"])]]
    cons = cons.sort_values("time", kind="stable")
    last_out = dict(zip(windows["order_id"], windows["last_regular"]))
    areas = dict(zip(windows["order_id"], windows["area"]))
    # SAP's production start is the time of the order's first confirmation, often its first cheese
    # consumption: a posting at an order's start belongs to that order
    actual_starts = wb.orders.dropna(subset=["start_actual"])
    anchor: dict = {}
    for oid, t in zip(actual_starts["order_id"], actual_starts["start_actual"]):
        if oid in areas and oid not in exclude_orders:
            anchor.setdefault(areas[oid], []).append((t, oid))
    tol = pd.Timedelta(seconds=rules.start_anchor_seconds)
    # a cheese not in any running job's recipe is taken as a substitute by a job on that line
    # using the same type of cheese (RMMA20GB for RMMA20GR: both mature)
    ctype = lambda m: m.upper()[:4] if not re.match(rules.offcut_pattern, m.upper()) else m.upper()
    types_by_order = {o: {ctype(m) for m in ms} for o, ms in recipe_by_order.items()}
    last_user: dict = {}
    rows = []
    for r in cons.itertuples():
        key = (r.material, r.batch)
        substitute = False
        anchored = [o for t, o in anchor.get(r.area, []) if abs(t - r.time) <= tol
                    and ctype(r.material) in types_by_order.get(o, set())]
        if r.qty > 0 and key in last_user:
            # a reversal goes back to the job that consumed the batch
            owner, cands = last_user[key], [last_user[key]]
        elif anchored:
            owner, cands = anchored[0], anchored
        else:
            picked = _pick_owner(r, wins, recipe_by_order, next_out, starts, resources)
            if not picked:
                typed = type("Posting", (), {"area": r.area, "time": r.time, "material": ctype(r.material)})
                picked = _pick_owner(typed, wins, types_by_order, next_out, starts, resources)
                substitute = picked is not None
            owner, cands = picked if picked else (None, [])
            if owner is not None:
                # posted after the owner's last output and just before the next job on that line starts:
                # it's for the next job
                lo = last_out.get(owner)
                nxt = [c for c in cands if resources.get(c) == resources.get(owner) and not pd.isna(starts.get(c))
                       and r.time < starts[c] <= r.time + pd.Timedelta(minutes=rules.handoff_minutes)]
                if not pd.isna(lo) and r.time > lo and nxt:
                    owner = min(nxt, key=lambda c: starts[c])
        if r.qty < 0 and owner is not None:
            last_user[key] = owner
        rows.append({"order_id": owner, "material": r.material, "batch": r.batch, "area": r.area,
                     "time": r.time, "conf": r.conf, "consumed": -r.qty, "candidates": len(cands),
                     "other_orders": ", ".join(c for c in cands if c != owner), "substitute": substitute,
                     "via": "time"})
    return pd.DataFrame(rows, columns=["order_id", "material", "batch", "area", "time", "conf", "consumed",
                                       "candidates", "other_orders", "substitute", "via"])


def fulfilment_consumption(wb: Workbook, rules: Rules) -> pd.DataFrame:
    """Cheese consumed per order straight from the order fulfilment report (in kg). Each confirmation is
    matched to its journal rows by Conf.ID and product for the batch, area and time; if the journal doesn't
    have it (posted after the export) it's kept as one row without a batch."""
    f = wb.fulfilment
    cols = ["order_id", "material", "batch", "area", "time", "conf", "consumed", "candidates", "other_orders",
            "substitute", "via"]
    if f is None or f.empty:
        return pd.DataFrame(columns=cols)
    recipe = wb.components[wb.components["material"].map(lambda m: is_cheese(m, rules))]
    recipe_by_order = recipe.groupby("order_id")["material"].apply(set).to_dict()
    jp = wb.journal[wb.journal["is_prod"]]
    by_key = {k: g for k, g in jp.groupby(["conf", "material"], sort=False)}
    # issues can also be warehouse or goods-and-activity confirmations (e.g. from the regrading site or
    # straight from a store bin): their issuing (negative) rows carry the batch
    jn = wb.journal[wb.journal["qty"] < 0]
    by_key_neg = {k: g for k, g in jn.groupby(["conf", "material"], sort=False)}
    rows = []
    for r in f[f["material"].map(lambda m: is_cheese(m, rules))].itertuples():
        sub = r.material not in recipe_by_order.get(r.order_id, set())
        g = by_key.get((r.conf, r.material))
        base = {"order_id": r.order_id, "material": r.material, "conf": r.conf, "candidates": 1, "other_orders": "",
                "substitute": sub, "via": "fulfilment"}
        gn = by_key_neg.get((r.conf, r.material))
        if g is not None and abs(float(-g["qty"].sum()) - float(r.kg)) < 0.01:
            for x in g.itertuples():
                rows.append({**base, "batch": x.batch, "area": x.area, "time": x.time, "consumed": -x.qty})
        elif gn is not None and abs(float(-gn["qty"].sum()) - float(r.kg)) < 0.01:
            for x in gn.itertuples():
                rows.append({**base, "batch": x.batch, "area": x.area, "time": x.time, "consumed": -x.qty})
        else:
            g = g if g is not None else gn
            rows.append({**base, "batch": None, "area": g["area"].iloc[0] if g is not None else "",
                         "time": g["time"].min() if g is not None else pd.NaT, "consumed": float(r.kg)})
    return pd.DataFrame(rows, columns=cols)



def starch_consumed(journal: pd.DataFrame, outputs: pd.DataFrame, rules: Rules) -> dict:
    """Starch is backflushed with the output: its rows sit on the order's output confirmations."""
    confs = outputs[outputs["order_id"].notna() & (outputs["qty"] > 0)][["order_id", "conf"]].drop_duplicates()
    st = journal[journal["is_prod"] & journal["material"].str.upper().str.startswith(rules.not_cheese_prefixes)]
    st = st.merge(confs, on="conf")
    return (-st.groupby("order_id")["qty"].sum()).to_dict()


def over_consumed_batches(journal: pd.DataFrame, rules: Rules) -> dict:
    """Batches consumed for more than the biggest quantity ever posted for them (a pallet weight)."""
    cons = consumption_rows(journal, rules)
    if cons.empty:
        return {}
    used = (-cons.groupby(["material", "batch"])["qty"].sum())
    size = journal[journal["qty"] > 0].groupby(["material", "batch"])["qty"].max()
    out = {}
    for (m, b), u in used.items():
        sz = size.get((m, b))
        if sz and u > sz + max(1.0, 0.01 * sz):
            out[(m, b)] = (u, sz)
    return out


def assign_cheese(wb: Workbook, windows: pd.DataFrame, outputs: pd.DataFrame, rules: Rules) -> pd.DataFrame:
    """Cheese moved to a line during an order's run; returns found by batch afterwards."""
    wins, recipe_by_order, next_out, starts, resources = _line_context(wb, windows, outputs, rules)
    moves = wb.journal[(~wb.journal["is_prod"]) & (wb.journal["qty"] > 0)]
    arrivals = moves[moves["material"].map(lambda m: is_cheese(m, rules))
                     & moves["area"].isin(set(rules.line_areas.values()))]
    rows = []
    for r in arrivals.itertuples():
        picked = _pick_owner(r, wins, recipe_by_order, next_out, starts, resources)
        if not picked:
            continue
        owner, cands = picked
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



PACK = re.compile(r"(\d+)\s*[xX]\s*(\d+(?:[.,]\d+)?)(?![\d.,])\s*(kg|k|grm|gr|g)?(?![A-Za-z])", re.I)


def pack_weight(text):
    """Case weight from a pack size in the product text: 6x1kg, 40x5kg, 12x160g, 4x2.88k, 10 x 180 (grams when
    a bare number is 50 or more). A size with a unit wins over a bare one (90x90 is a slice size)."""
    found = list(PACK.finditer(str(text or "")))
    if not found:
        return None
    m = next((x for x in found if x.group(3)), found[0])
    n, q, unit = int(m.group(1)), float(m.group(2).replace(",", ".")), (m.group(3) or "").lower()
    grams = unit.startswith("g") or (not unit and q >= 50)
    w = n * q / 1000 if grams else n * q
    return w if 0.05 <= w <= 1000 else None


PACK_CODE = re.compile(r"\d{2,}")


def pack_code(fg):
    """The pack code in a job code: the first run of two or more digits (MAGR200GB -> 200,
    MOGR2122EU -> 2122, MCGR155EF7030 -> 155)."""
    m = PACK_CODE.search(str(fg or ""))
    return m.group(0) if m else None


def learn_pack_codes(orders: pd.DataFrame) -> dict:
    """Case weight per pack code, learnt from products whose text states the pack size. A code whose
    products disagree is left out."""
    seen: dict = {}
    for fg, text in orders[["fg", "fg_text"]].drop_duplicates().itertuples(index=False):
        code, w = pack_code(fg), pack_weight(text)
        if code and w:
            seen.setdefault(code, set()).add(round(w, 3))
    return {c: next(iter(ws)) for c, ws in seen.items() if len(ws) == 1}


def case_weight(text, recipe_net, fg=None, code_weights=None) -> tuple:
    """Nominal weight per unit of output. Products whose recipe needs about 1 kg per unit are counted in kg.
    Otherwise the pack size in the product text, else the pack code in the job code (as other products with
    that code), else the recipe. A text or code weight more than about 2x away from the recipe isn't trusted."""
    if recipe_net and abs(recipe_net - 1) <= 0.03:
        return 1.0, "output counted in kg (the recipe needs about 1 kg per unit)"
    plausible = lambda w: not recipe_net or recipe_net <= 0 or 0.45 <= recipe_net / w <= 2.2
    w = pack_weight(text)
    if w and plausible(w):
        return w, "pack size in the product text"
    code = pack_code(fg)
    if code and code_weights and code in code_weights and plausible(code_weights[code]):
        return code_weights[code], f"job code (pack code {code}, as other products with that code)"
    if recipe_net and recipe_net > 0:
        return round(recipe_net, 3), "recipe (cheese + starch less offcuts, per case)"
    return None, None


def recipe_per_case(p_cheese, p_starch, p_off, planned_out, cw) -> dict:
    """Cheese, starch and offcuts per case from the recipe. When the recipe's product weight per case
    (cheese + starch less offcuts) is more than 5% away from the case weight, the recipe is scaled to the
    case weight (e.g. two alternative cheeses both planned for the full case)."""
    cheese_pc, starch_pc, off_pc = p_cheese / planned_out, p_starch / planned_out, p_off / planned_out
    net = cheese_pc + starch_pc - off_pc
    k = 1.0
    if cw and net > 0 and abs(net - cw) / cw > 0.05 and cheese_pc - off_pc > 0:
        # scale the cheese (and the offcuts that come from it); starch stays as planned
        k = (cw - starch_pc) / (cheese_pc - off_pc) if cw > starch_pc else cw / net
    return {"cheese_pc": cheese_pc * k, "starch_pc": starch_pc, "off_pc": off_pc * k,
            "in_pc": cheese_pc * k + starch_pc, "net_pc": cheese_pc * k + starch_pc - off_pc * k, "recipe_net": net,
            "scale": k, "corrected": k != 1.0, "case_weight": cw}


def variance_view(o, comps, cheese_comps, offc, order_out, journal_out, cheese_source, consumed, starch_in,
                  issued, used_est, rules, code_weights=None, rec=None) -> dict | None:
    """The variance in the layout of the plant's variance report."""
    planned_out = o["planned_out"] if not pd.isna(o["planned_out"]) else None
    if not planned_out:
        return None
    starch_comps = comps[comps["material"].str.upper().str.startswith(rules.not_cheese_prefixes)]
    p_cheese, p_starch = float(cheese_comps["planned"].sum()), float(starch_comps["planned"].sum())
    p_off = float(offc["planned"].fillna(0).sum())
    made_off = float(offc["fulfilled"].fillna(0).sum())
    recipe_net = (p_cheese + p_starch - p_off) / planned_out
    cw, cw_from = case_weight(o.get("fg_text"), recipe_net, o["fg"], code_weights)
    actual = order_out or journal_out
    if cw is None or not actual:
        return None
    # cheese only: starch is left out of actual and expected cheese, and out of the output side
    # (a 200 kg dolav holds 197 kg of cheese and 3 kg of starch)
    if cheese_source == "consumed":
        actual_cheese, cheese_from = consumed, "cheese consumed in the journal (no starch)"
    elif cheese_source == "order":
        actual_cheese, cheese_from = issued, "cheese issued on the order sheet (no starch)"
    elif cheese_source == "journal":
        actual_cheese, cheese_from = used_est, "estimate from cheese moved to the line (no starch)"
    else:
        return None
    nominal_out = actual * cw
    starch_out = actual * (rec["starch_pc"] if rec else p_starch / planned_out)
    nominal_cheese = nominal_out - starch_out
    expected = actual * rec["cheese_pc"] if rec else actual * p_cheese / planned_out
    exp_off = actual * rec["off_pc"] if rec else actual * p_off / planned_out
    ga_exp = expected - nominal_cheese - exp_off
    ga_act = actual_cheese - nominal_cheese - made_off
    out_off = nominal_cheese + made_off
    diff = out_off - actual_cheese
    return {"case_weight": cw, "case_weight_from": cw_from, "uom": "kg" if cw_from.startswith("output counted in kg") else "Case",
            "planned_fg": planned_out, "actual_fg": actual,
            "nominal_planned": planned_out * cw, "nominal_output": nominal_out, "starch_in_output": starch_out,
            "nominal_cheese_output": nominal_cheese, "expected_cheese": expected,
            "actual_cheese": actual_cheese, "actual_cheese_from": cheese_from, "expected_offcuts": exp_off,
            "actual_offcuts": made_off, "ga_expected": ga_exp, "ga_actual": ga_act, "output_plus_offcuts": out_off,
            "difference": diff, "diff_pct": diff / actual_cheese if actual_cheese else None,
            "planned_input_pct": expected / nominal_cheese if nominal_cheese else None,
            "variance_kg": ga_act - ga_exp, "tolerance": max(rules.tolerance_pct * expected, rules.tolerance_kg),
            "recipe_kg_per_case": recipe_net}


def variance_reasons(oid, v, cons, sends_o, window, consumption, codes, recipe_blocks, info, rules) -> list:
    """Possible reasons for the variance, with the journal evidence behind each."""
    out = []
    var = v["variance_kg"]
    rn, cw = v["recipe_kg_per_case"], v["case_weight"]
    if rn and cw and abs(rn - cw) / cw > 0.05:
        out.append({"kg": None, "text": f"The recipe plans {rn:,.3f} kg of cheese and starch per case (less offcuts) "
                    f"for a {cw:,.3f} kg case ({rn / cw - 1:+.0%}), so expected cheese uses the case weight instead: "
                    f"check the recipe (BOM)."})
    if abs(var) <= v["tolerance"]:
        return out + [{"kg": None, "text": f"Cheese is within tolerance of the plan ({var:+,.1f} kg against the "
                                           f"giveaway the recipe allows), so there's nothing to explain."}]
    area, begin, end = window["area"], window["begin"], window["end"]
    ctype = info["ctype"]
    types = {ctype(m) for m in info["recipe"]}
    if var < 0:
        # less cheese recorded than the product and offcuts need
        if not sends_o.empty:
            g = sends_o.assign(net=sends_o["sent"] - sends_o["returned"]).groupby(["material", "batch"], sort=True)["net"].sum()
            left = []
            for (m, b), moved in g.items():
                used = info["consumed_by_batch"].get((m, b), 0.0)
                if moved - used > 1:
                    left.append((m, b, moved - used))
            if left:
                kg = sum(x[2] for x in left)
                out.append({"kg": kg, "text": f"{kg:,.1f} kg of cheese was moved to {area} for this run but never "
                            f"consumed in SAP: " + ", ".join(f"{m} {b} {q:,.1f} kg" for m, b, q in left[:8])
                            + (f" and {len(left) - 8} more" if len(left) > 8 else "") + ". If it went into the product, "
                            "its consumption is missing."})
        if consumption is not None:
            un = consumption[consumption["order_id"].isna() & (consumption["area"] == area)
                             & (consumption["time"] >= begin) & (consumption["time"] <= end)]
            un = un[un["material"].map(lambda m: ctype(m) in types)]
            if not un.empty and un["consumed"].sum() > 1:
                kg = float(un["consumed"].sum())
                out.append({"kg": kg, "text": f"{kg:,.1f} kg of similar cheese was consumed on {area} during the run "
                            f"but couldn't be tied to any job: " + ", ".join(sorted(set(un["material"]))) + "."})
            amb = consumption[(consumption["order_id"] != oid) & consumption["order_id"].notna()
                              & consumption["other_orders"].fillna("").str.split(", ").map(lambda xs: oid in xs)]
            if not amb.empty:
                by = amb.groupby("order_id")["consumed"].sum()
                kg = float(amb["consumed"].sum())
                out.append({"kg": kg, "text": f"{kg:,.1f} kg consumed on {area} was given to "
                            + ", ".join(f"order {k} ({q:,.1f} kg)" for k, q in by.items())
                            + " but could belong to this order (both were on the line at the time)."})
        for m in recipe_blocks:
            if info["consumed_by_material"].get(m, 0.0) <= 0 and consumption is not None:
                out.append({"kg": None, "text": f"{m} is in the recipe but none was consumed for this run: it was "
                            f"used without a consumption posting, or the product was made without it."})
        if codes & {"OUTPUT_NOT_ON_ORDER", "PALLET_DOUBLE_BOOKED", "PALLET_CONFIRMED_MORE_THAN_ONCE", "UNUSUAL_PALLET_SIZE"}:
            out.append({"kg": None, "text": "Output may be overstated: see the pallet and output findings below."})
        if v["actual_offcuts"] - v["expected_offcuts"] > 25:
            out.append({"kg": v["actual_offcuts"] - v["expected_offcuts"],
                        "text": f"Offcuts declared are {v['actual_offcuts'] - v['expected_offcuts']:,.1f} kg above "
                        f"expected; if they're overstated, less cheese is missing."})
        if not out:
            out.append({"kg": None, "text": "No trace in the journal: cheese was used without being moved or "
                        "consumed in SAP, or the output is overstated."})
    else:
        # more cheese recorded than the product and offcuts account for
        amb = cons[cons["candidates"] > 1] if not cons.empty else cons
        if not amb.empty:
            kg = float(amb["consumed"].sum())
            others = sorted(set(", ".join(amb["other_orders"]).split(", ")) - {""})
            out.append({"kg": kg, "text": f"{kg:,.1f} kg of this order's consumption could belong to "
                        f"order(s) {', '.join(others)}, on the line at the same time."})
        if not cons.empty:
            ret = []
            for (m, b), net in cons.groupby(["material", "batch"], sort=True)["consumed"].sum().items():
                if net <= 1:
                    continue
                last = cons[(cons["material"] == m) & (cons["batch"] == b)]["time"].max()
                later = info["moves_by_batch"].get((m, b))
                if later is None:
                    continue
                later = later[(later["time"] > last) & (later["time"] <= last + pd.Timedelta(hours=rules.return_hours))
                              & ~later["area"].isin(set(rules.line_areas.values())) & ~later["area"].str.startswith("#")]
                if not later.empty:
                    # what was already reversed on this batch doesn't count as unreversed
                    b_rows = cons[(cons["material"] == m) & (cons["batch"] == b)]
                    rev = float(-b_rows.loc[b_rows["consumed"] < 0, "consumed"].sum())
                    q = min(max(0.0, float(later["qty"].sum()) - rev), float(net))
                    if q <= 1:
                        continue
                    ret.append((m, b, q, later["area"].iloc[0], later["time"].iloc[0]))
            if ret:
                kg = sum(x[2] for x in ret)
                out.append({"kg": kg, "text": f"{kg:,.1f} kg was moved back off the line after being consumed, "
                            f"without the consumption being reversed: " + ", ".join(
                                f"{m} {b} {q:,.1f} kg to {a} at {t:%d.%m %H:%M}" for m, b, q, a, t in ret[:8]) + "."})
        if v["expected_offcuts"] - v["actual_offcuts"] > 25:
            out.append({"kg": v["expected_offcuts"] - v["actual_offcuts"],
                        "text": f"Offcuts declared are {v['expected_offcuts'] - v['actual_offcuts']:,.1f} kg below "
                        f"expected: offcuts not declared, or more cheese went to waste."})
        if "OUTPUT_NOT_IN_JOURNAL" in codes or "OUTPUT_NOT_ON_ORDER" in codes:
            out.append({"kg": None, "text": "Output may be understated: see the output findings below."})
        out.append({"kg": None, "text": "Otherwise: giveaway (overfill above the nominal case weight) or waste on "
                    "the line that wasn't posted."})
    return sorted(out, key=lambda x: -(x["kg"] or 0))


# ---------------------------------------------------------------- checks

def check_order(oid: str, wb: Workbook, windows: pd.DataFrame, outputs: pd.DataFrame, per_conf: pd.DataFrame,
                sends: pd.DataFrame, typical_pallet: dict, rules: Rules, consumption: pd.DataFrame | None = None,
                over_batches: dict | None = None, starch_used: dict | None = None,
                info: dict | None = None) -> tuple[dict, list[Finding]]:
    o = wb.orders[wb.orders["order_id"] == oid].iloc[0]
    comps = wb.components[wb.components["order_id"] == oid]
    w = windows[windows["order_id"] == oid].iloc[0]
    out = outputs[outputs["order_id"] == oid]
    confs = per_conf[per_conf["order_id"] == oid].sort_values("time")
    cheese = sends[sends["order_id"] == oid]
    has_cons = consumption is not None
    cons = consumption[consumption["order_id"] == oid] if has_cons else pd.DataFrame(columns=["material", "consumed"])
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
        over, odd_size, double = [], [], []
        for b, g in out.groupby("batch"):
            gross, net = g.loc[g["qty"] > 0, "qty"].sum(), g["qty"].sum()
            if net >= 2 * typ:
                # double booked and still standing: the output is overstated
                pos = g[g["qty"] > 0].sort_values("time", kind="stable")
                double.append((b, net, net - typ, "; ".join(
                    f"{x.conf} at {x.time:%d.%m %H:%M} ({x.qty:,.0f})" for x in pos.itertuples())))
            elif gross > 1.5 * typ:
                over.append(f"{b}: {gross:,.0f} cases confirmed on one pallet"
                            + (f", corrected to {net:,.0f}" if net != gross else ""))
            elif net > typ * 1.02:
                odd_size.append(f"{b}: {net:,.0f}")
        if double:
            flag("HIGH", "PALLET_DOUBLE_BOOKED",
                 f"Usual pallet for {fg} is {typ:,.0f} cases. " + " ".join(
                     f"Pallet {b} has {net:,.0f} cases ({net / typ:.1f}x the usual), confirmed {cs}: output is "
                     f"overstated by about {extra:,.0f} cases unless it's corrected." for b, net, extra, cs in double))
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

    # ---- output on the order: planned vs fulfilled vs open ----
    status = str(o["status"])
    out_open = o["out_open"] if not pd.isna(o["out_open"]) else None
    if planned_out and order_out > planned_out + max(1, 0.02 * planned_out):
        extra = order_out - planned_out
        flag("MEDIUM" if extra > 0.10 * planned_out else "LOW", "OUTPUT_OVER_PLAN",
             f"{order_out:,.0f} cases made against {planned_out:,.0f} planned ({extra:+,.0f}, {extra / planned_out:+.0%}).")
    elif planned_out and order_out < planned_out - max(1, 0.02 * planned_out):
        left = planned_out - order_out
        if out_open:
            flag("INFO", "OUTPUT_STILL_OPEN", f"{out_open:,.0f} of {planned_out:,.0f} planned cases still open to make.")
        else:
            flag("LOW", "OUTPUT_SHORT_OF_PLAN",
                 f"{order_out:,.0f} of {planned_out:,.0f} planned cases made and nothing left open "
                 f"({-left:,.0f}); order status {status}.")

    # ---- inputs on the order: fulfilled vs what the fulfilled output needs ----
    scale = order_out / planned_out if planned_out else None
    comp_rows, short, over = [], [], []
    cheese_comps = comps[comps["material"].map(lambda m: is_cheese(m, rules))]
    for c in comps.itertuples():
        need = c.planned * scale if scale is not None else None
        booked = 0.0 if pd.isna(c.fulfilled) else float(c.fulfilled)
        comp_rows.append({"material": c.material, "planned": c.planned, "fulfilled": booked, "open": c.open,
                          "needed_for_output": need, "difference": booked - need if need is not None else None,
                          "cheese": is_cheese(c.material, rules)})
        if is_cheese(c.material, rules) or need is None or need <= 0:
            continue
        if booked < need - max(2, 0.03 * need):
            short.append((c.material, booked, need))
        elif booked > need + max(2, 0.10 * need):
            over.append((c.material, booked, need))
    if short:
        worst = max((e - f) / e for _, f, e in short)
        flag("HIGH" if worst > 0.10 else "MEDIUM", "INPUTS_SHORT_FOR_OUTPUT",
             f"For the {order_out:,.0f} cases on the order the recipe needs more than was issued: " + "; ".join(
                 f"{m} {f:,.2f} issued vs {e:,.2f} needed" for m, f, e in short) + ".")
    if over:
        flag("LOW", "INPUTS_OVER_FOR_OUTPUT",
             f"More issued than the {order_out:,.0f} cases need: " + "; ".join(
                 f"{m} {f:,.2f} issued vs {e:,.2f} needed" for m, f, e in over) + ".")

    # ---- cheese issued to the order ----
    per_case = (cheese_comps["planned"].sum() / planned_out) if planned_out and not cheese_comps.empty else None
    rec = None
    if per_case:
        st_c = comps[comps["material"].str.upper().str.startswith(rules.not_cheese_prefixes)]
        off_c = wb.byproducts[wb.byproducts["order_id"] == oid]
        p_ch, p_st, p_of = float(cheese_comps["planned"].sum()), float(st_c["planned"].sum()), float(off_c["planned"].fillna(0).sum())
        cw_o, _ = case_weight(o.get("fg_text"), (p_ch + p_st - p_of) / planned_out, o["fg"], (info or {}).get("code_weights"))
        rec = recipe_per_case(p_ch, p_st, p_of, planned_out, cw_o)
        per_case = rec["cheese_pc"]
    issued = float(cheese_comps["fulfilled"].fillna(0).sum()) if not cheese_comps.empty else 0.0
    cheese_open = float(cheese_comps["open"].fillna(0).sum()) if not cheese_comps.empty else 0.0
    needed = per_case * order_out if per_case else None
    cheese_source = None
    if needed and order_out > 0 and not has_cons:
        lines = "; ".join(f"{c.material} {0 if pd.isna(c.fulfilled) else c.fulfilled:,.2f} of {c.planned * scale:,.2f} kg"
                          for c in cheese_comps.itertuples())
        if issued == 0:
            cheese_source = "journal"
            flag("INFO", "CHEESE_NOT_ON_ORDER_SHEET",
                 f"No cheese issue shows on the order sheet ({lines}), so cheese input is estimated from the "
                 f"confirmation journal (cheese moved to the line during the run).")
        else:
            cheese_source = "order"
            tol = max(rules.tolerance_pct * needed, rules.tolerance_kg)
            cheese_diff, cheese_tol = issued - needed, tol
            msg = (f"Cheese issued {issued:,.1f} kg, the {order_out:,.0f} cases need {needed:,.1f} kg "
                   f"({per_case:.3f} kg/case): {lines}.")
            if abs(cheese_diff) <= tol:
                flag("INFO", "CHEESE_BALANCES", msg + f" Difference {cheese_diff:+,.1f} kg is within tolerance.")
            else:
                sev = "HIGH" if abs(cheese_diff) > max(3 * tol, 500) else "MEDIUM"
                extra = ""
                if cheese_diff < 0 and not cheese.empty:
                    # the order sheet can miss issues: check the journal estimate too
                    moved = float((cheese["sent"] - cheese["returned"]).sum())
                    extra = f" The journal shows about {moved:,.1f} kg moved to the line for this run"
                    if moved >= needed - tol:
                        sev, extra = "MEDIUM", extra + ", enough for the output, so the order sheet is probably missing issues."
                    else:
                        extra += "."
                flag(sev, "CHEESE_OVER_ISSUED" if cheese_diff > 0 else "CHEESE_UNDER_ISSUED",
                     msg + f" Difference {cheese_diff:+,.1f} kg ({cheese_diff / needed:+.1%})." + extra)
            # blend: shares of the block cheeses (offcut bins can stand in for their own cheese)
            blocks = cheese_comps[~cheese_comps["material"].str.upper().str.startswith("MB")]
            plan_share = blocks.groupby("material")["planned"].sum()
            got = blocks.groupby("material")["fulfilled"].sum().fillna(0)
            if len(plan_share) > 1 and got.sum() > 0:
                plan_share, got = plan_share / plan_share.sum(), got / got.sum()
                off = [(m, got.get(m, 0.0), sh) for m, sh in plan_share.items()
                       if abs(got.get(m, 0.0) - sh) > rules.blend_tolerance]
                if off:
                    flag("MEDIUM", "BLEND_SPLIT_OFF", "Cheese issued in a different split from the recipe: " + "; ".join(
                        f"{m} {a:.0%} vs {sh:.0%} planned" for m, a, sh in off) + ".")

    # ---- estimate from the journal when the order sheet shows no cheese ----
    # The journal has no cheese consumption lines; the nearest thing is cheese moved to the
    # job's line during its run, less what was moved away again. That's an estimate: cheese
    # can be issued straight from store without a move, or left on the line for the next job.
    sent = float(cheese["sent"].sum()) if not cheese.empty else 0.0
    back = float(cheese["returned"].sum()) if not cheese.empty else 0.0
    used = sent - back
    est_out = journal_out or order_out
    est_needed = per_case * est_out if per_case else None
    if cheese_source == "journal" and est_needed:
        materials = sorted(set(cheese_comps["material"]))
        not_moved = [m for m in materials if m not in set(cheese["material"]) and not m.upper().startswith("MB")]
        if cheese.empty:
            flag("MEDIUM", "NO_CHEESE_SEEN",
                 f"No cheese for this job shows anywhere: nothing issued on the order sheet and none of "
                 f"{', '.join(materials)} moved to {area or 'the line'} during the run.")
        else:
            tol = max(rules.tolerance_pct * est_needed, rules.tolerance_kg)
            cheese_diff, cheese_tol = used - est_needed, tol
            msg = (f"Estimate from the journal: {sent:,.1f} kg moved to {area}, {back:,.1f} kg moved away again, "
                   f"so about {used:,.1f} kg used. The {est_out:,.0f} cases {'in the journal ' if journal_out else ''}"
                   f"need {est_needed:,.1f} kg ({per_case:.3f} kg/case).")
            if not_moved:
                flag("INFO", "CHEESE_FROM_STORE",
                     f"{', '.join(not_moved)} never moved to {area} during the run: issued straight from store or "
                     f"already on the line, so it isn't in the journal estimate.")
            if abs(cheese_diff) <= tol:
                flag("INFO", "CHEESE_BALANCES_EST", msg + f" Difference {cheese_diff:+,.1f} kg is within tolerance.")
            else:
                flag("MEDIUM", "CHEESE_OVER_EST" if cheese_diff > 0 else "CHEESE_UNDER_EST",
                     msg + f" Difference {cheese_diff:+,.1f} kg ({cheese_diff / est_needed:+.1%}).")
            shared = cheese[cheese["candidates"] > 1]
            if not shared.empty:
                others = sorted(set(", ".join(shared["other_orders"]).split(", ")) - {""})
                flag("INFO", "CHEESE_SHARED_LINE",
                     f"{len(shared)} cheese move(s) ({shared['sent'].sum():,.1f} kg) on {area} could also belong to "
                     f"order(s) {', '.join(others)}, on {area} around the same time; they were given to this order "
                     f"because it was already running or its next output followed soonest.")

    # ---- cheese consumed, from the journal's production confirmations ----
    mass = None
    # sums rounded to 6 decimals so the float summing order can't tip a displayed figure
    consumed = round(float(cons["consumed"].sum()), 6) if not cons.empty else 0.0
    by_mat = cons.groupby("material")["consumed"].sum().round(6) if not cons.empty else pd.Series(dtype=float)
    if has_cons and per_case and (journal_out or order_out):
        cheese_source = "consumed"
        est_out = journal_out or order_out
        # what goes in per case is cheese and starch (197 + 3 kg for a 200 kg dolav): both sides include starch
        # cheese only: starch is shown but not counted
        st_pc = rec["starch_pc"]
        in_pc = per_case
        starch_used_o = float((starch_used or {}).get(oid, 0.0))
        consumed_in = consumed
        est_needed = per_case * est_out
        cheese_need = est_needed
        share = cheese_comps.groupby("material")["planned"].sum() / cheese_comps["planned"].sum()
        mats = "; ".join(f"{m} {by_mat.get(m, 0.0):,.1f} of {sh * cheese_need:,.1f} kg" for m, sh in share.items())
        others = [m for m in by_mat.index if m not in share.index]
        sheet = f" The order sheet shows {issued:,.1f} kg of cheese issued." if issued else " None of the cheese shows on the order sheet."
        other_out = (f" (the order shows {order_out:,.0f} cases, which need {in_pc * order_out:,.1f} kg)"
                     if journal_out and order_out != journal_out else "")
        # ---- mass balance: everything in (cheese blocks, offcuts, starch) vs everything out
        # (product, offcuts made). Product weight per case comes from the recipe: cheese + starch
        # planned, less the offcuts planned, over the planned cases.
        starch_comps = comps[comps["material"].str.upper().str.startswith(rules.not_cheese_prefixes)]
        p_cheese, p_starch = float(cheese_comps["planned"].sum()), float(starch_comps["planned"].sum())
        offc = wb.byproducts[wb.byproducts["order_id"] == oid]
        p_off, made_off = float(offc["planned"].fillna(0).sum()), float(offc["fulfilled"].fillna(0).sum())
        net_pc = rec["net_pc"]
        starch_in = float((starch_used or {}).get(oid, 0.0))
        offcut_in = float(sum(v for m, v in by_mat.items() if re.match(rules.offcut_pattern, m.upper())))
        mass_in = consumed + starch_in
        product_kg = est_out * net_pc
        mass_out = product_kg + made_off
        unacc = mass_in - mass_out
        mass_tol = max(rules.tolerance_pct * mass_in, rules.tolerance_kg)
        off_scale = est_out * rec["off_pc"] / p_off if p_off else 0.0   # planned offcuts for the cases made
        mass = {"in": mass_in, "blocks_in": consumed - offcut_in, "offcuts_in": offcut_in, "starch_in": starch_in,
                "out": mass_out, "product": product_kg, "kg_per_case": net_pc, "cases": est_out,
                "offcuts_made": made_off, "offcuts_planned": p_off * off_scale, "unaccounted": unacc, "tolerance": mass_tol}
        mass_text = (f"In {mass_in:,.1f} kg (cheese blocks {consumed - offcut_in:,.1f}, offcuts {offcut_in:,.1f}, "
                     f"starch {starch_in:,.1f}); out {mass_out:,.1f} kg (product {est_out:,.0f} cases × {net_pc:.3f} kg = "
                     f"{product_kg:,.1f}, offcuts made {made_off:,.1f}).")
        if cons.empty:
            mass = None
            moved = f" {sent:,.1f} kg was moved to {area} during the run." if sent else ""
            flag("HIGH", "CHEESE_NOT_CONSUMED",
                 f"No cheese consumption in the journal for this run: the {est_out:,.0f} cases need "
                 f"{est_needed:,.1f} kg of cheese ({in_pc:.3f} kg/case){other_out}.{moved}{sheet}")
        else:
            tol = max(rules.tolerance_pct * est_needed, rules.tolerance_kg)
            cheese_diff, cheese_tol = consumed_in - est_needed, tol
            msg = (f"Cheese consumed {consumed_in:,.1f} kg, the {est_out:,.0f} cases "
                   f"{'in the journal ' if journal_out else ''}need {est_needed:,.1f} kg ({in_pc:.3f} kg/case){other_out}: {mats}"
                   + (f"; also {', '.join(f'{m} {by_mat[m]:,.1f} kg' for m in others)}" if others else "") + "."
                   + sheet
                   + (f" The recipe plans {rec['recipe_net']:,.3f} kg per case for a {rec['case_weight']:,.3f} kg case, "
                      f"so it's scaled to the case weight." if rec["corrected"] else "")
                   + (f" Starch ({starch_used_o:,.1f} of {st_pc * est_out:,.1f} kg) isn't counted." if st_pc else ""))
            cheese_off = abs(cheese_diff) > tol
            if not cheese_off:
                flag("INFO", "CHEESE_BALANCES", msg + f" Difference {cheese_diff:+,.1f} kg is within tolerance.")
            elif p_off > 0 and abs(unacc) <= mass_tol:
                # the extra (or missing) cheese came out as more (or fewer) offcuts than planned
                flag("LOW", "CHEESE_OVER_USED" if cheese_diff > 0 else "CHEESE_UNDER_USED",
                     msg + f" Difference {cheese_diff:+,.1f} kg ({cheese_diff / est_needed:+.1%}). Everything that went "
                     f"in came out as product or offcuts (offcuts made {made_off:,.1f} kg against {p_off * off_scale:,.1f} planned "
                     f"for these cases), "
                     f"so this is offcut yield, not missing cheese.")
            else:
                sev = "HIGH" if abs(cheese_diff) > max(3 * tol, 500) else "MEDIUM"
                flag(sev, "CHEESE_OVER_USED" if cheese_diff > 0 else "CHEESE_UNDER_USED",
                     msg + f" Difference {cheese_diff:+,.1f} kg ({cheese_diff / est_needed:+.1%}).")
            if abs(unacc) <= mass_tol:
                flag("INFO", "MASS_BALANCES", mass_text + f" Unaccounted {unacc:+,.1f} kg is within tolerance.")
            else:
                same = cheese_off and (cheese_diff > 0) == (unacc > 0)
                sev = "INFO" if same else "HIGH" if abs(unacc) > max(3 * mass_tol, 500) else "MEDIUM"
                if unacc > 0:
                    flag(sev, "MASS_UNACCOUNTED", mass_text + f" {unacc:,.1f} kg ({unacc / mass_in:.1%}) went in but "
                         f"didn't come out as product or offcuts: waste, giveaway, or output or offcuts not posted.")
                else:
                    flag(sev, "MASS_OUT_EXCEEDS_IN", mass_text + f" {-unacc:,.1f} kg more came out than went in: "
                         f"inputs used but not consumed in SAP, or output overstated.")
            if p_off > 0 and mass_in > 0:
                plan_rate = p_off / (p_cheese + p_starch)
                rate = made_off / mass_in
                extra = made_off - plan_rate * mass_in
                if order_out > 0 and made_off == 0:
                    flag("LOW", "OFFCUTS_NOT_DECLARED",
                         f"No offcuts declared on the order ({p_off:,.1f} kg planned, {', '.join(sorted(set(offc['material'])))}).")
                elif rate - plan_rate > rules.offcut_tolerance and extra >= 25:
                    flag("MEDIUM", "OFFCUTS_OVER_PLAN",
                         f"Offcuts made {made_off:,.1f} kg, {rate:.1%} of what went in against {plan_rate:.1%} planned "
                         f"({extra:+,.1f} kg): {', '.join(f'{r.material} {r.fulfilled:,.1f} kg' for r in offc.itertuples())}.")
            blocks = share[[not m.upper().startswith("MB") for m in share.index]]
            got = by_mat.reindex(blocks.index).fillna(0)
            if len(blocks) > 1 and got.sum() > 0:
                blocks, got = blocks / blocks.sum(), got / got.sum()
                off = [(m, got[m], sh) for m, sh in blocks.items() if abs(got[m] - sh) > rules.blend_tolerance]
                if off:
                    flag("MEDIUM", "BLEND_SPLIT_OFF", "Cheese consumed in a different split from the recipe: " + "; ".join(
                        f"{m} {a:.0%} vs {sh:.0%} planned" for m, a, sh in off) + ".")
            shared = cons[cons["candidates"] > 1]
            if not shared.empty:
                oth = sorted(set(", ".join(shared["other_orders"]).split(", ")) - {""})
                flag("INFO", "CHEESE_SHARED_LINE",
                     f"{len(shared)} consumption posting(s) ({shared['consumed'].sum():,.1f} kg) on {area} could also "
                     f"belong to order(s) {', '.join(oth)}, on {area} around the same time; they were given to this "
                     f"order because it was already running or its next output followed soonest.")
        over = [(m, b, *over_batches[(m, b)]) for m, b in cons[["material", "batch"]].drop_duplicates().itertuples(index=False)
                if over_batches and (m, b) in over_batches]
        if over:
            flag("MEDIUM", "BATCH_OVER_CONSUMED", "Batch consumed for more than it held: " + "; ".join(
                f"{m} {b} consumed {u:,.2f} kg in total (this job {cons[(cons['material'] == m) & (cons['batch'] == b)]['consumed'].sum():,.2f}), "
                f"largest quantity posted for it {sz:,.2f} kg" for m, b, u, sz in over) + ".")

    offcuts = wb.byproducts[wb.byproducts["order_id"] == oid]
    variance = variance_view(o, comps, cheese_comps, offcuts, order_out, journal_out, cheese_source, consumed,
                             float((starch_used or {}).get(oid, 0.0)), issued, used, rules,
                             (info or {}).get("code_weights"), rec)
    reasons = []
    if variance and info is not None:
        blocks = sorted(m for m in set(cheese_comps["material"]) if not re.match(rules.offcut_pattern, m.upper()))
        oinfo = dict(info, recipe=set(cheese_comps["material"]),
                     consumed_by_material={k: float(v) for k, v in by_mat.items()})
        reasons = variance_reasons(oid, variance, cons, cheese, w, consumption, {f.code for f in findings},
                                   blocks if has_cons else [], oinfo, rules)
    # planned / done / open on the order, with what the journal shows consumed next to it
    def _tot(df, col):
        return float(df[col].fillna(0).sum()) if not df.empty else 0.0
    is_off = cheese_comps["material"].str.upper().str.match(rules.offcut_pattern) if not cheese_comps.empty else pd.Series(dtype=bool)
    blk, offi = cheese_comps[~is_off] if not cheese_comps.empty else cheese_comps, cheese_comps[is_off] if not cheese_comps.empty else cheese_comps
    stc = comps[comps["material"].str.upper().str.startswith(rules.not_cheese_prefixes)]
    cons_blk = float(sum(v for m, v in by_mat.items() if not re.match(rules.offcut_pattern, m.upper())))
    cons_off = float(sum(v for m, v in by_mat.items() if re.match(rules.offcut_pattern, m.upper())))
    # open = planned - actual, worked out here (the order sheet's open quantity isn't reliable).
    # Actual cheese and starch are what the journal shows consumed; product and offcuts as made on the order.
    j_or = lambda jv, sheet: jv if has_cons else sheet
    open_status = [
        {"item": "Product", "unit": "cases", "planned": planned_out or 0.0, "actual": order_out,
         "source": "made on the order"},
        {"item": "Offcuts made", "unit": "kg", "planned": _tot(offcuts, "planned"), "actual": _tot(offcuts, "fulfilled"),
         "source": "by-products on the order"},
        {"item": "Cheese blocks", "unit": "kg", "planned": _tot(blk, "planned"), "actual": j_or(cons_blk, _tot(blk, "fulfilled")),
         "source": "consumed in the journal" if has_cons else "issued on the order"},
        {"item": "Offcuts used", "unit": "kg", "planned": _tot(offi, "planned"), "actual": j_or(cons_off, _tot(offi, "fulfilled")),
         "source": "consumed in the journal" if has_cons else "issued on the order"},
        {"item": "Starch", "unit": "kg", "planned": _tot(stc, "planned"),
         "actual": j_or(float((starch_used or {}).get(oid, 0.0)), _tot(stc, "fulfilled")),
         "source": "consumed in the journal" if has_cons else "issued on the order"},
    ]
    for r_ in open_status:
        r_["planned"], r_["actual"] = float(r_["planned"]), float(r_["actual"])
        r_["open"] = r_["planned"] - r_["actual"]
    open_status = [r for r in open_status if r["planned"] or r["actual"]]
    summary = {
        "order_id": oid, "status": o["status"], "open_status": open_status,
        "double_booked_pallets": [b for b, g in out.groupby("batch") if typ and g["qty"].sum() >= 2 * typ] if not out.empty else [],
        "consumption_from": ("order fulfilment report" if oid in (info or {}).get("covered", set())
                             else "matched by line and time") if has_cons else None, "fg": fg, "fg_text": o.get("fg_text"), "line": o["resource"],
        "area": area, "start": o["start"], "last_regular_output": last_regular,
        "planned_out": planned_out, "order_out": order_out, "journal_out": journal_out,
        "output_confirmations": len(confs), "cheese_kg_per_case": per_case,
        "cheese_source": cheese_source, "cheese_issued_kg": issued, "cheese_needed_kg": needed,
        "cheese_open_kg": cheese_open, "cheese_sent_kg": sent, "cheese_returned_kg": back, "cheese_used_kg": used,
        "cheese_est_needed_kg": est_needed, "cheese_est_output": est_out, "cheese_consumed_kg": consumed,
        "cheese_consumed_by_material": {k: float(v) for k, v in by_mat.items()},
        "cheese_planned_kg": float(cheese_comps["planned"].sum()) if not cheese_comps.empty else 0.0,
        "starch_planned_kg": float(comps.loc[comps["material"].str.upper().str.startswith(rules.not_cheese_prefixes), "planned"].sum()),
        "input_kg_per_case": rec["in_pc"] if rec else None,
        "offcut_kg_per_case": rec["off_pc"] if rec else None,
        "starch_kg_per_case": rec["starch_pc"] if rec else None,
        "input_consumed_kg": (consumed + float((starch_used or {}).get(oid, 0.0))) if cheese_source == "consumed" else None,
        "cheese_planned_offcuts_kg": float(cheese_comps.loc[cheese_comps["material"].str.upper().str.match(rules.offcut_pattern), "planned"].sum())
        if not cheese_comps.empty else 0.0,
        "mass": mass, "variance": variance, "variance_reasons": reasons,
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
    consumption: pd.DataFrame | None = None


def run(wb: Workbook, order_ids: list[str] | None = None, rules: Rules | None = None) -> Result:
    rules = rules or Rules()
    orders = wb.orders[~wb.orders["resource"].isin(rules.skip_resources)]
    outputs = assign_outputs(wb, rules)
    windows, per_conf = order_windows(orders, outputs, rules)
    sends = assign_cheese(wb, windows, outputs, rules)
    # Journals exported with both sides carry cheese consumption; receiving-only exports don't
    raw_cons = consumption_rows(wb.journal, rules)
    journal_cons = bool(((raw_cons["qty"] < 0) & ~raw_cons["material"].str.upper().str.match(rules.offcut_pattern)).any())
    fulfil = wb.fulfilment if wb.fulfilment is not None and not wb.fulfilment.empty else None
    has_cons = journal_cons or fulfil is not None
    # orders in the order fulfilment report take their consumption from it; the rest are matched by line and time
    covered = set(fulfil["order_id"]) if fulfil is not None else set()
    owned = set(zip(fulfil["conf"], fulfil["material"])) if fulfil is not None else set()
    consumption = None
    if has_cons:
        parts = [fulfilment_consumption(wb, rules)]
        if journal_cons:
            parts.append(assign_consumption(wb, windows, outputs, rules, owned, covered))
        consumption = pd.concat([p for p in parts if not p.empty], ignore_index=True) if any(not p.empty for p in parts) \
            else parts[0]
    over_batches = over_consumed_batches(wb.journal, rules) if journal_cons else {}
    starch_used = starch_consumed(wb.journal, outputs, rules) if journal_cons else {}
    if fulfil is not None:
        st = fulfil[fulfil["material"].str.upper().str.startswith(rules.not_cheese_prefixes)]
        st_by = st.groupby("order_id")["kg"].sum().to_dict()
        for o in covered:
            starch_used[o] = float(st_by.get(o, 0.0))
    info = {"covered": covered, "code_weights": learn_pack_codes(wb.orders), "ctype": lambda m: m.upper()[:4] if not re.match(rules.offcut_pattern, m.upper()) else m.upper(),
            "consumed_by_batch": ((-raw_cons.groupby(["material", "batch"])["qty"].sum()).to_dict() if journal_cons else {}),
            "moves_by_batch": {k: g.sort_values("time", kind="stable") for k, g in
                               wb.journal[~wb.journal["is_prod"] & (wb.journal["qty"] > 0)].groupby(["material", "batch"])}}
    pos = outputs[outputs["qty"] > 0]
    typical = {}
    for fg, g in pos.groupby("material"):
        per_pallet = g.groupby("batch")["qty"].sum().round()
        if len(per_pallet) >= 5 and per_pallet.mode().iat[0] >= 10:
            typical[fg] = per_pallet.mode().iat[0]

    active = [o for o in orders["order_id"] if o in set(outputs["order_id"].dropna()) or o in set(sends["order_id"])]
    wanted = [str(o) for o in order_ids] if order_ids else active
    known = set(orders["order_id"])
    # The jobs just before and after each requested one on the same line are checked too,
    # so cheese carried from one job to the next can be recognised
    to_check = [o for o in wanted if o in known]
    seq = orders.dropna(subset=["start"]).sort_values("start")
    for res, g in seq.groupby("resource"):
        ids = [o for o in g["order_id"] if o in set(active) or o in set(to_check)]
        for i, o in enumerate(ids):
            if o in wanted:
                to_check += [n for n in ids[max(i - 1, 0):i + 2] if n not in to_check]
    summaries, findings = [], []
    for oid in wanted:
        if oid not in known:
            findings.append(Finding(oid, "INFO", "ORDER_NOT_FOUND", "Order not found in the order sheets."))
    for oid in to_check:
        s, f = check_order(oid, wb, windows, outputs, per_conf, sends, typical, rules, consumption, over_batches,
                           starch_used, info)
        summaries.append(s)
        findings.extend(f)
    findings = pair_carry_over(summaries, findings, orders, rules)
    summaries = [s for s in summaries if s["order_id"] in set(wanted)]
    findings = [f for f in findings if f.order_id in set(wanted)]
    unassigned = outputs[outputs["order_id"].isna()]
    return Result(summaries, findings, outputs, sends, unassigned, wb.sheets, consumption)


def verdict(findings: list) -> str:
    """One word per order: PROBLEMS (any HIGH), CHECK (any MEDIUM) or OK."""
    sev = {f.severity for f in findings}
    return "PROBLEMS" if "HIGH" in sev else "CHECK" if "MEDIUM" in sev else "OK"


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
            if sa.get("cheese_source") != "journal" or sb.get("cheese_source") != "journal":
                continue
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
                   f"{by_id[over]['cheese_diff_kg']:+,.1f} kg on the journal estimate and {under} is "
                   f"{by_id[under]['cheese_diff_kg']:+,.1f} kg (net {da + db:+,.1f} kg). ")
            msg += ("Cheese left on the line after the first job was used by the next one without being "
                    "returned and re-issued in SAP.")
            for oid in (a, b):
                replace[oid] = Finding(oid, "MEDIUM", "CHEESE_CARRIED_OVER", msg)
    out = []
    for f in findings:
        if f.order_id in replace and f.code in ("CHEESE_OVER_EST", "CHEESE_UNDER_EST"):
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
        print(f"Order {s['order_id']} - {verdict(by_order.get(s['order_id'], []))} - {s['fg']} {s['fg_text'] or ''} ({s['status']}) on {s['line']}"
              + (f", started {s['start']:%d.%m.%Y %H:%M}" if not pd.isna(s['start']) else ""))
        print(f"  Output: planned {_fmt(s['planned_out'])} | order {_fmt(s['order_out'])} | journal {_fmt(s['journal_out'])} "
              f"cases in {s['output_confirmations']} confirmation(s)")
        if s["cheese_kg_per_case"]:
            print(f"  Cheese on the order sheet: issued {_fmt(s['cheese_issued_kg'], 1)} kg, needed {_fmt(s['cheese_needed_kg'], 1)} kg "
                  f"({s['cheese_kg_per_case']:.3f} kg/case), open {_fmt(s['cheese_open_kg'], 1)} kg")
            print(f"  Journal estimate: moved to the line {_fmt(s['cheese_sent_kg'], 1)} - away {_fmt(s['cheese_returned_kg'], 1)} = "
                  f"{_fmt(s['cheese_used_kg'], 1)} kg vs {_fmt(s['cheese_est_needed_kg'], 1)} kg needed"
                  + ("  <- used" if s["cheese_source"] == "journal" else ""))
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
    def flat(s):
        row = {}
        for k, v in s.items():
            if k == "components":
                continue
            if k == "open_status":
                row.update({f"open_{r['item'].lower().replace(' ', '_')}": r["open"] for r in v})
            elif k in ("mass", "variance"):
                row.update({f"{k}_{mk}": mv for mk, mv in (v or {}).items()})
            elif k == "variance_reasons":
                row[k] = " | ".join(x["text"] for x in v)
            elif isinstance(v, dict):
                row[k] = ", ".join(f"{m} {q:,.1f}" for m, q in v.items())
            else:
                row[k] = v
        return row
    orders = pd.DataFrame([flat(s) for s in res.summaries])
    comps = pd.DataFrame([{"order_id": s["order_id"], **c} for s in res.summaries for c in s["components"]])
    ids = {s["order_id"] for s in res.summaries}
    outs = res.outputs[res.outputs["order_id"].isin(ids)].sort_values(["order_id", "time"])
    sends = res.sends[res.sends["order_id"].isin(ids)].sort_values(["order_id", "time"])
    cons = (res.consumption[res.consumption["order_id"].isin(ids)].sort_values(["order_id", "time"])
            if res.consumption is not None else pd.DataFrame())
    if not cons.empty:
        # as in the SAP journal: negative for consumption, positive for a reversal
        cons = cons.assign(effective_qty=-cons["consumed"])
    by_order = {}
    for f in res.findings:
        by_order.setdefault(f.order_id, []).append(f)
    var_rows = []
    for sm in res.summaries:
        v = sm.get("variance")
        if not v:
            continue
        var_rows.append({
            "FG Lookup": f"{sm['order_id']}FG", "Production Order ID": sm["order_id"],
            "Material ID": sm["fg"], "Material ID (Text)": sm.get("fg_text") or "", "Material ID (Base UoM)": v["uom"],
            "Production Order Status": sm["status"], "Line": sm["line"], "Case Weight": v["case_weight"],
            "Planned FG Qty": v["planned_fg"], "Actual FG Qty": v["actual_fg"], "Nominal Weight Planned": v["nominal_planned"],
            "Nominal Weight of Output": v["nominal_output"], "Starch in Output": v["starch_in_output"],
            "Nominal Cheese of Output": v["nominal_cheese_output"], "Expected Cheese": v["expected_cheese"],
            "Actual Cheese Issued": v["actual_cheese"], "Expected Offcuts Output": v["expected_offcuts"],
            "Actual Offcuts Output": v["actual_offcuts"], "GA Expected": v["ga_expected"], "GA Actual": v["ga_actual"],
            "Output Cheese + Offcuts": v["output_plus_offcuts"], "Difference to Cheese Issued": v["difference"],
            "Diff %": v["diff_pct"], "Cheese Planned Input %": v["planned_input_pct"],
            **{f"Open {r['item']} ({r['unit']})": r["open"] for r in sm["open_status"]},
            "Verdict": verdict(by_order.get(sm["order_id"], [])),
            "Possible reasons": "\n".join((f"[{x['kg']:,.1f} kg] " if x["kg"] else "") + x["text"] for x in sm["variance_reasons"]),
            "Case weight from": v["case_weight_from"], "Actual cheese from": v["actual_cheese_from"]})
    variance = pd.DataFrame(var_rows)
    with pd.ExcelWriter(path, engine="openpyxl") as xw:
        for name, df in (("Variance", variance), ("Flags", flags), ("Orders", orders), ("Inputs vs recipe", comps),
                         ("Output postings", outs), ("Cheese consumed", cons), ("Cheese to line", sends),
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
