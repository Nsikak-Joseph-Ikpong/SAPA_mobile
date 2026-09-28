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
        # Job C on a slicing line: 100 cases, 700 kg cheese planned of which 70 kg comes back as offcuts
        ["C3", "Finished", ts("09:00"), None, ts("09:00"), "FGSLICE", "SLICING_L1", "BOBOX", "FGSLICE", "", 100, 0, 100, 1, 0, 100],
        [None] * 7 + ["RMSLICE", "FGSLICE", "", 700, 700, 0, 1, 0, 100],
    ]
    out_head = ["Production Order", "Production Order (Output Product)", "Production Order (Output Product Text)",
                "Product", "Product (Text)", "Production Order Creation Date", "Production Order Latest End Date Time",
                "Production Start Date Time", "Planned Quantity", "Open Quantity", "Fulfilled Quantity"]
    outs = [["A1", "FGBLEND", "Blend 5x1kg", "FGBLEND", "Blend", None, ts("07:00"), ts("00:50"), 1000, 0, 400],
            ["B2", "FGMOZZ", "Mozz 5x1kg", "FGMOZZ", "Mozz", None, ts("09:00"), ts("05:40"), 350, 0, 400],
            ["C3", "FGSLICE", "Slices 6x1kg", "FGSLICE", "Slices", None, ts("12:00"), ts("09:00"), 100, 0, 100],
            [None, None, None, "MBSLOFF", "Bin 9 slicing offcuts", None, None, None, 70, 0, 110]]
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
    add("FGSLICE", "S1", "FG_STAGING", "10:00", PC, "600", 100)
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


def test_no_cheese_on_order_sheet_falls_back_to_journal_estimate(result):
    b = next(s for s in result.summaries if s["order_id"] == "B2")
    assert b["cheese_source"] == "journal" and b["cheese_used_kg"] == pytest.approx(2000)
    c = codes(result, "B2")
    assert "CHEESE_NOT_ON_ORDER_SHEET" in c and "CHEESE_BALANCES_EST" in c
    assert "400 cases in the journal need 1,970.0 kg" in c["CHEESE_BALANCES_EST"].message
    assert c["OUTPUT_OVER_PLAN"].severity == "MEDIUM" and "+50" in c["OUTPUT_OVER_PLAN"].message


def write_full_journal(path):
    """A separate journal export with both sides (as ByDesign's Confirmation Journal export): header on
    row 7 after a title block, a blank first column, moves out as negatives, cheese consumed as its own
    production confirmation."""
    head = [None, "Site", "Product", "Identified Stock ID", "Logistics Area ID", "Created On",
            "Conf.Document Type", "Conf.ID", "Effective Qty"]
    rows = [[None, "Confirmation Journal"] + [None] * 7, [None] * 9,
            [None, "Sent at: ", "20.08.2026 06:40:37 GMTUK"] + [None] * 6, [None] * 9, [None] * 9, [None] * 9, head]
    add = lambda m, b, area, t, doc, conf, q: rows.append([None, "EXTHQ1", m, b, area, ts(t), doc, conf, q])
    # the same moves to the line as the workbook's journal, now with their "from" side
    for i, (m, q) in enumerate([("RMCHED", 1000), ("RMCHED", 500), ("RMMOZZ", 1000), ("RMMOZZ", 1000),
                                ("RMMOZZ", 1000), ("RMMOZZ", 500)]):
        t = f"0{1 + i // 3}:{10 + i:02d}"
        add(m, f"C{i}", "FLOOR5", t, GA, f"10{i}", -q)
        add(m, f"C{i}", "GRATINGLINES", t, GA, f"10{i}", q)
    # job A consumes 1,925 kg: 30/70 recipe but only 400 kg cheddar
    add("RMCHED", "C0", "GRATINGLINES", "01:20", PC, "400", -400)
    add("RMMOZZ", "C2", "GRATINGLINES", "01:21", PC, "401", -1000)
    add("RMMOZZ", "C3", "GRATINGLINES", "02:20", PC, "402", -600)
    add("RMMOZZ", "C3", "GRATINGLINES", "02:40", PC, "403", 75)          # reversal of part of C3
    # job B: 1,000 kg consumed at 05:50, 20 min before B2's regular start is covered by its window;
    # batch M1 is consumed twice (1,000 + 900) though the pallet held 1,000
    add("RMMOZZ", "M1", "GRATINGLINES", "05:50", GA, "300", 1000)
    add("RMMOZZ", "M1", "GRATINGLINES", "05:55", PC, "500", -1000)
    add("RMMOZZ", "M1", "GRATINGLINES", "07:00", PC, "501", -900)
    for i, t in enumerate(["06:30", "07:00", "07:40", "08:10"]):
        add("FGMOZZ", f"R{i}", "FG_STAGING", t, PC, f"31{i}", 100)
    # job C slices 720 kg; its offcut bins are posted where they're stored, on GRATINGLINES
    add("RMSLICE", "K1", "SL_1", "09:05", PC, "610", -720)
    add("MBSLOFF", "B1", "GRATINGLINES", "09:40", PC, "611", 110)
    pd.DataFrame(rows).to_excel(path, sheet_name="Export 20.08.2026", header=False, index=False)


