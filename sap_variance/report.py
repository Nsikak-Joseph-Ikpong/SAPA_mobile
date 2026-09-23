"""Console and Excel output."""

from __future__ import annotations

from pathlib import Path

import pandas as pd

from .analysis import SEVERITY_ORDER, Analysis, fmt_kg, fmt_qty


def _headline(m: dict) -> list[str]:
    title = f"Order {m['order_id']}"
    if m["fg_material"]:
        title += f" - {m['fg_material']}"
    if m["fg_description"]:
        title += f" {m['fg_description']}"
    if m["status"]:
        title += f" ({m['status']})"
    lines = [title]
    pack = f"{m['pack_kg']:g} kg/case ({m['pack_source']})" if m["pack_kg"] else "pack weight unknown"
    lines.append(f"  Planned {fmt_qty(m['planned_qty'])} | Fulfilled {fmt_qty(m['fulfilled_qty'])} | "
                 f"Open {fmt_qty(m['open_qty'])} | {pack}")
    if m["expected_cheese_kg"] is not None or m["cheese_issued_kg"] is not None:
        lines.append(f"  Output {fmt_kg(m['output_kg'])} | Expected cheese {fmt_kg(m['expected_cheese_kg'])} "
                     f"(starch {m['starch_pct']:.1%}) | Issued {fmt_kg(m['cheese_issued_kg'])} | "
                     f"Offcuts {fmt_kg(m['offcuts_kg'])}")
    if m["variance_kg"] is not None:
        pct = f" ({m['variance_pct']:+.1%})" if m["variance_pct"] is not None else ""
        lines.append(f"  Variance {fmt_kg(m['variance_kg'], signed=True)}{pct}  "
                     f"[tolerance +/-{m['tolerance_kg']:,.1f} kg]")
    if m["cheese_materials"]:
        lines.append(f"  Cheese by material: {m['cheese_materials']}")
    return lines


def print_report(analysis: Analysis, show_info: bool = True) -> None:
    print()
    print("Files read:")
    for row in analysis.tables.itertuples():
        where = f"{row.file} [{row.sheet}]" if row.sheet else row.file
        if row.detected_as == "unknown":
            print(f"  - {where}: not recognised (no known column headers) - skipped")
        else:
            print(f"  - {where}: {row.detected_as}, {row.rows} rows (header on row {row.header_row})")
    if analysis.missing:
        print(f"\nNot found in any file: {', '.join(analysis.missing)}")

    ok = []
    for oid in analysis.requested:
        r = analysis.results[oid]
        flags = sorted((f for f in r.flags if show_info or f.severity != "INFO"),
                       key=lambda f: SEVERITY_ORDER[f.severity])
        if not any(f.severity != "INFO" for f in flags):
            ok.append(oid)
        print()
        print("=" * 100)
        for line in _headline(r.metrics):
            print(line)
        if not flags:
            print("  OK - nothing flagged")
        for f in flags:
            print(f"  [{f.severity}] {f.code}: {f.message}")

    counts = {}
    for f in analysis.flags:
        counts[f.severity] = counts.get(f.severity, 0) + 1
    print()
    print("=" * 100)
    print(f"Checked {len(analysis.requested)} order(s): "
          + ", ".join(f"{counts.get(s, 0)} {s}" for s in ("HIGH", "MEDIUM", "LOW", "INFO")))
    if ok:
        print(f"No issues: {', '.join(ok)}")


def write_excel(analysis: Analysis, path: str | Path) -> Path:
    path = Path(path)
    requested = set(analysis.requested)
    flags = pd.DataFrame([{
        "Order": f.order_id, "Severity": f.severity, "Check": f.code, "Finding": f.message,
        "Variance kg": round(f.kg, 1) if f.kg is not None else None,
        "Related orders": f.related_orders, "Reason code": "", "Resolved by": "", "Notes": "",
    } for f in analysis.flags])
    if flags.empty:
        flags = pd.DataFrame(columns=["Order", "Severity", "Check", "Finding", "Variance kg",
                                      "Related orders", "Reason code", "Resolved by", "Notes"])

    orders = pd.DataFrame([analysis.results[o].metrics for o in analysis.requested])
    if not orders.empty:
        worst = {o: min((SEVERITY_ORDER[f.severity] for f in analysis.results[o].flags), default=9)
                 for o in analysis.requested}
        orders.insert(1, "worst_flag", [next((k for k, v in SEVERITY_ORDER.items() if v == worst[o]), "OK")
                                        for o in orders["order_id"]])
        for col in ("variance_pct", "starch_pct"):
            orders[col] = orders[col].map(lambda v: None if v is None else round(v * 100, 2))
        orders = orders.rename(columns={"variance_pct": "variance_%", "starch_pct": "starch_%"})

    components = [analysis.results[o].components for o in analysis.requested
                  if not analysis.results[o].components.empty]
    components = pd.concat(components, ignore_index=True) if components else pd.DataFrame()

    swaps = analysis.swaps
    if not swaps.empty:
        swaps = swaps[swaps["order_a"].isin(requested) | swaps["order_b"].isin(requested)]
    batches = analysis.batches
    if not batches.empty:
        batches = batches[batches["orders"].map(lambda s: any(o in requested for o in s.split(", ")))]

    with pd.ExcelWriter(path, engine="openpyxl") as writer:
        for name, df in (("Flags", flags), ("Orders", orders), ("Components", components),
                         ("Swap candidates", swaps), ("Batches", batches), ("Files read", analysis.tables)):
            df.to_excel(writer, sheet_name=name, index=False)
            ws = writer.sheets[name]
            ws.freeze_panes = "A2"
            for col in ws.columns:
                width = max((len(str(c.value)) for c in col if c.value is not None), default=8)
                ws.column_dimensions[col[0].column_letter].width = min(max(width + 2, 10), 90)
    return path
