"""Order-vs-journal checks on a workbook shaped like the ByDesign export (made-up numbers)."""

import pandas as pd
import pytest

from sap_variance.reconcile import read_workbook, run

GA, PC = "Goods and Activity Confirmation", "Production Confirmation"


def ts(hhmm, day="19.08.2026"):
    return f"{day} {hhmm}:00 GMTUK"


def write_workbook(path):
    comp_head = ["Production Order ID", "Production Order Status", "Earliest Start Date Time", "Requested Start Date",
                 "Requested Start Date Time", "Output Product ID", "Resource ID", "Input Material ID",
                 "Output Material ID", "Output Material ID (Text)", "Planned Quantity", "Open Quantity",
                 "Fulfilled Quantity", "Counter", "Open Quantity", "Fulfilled Quantity"]
    comp = [
        # Job A: 1,000 cases planned (5kg, 1.5% starch -> 4.925 kg cheese/case), 400 made so far.
        # Boxes issued short, all the cheese issued as mozzarella (recipe 30/70 cheddar/mozzarella)
        ["A1", "Started", ts("01:00"), None, ts("01:00"), "FGBLEND", "GRATING_L4", "BOBOX", "FGBLEND", "", 1000, 620, 380, 1, 600, 400],
        [None] * 7 + ["RMCHED", "FGBLEND", "", 1477.5, 1477.5, 0, 1, 600, 400],
        [None] * 7 + ["RMMOZZ", "FGBLEND", "", 3447.5, 1477.5, 1970, 1, 600, 400],
        # Job B next on the same line: 350 cases planned, 400 made, no cheese issued
        ["B2", "Finished", ts("06:00"), None, ts("06:00"), "FGMOZZ", "GRATING_L4", "BOBOX", "FGMOZZ", "", 350, 0, 400, 1, 0, 400],
        [None] * 7 + ["RMMOZZ", "FGMOZZ", "", 1723.75, 1723.75, 0, 1, 0, 400],
    ]
    out_head = ["Production Order", "Production Order (Output Product)", "Production Order (Output Product Text)",
                "Product", "Product (Text)", "Production Order Creation Date", "Production Order Latest End Date Time",
                "Production Start Date Time", "Planned Quantity", "Open Quantity", "Fulfilled Quantity"]
    outs = [["A1", "FGBLEND", "Blend 5x1kg", "FGBLEND", "Blend", None, ts("07:00"), ts("00:50"), 1000, 0, 400],
            ["B2", "FGMOZZ", "Mozz 5x1kg", "FGMOZZ", "Mozz", None, ts("09:00"), ts("05:40"), 350, 0, 400]]
    j_head = ["Site", "Product", "Identified Stock (Identified Stock ID)", "Logistics Area (Logistics Area ID)",
              "Created On", "Conf.Document Type", "Conf.ID", "Restricted", "Effective Qty"]
    J = []
    add = lambda m, b, area, t, doc, conf, q: J.append(["EXTHQ1", m, b, area, ts(t), doc, conf, "#", q])
    # Cheese for job A: 5,000 kg to the line, 75 kg back
    for i, (m, q) in enumerate([("RMCHED", 1000), ("RMCHED", 500), ("RMMOZZ", 1000), ("RMMOZZ", 1000),
                                ("RMMOZZ", 1000), ("RMMOZZ", 500)]):
        add(m, f"C{i}", "GRATINGLINES", f"0{1 + i // 3}:{10 + i:02d}", GA, f"10{i}", q)
    add("RMCHED", "C1", "FLOOR5", "05:10", GA, "120", 75)
    # Job A output: 4 regular pallets of 100, pallet P1 confirmed twice then corrected, 6 pallets posted in bulk later
    for i, t in enumerate(["01:30", "02:00", "02:30", "03:00"]):
        add("FGBLEND", f"P{i}", "FG_STAGING", t, PC, f"20{i}", 100)
    add("FGBLEND", "P1", "FG_STAGING", "03:30", PC, "210", 100)
    add("FGBLEND", "P1", "FG_STAGING", "13:00", PC, "211", -100)
    for i in range(6):
        add("FGBLEND", f"Q{i}", "FG_STAGING", "07:30", PC, "220", 100)
    # Job B: 2,000 kg mozzarella to the line, 400 cases in 4 pallets
    add("RMMOZZ", "M1", "GRATINGLINES", "05:50", GA, "300", 1000)
    add("RMMOZZ", "M2", "GRATINGLINES", "06:10", GA, "301", 1000)
    for i, t in enumerate(["06:30", "07:00", "07:40", "08:10"]):
        add("FGMOZZ", f"R{i}", "FG_STAGING", t, PC, f"31{i}", 100)
    stock_head = ["Site", "Logistics Area", "Material", "Material (Text)", "Identified Stock (Identified Stock ID)",
                  "Identified Stock (External Identified Stock ID)", "Identified Stock (Production Date)",
                  "Identified Stock (Expiration Date)", "On-Hand Stock UoM", "Expiry date", "Restricted",
                  "Storage Location", "Storage Location (Text)", "On-Hand Stock", "Number of Days to Expire",
                  "Alternative Quantity"]
    stock = [["EXTHQ1", "GRATINGLINES", "RMMOZZ", "Mozz", "M2", "#", None, None, "Kilogram", None, "#", "", "", 40, 90, 0]]
    with pd.ExcelWriter(path) as xw:
        for name, title, head, rows in (("Confirmation Journal", "Confirmation Journal", j_head, J),
                                        ("OUT+IN", "Production Order Output & Input", comp_head, comp),
                                        ("output", "Production Orders", out_head, outs),
                                        ("Stock", "Stock Overview", stock_head, stock)):
            pd.DataFrame([[title] + [None] * (len(head) - 1), head, *rows]).to_excel(
                xw, sheet_name=name, header=False, index=False)