@pytest.fixture(scope="module")
def full(tmp_path_factory):
    d = tmp_path_factory.mktemp("full")
    write_workbook(d / "SAP_Info.xlsx")
    write_full_journal(d / "Confirmation_Journal.xlsx")
    return run(read_workbook([str(d / "SAP_Info.xlsx"), str(d / "Confirmation_Journal.xlsx")]))


def test_cheese_consumption_from_full_journal(full):
    a = next(s for s in full.summaries if s["order_id"] == "A1")
    assert a["cheese_source"] == "consumed" and a["cheese_consumed_kg"] == pytest.approx(1925)
    c = codes(full, "A1")
    # needed for the 1,000 cases in the journal is 4,925 kg
    assert c["CHEESE_UNDER_USED"].severity == "HIGH" and "RMCHED 400.0 of 1,477.5 kg" in c["CHEESE_UNDER_USED"].message
    assert "RMCHED 21% vs 30% planned" in c["BLEND_SPLIT_OFF"].message
    # outputs from the workbook's journal are not double counted by the second export
    assert a["journal_out"] == 1000


def test_batch_consumed_twice(full):
    b = next(s for s in full.summaries if s["order_id"] == "B2")
    assert b["cheese_consumed_kg"] == pytest.approx(1900)
    assert "RMMOZZ M1 consumed 1,900.00 kg" in codes(full, "B2")["BATCH_OVER_CONSUMED"].message


def test_mass_balance_with_offcuts(full):
    c = next(s for s in full.summaries if s["order_id"] == "C3")
    m = c["mass"]
    # product weight per case = (700 cheese - 70 offcuts planned) / 100 cases
    assert m["kg_per_case"] == pytest.approx(6.3) and m["in"] == pytest.approx(720)
    assert m["out"] == pytest.approx(630 + 110) and m["unaccounted"] == pytest.approx(-20)
    f = codes(full, "C3")
    assert "MASS_BALANCES" in f and "CHEESE_BALANCES" in f
    assert "15.3% of what went in against 10.0% planned" in f["OFFCUTS_OVER_PLAN"].message


def test_offcuts_used_as_input_count_as_cheese(full):
    a = next(s for s in full.summaries if s["order_id"] == "A1")
    assert a["mass"]["blocks_in"] == pytest.approx(1925) and a["mass"]["offcuts_in"] == 0