@pytest.fixture(scope="module")
def result(tmp_path_factory):
    path = tmp_path_factory.mktemp("wb") / "SAP_Info.xlsx"
    write_workbook(path)
    return run(read_workbook([str(path)]))


def codes(res, oid):
    return {f.code: f for f in res.findings if f.order_id == oid}


def test_output_matched_by_product_and_time(result):
    a = next(s for s in result.summaries if s["order_id"] == "A1")
    assert a["journal_out"] == 1000 and a["order_out"] == 400
    c = codes(result, "A1")
    assert "OUTPUT_NOT_ON_ORDER" in c and "+600" in c["OUTPUT_NOT_ON_ORDER"].message
    assert "220" in c["OUTPUT_POSTED_IN_BULK_OR_LATE"].message
    assert "P1: 200 cases" in c["PALLET_CONFIRMED_MORE_THAN_ONCE"].message


def test_inputs_judged_on_order_quantities(result):
    c = codes(result, "A1")
    assert "BOBOX 380.00 issued vs 400.00 needed" in c["INPUTS_SHORT_FOR_OUTPUT"].message
    assert c["INPUTS_SHORT_FOR_OUTPUT"].severity == "MEDIUM"
    assert "600 of 1,000 planned cases still open" in c["OUTPUT_STILL_OPEN"].message


def test_cheese_issued_on_order_is_the_truth(result):
    a = next(s for s in result.summaries if s["order_id"] == "A1")
    assert a["cheese_issued_kg"] == pytest.approx(1970) and a["cheese_needed_kg"] == pytest.approx(1970)
    c = codes(result, "A1")
    assert "CHEESE_BALANCES" in c
    assert "RMCHED 0% vs 30% planned" in c["BLEND_SPLIT_OFF"].message
    # cheese moved to the line is shown but never judged
    assert a["cheese_sent_kg"] == pytest.approx(5000)
    assert not any(k.startswith(("CHEESE_CARRIED", "CHEESE_STILL", "NO_CHEESE")) for k in c)


def test_no_cheese_issued_and_over_plan(result):
    c = codes(result, "B2")
    assert c["CHEESE_NOT_ISSUED"].severity == "HIGH" and "1,970.0 kg" in c["CHEESE_NOT_ISSUED"].message
    assert c["OUTPUT_OVER_PLAN"].severity == "MEDIUM" and "+50" in c["OUTPUT_OVER_PLAN"].message