def write_fulfilment(path):
    """A production order fulfilment export: input confirmations per production lot, quantities in kg in the
    Inventory Valuation Qty column (Confirmed Qty can be in blocks)."""
    head = ["Production Lot", "Output Product", "Output Product (Text)", "Input Product", "Conf.ID",
            "Input Product Planned Quantity", "Confirmed Qty", "Inventory Valuation Qty"]
    rows = [["Production Order Fulfillment"] + [None] * 7, head,
            ["B2", "FGMOZZ", "Mozz 5x1kg", "RMMOZZ", "500", 1723.75, 50, 1000],       # in the journal (batch M1)
            [None, None, None, None, "999", 1723.75, 45, 950],                        # posted after the journal export
            [None, None, None, "BOBOX", "310", 350, 100, 100]]
    pd.DataFrame(rows).to_excel(path, sheet_name="Production Order Fulfillment", header=False, index=False)


@pytest.fixture(scope="module")
def with_fulfilment(tmp_path_factory):
    d = tmp_path_factory.mktemp("fulfil")
    write_workbook(d / "SAP_Info.xlsx")
    write_full_journal(d / "Confirmation_Journal.xlsx")
    write_fulfilment(d / "fulfilment.xlsx")
    return run(read_workbook([str(d / p) for p in ("SAP_Info.xlsx", "Confirmation_Journal.xlsx", "fulfilment.xlsx")]))


def test_fulfilment_gives_consumption_per_order(with_fulfilment):
    b = next(s for s in with_fulfilment.summaries if s["order_id"] == "B2")
    assert b["consumption_from"] == "order fulfilment report"
    # 1,000 kg matched to batch M1 in the journal + 950 kg not in the journal; the 900 kg posting the time
    # matching gave B2 before isn't counted (the report doesn't tie it to B2)
    assert b["cheese_consumed_kg"] == pytest.approx(1950)
    rows = with_fulfilment.consumption[with_fulfilment.consumption["order_id"] == "B2"]
    assert set(rows["batch"].dropna()) == {"M1"} and set(rows["via"]) == {"fulfilment"}
    a = next(s for s in with_fulfilment.summaries if s["order_id"] == "A1")
    assert a["consumption_from"] == "matched by line and time" and a["cheese_consumed_kg"] == pytest.approx(1925)


@pytest.fixture(scope="module")
def double_booked(tmp_path_factory):
    d = tmp_path_factory.mktemp("double")
    write_workbook(d / "SAP_Info.xlsx")
    head = ["Site", "Product", "Identified Stock (Identified Stock ID)", "Logistics Area (Logistics Area ID)",
            "Created On", "Conf.Document Type", "Conf.ID", "Restricted", "Effective Qty"]
    # pallet P9 of job A confirmed twice (100 + 100 on a usual 100-case pallet) and never corrected
    rows = [["Confirmation Journal"] + [None] * 8, head,
            ["EXTHQ1", "FGBLEND", "P9", "FG_STAGING", ts("03:40"), PC, "240", "#", 100],
            ["EXTHQ1", "FGBLEND", "P9", "FG_STAGING", ts("04:10"), PC, "241", "#", 100]]
    pd.DataFrame(rows).to_excel(d / "extra.xlsx", sheet_name="Confirmation Journal", header=False, index=False)
    return run(read_workbook([str(d / "SAP_Info.xlsx"), str(d / "extra.xlsx")]))


def test_pallet_double_booked_is_high(double_booked):
    c = codes(double_booked, "A1")
    f = c["PALLET_DOUBLE_BOOKED"]
    assert f.severity == "HIGH" and "Pallet P9 has 200 cases (2.0x the usual)" in f.message
    assert "240 at 19.08 03:40 (100); 241 at 19.08 04:10 (100)" in f.message and "overstated by about 100" in f.message
    # P1 was confirmed twice but corrected, so it stays a medium finding
    assert "P1: 200 cases confirmed on one pallet, corrected to 100" in c["PALLET_CONFIRMED_MORE_THAN_ONCE"].message
    a = next(s for s in double_booked.summaries if s["order_id"] == "A1")
    assert a["double_booked_pallets"] == ["P9"]
