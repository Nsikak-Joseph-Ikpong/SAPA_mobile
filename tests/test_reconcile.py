"""Order-vs-journal checks on a workbook shaped like the ByDesign export (made-up numbers)."""

import pandas as pd
import pytest

from sap_variance.reconcile import Rules, consumption_rows, read_workbook, restricted_stock, run

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
    # product weight per case = the case weight, 6 kg ("Slices 6x1kg"), no giveaway added
    # (the recipe would make it (700 cheese - 70 offcuts planned) / 100 cases = 6.3)
    assert m["kg_per_case"] == pytest.approx(6.0) and m["in"] == pytest.approx(720)
    assert m["out"] == pytest.approx(600 + 110) and m["unaccounted"] == pytest.approx(10)
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


@pytest.fixture(scope="module")
def repacked(tmp_path_factory):
    d = tmp_path_factory.mktemp("repack")
    write_workbook(d / "SAP_Info.xlsx")
    write_full_journal(d / "Confirmation_Journal.xlsx")
    head = ["Site", "Product", "Identified Stock (Identified Stock ID)", "Logistics Area (Logistics Area ID)",
            "Created On", "Conf.Document Type", "Conf.ID", "Restricted", "Effective Qty"]
    rows = [["Confirmation Journal"] + [None] * 8, head,
            # 3 minutes after job C starts: 5 cases of an old FGSLICE pallet repacked into it
            ["EXTHQ1", "FGSLICE", "OLD1", "REPACK", ts("09:03"), PC, "605", "#", -5],
            # another product (C isn't a repack job) and a posting long after the start: not repacks of C
            ["EXTHQ1", "FGMOZZ", "R0", "REPACK", ts("09:04"), PC, "606", "#", -2],
            ["EXTHQ1", "FGSLICE", "OLD2", "REPACK", ts("11:00"), PC, "607", "#", -1]]
    pd.DataFrame(rows).to_excel(d / "extra.xlsx", sheet_name="Confirmation Journal", header=False, index=False)
    return run(read_workbook([str(d / "SAP_Info.xlsx"), str(d / "Confirmation_Journal.xlsx"), str(d / "extra.xlsx")]))


def test_repacks_counted_apart_from_cheese(repacked):
    c = next(s for s in repacked.summaries if s["order_id"] == "C3")
    # 5 cases x 6 kg (Slices 6x1kg), weighed by the product's own case weight
    assert c["repacks"] == [{"material": "FGSLICE", "planned": 0.0, "cases": 5.0, "packs_per_case": 6, "source": "journal", "kg_per_case": 6.0,
                             "weight_from": "pack size in the product text", "kg": 30.0}]
    assert c["repack_kg"] == pytest.approx(30) and c["cheese_consumed_kg"] == pytest.approx(720)
    assert c["mass"]["repack_in"] == pytest.approx(30) and c["mass"]["in"] == pytest.approx(750)
    v = c["variance"]
    assert v["cheese_input_kg"] == pytest.approx(720) and v["repack_kg"] == pytest.approx(30)
    assert v["actual_cheese"] == pytest.approx(750)
    assert "FGSLICE 5.00 cases × 6.000 kg = 30.0 kg (journal)" in codes(repacked, "C3")["REPACK_INPUT"].message
    assert {"item": "Repack FGSLICE", "unit": "cases", "planned": 0.0, "actual": 5.0, "source": "journal",
            "open": -5.0} in c["open_status"]
    assert set(repacked.repacks["conf"]) == {"605"}


def test_narrative_summary(repacked):
    c = next(s for s in repacked.summaries if s["order_id"] == "C3")
    assert c["narrative"].startswith(
        "Regarding job C3 (FGSLICE, Slices 6x1kg), I found from consumption matched to the job by line and time that "
        "the total input is 750 kg: 720 kg of cheese blocks and 30 kg of repacks: 30 packs of FGSLICE (5 cases).")
    assert "The plan was 100 cases (100 × 6 kg = 600 kg) and 100 cases were made (100 × 6 kg = 600 kg), plus 110 kg of offcuts." in c["narrative"]
    assert "40 kg of cheese has no output and is unaccounted for." in c["narrative"]
    assert "giveaway, so" not in c["narrative"] and "Also:" not in c["narrative"]


@pytest.fixture(scope="module")
def referenced(tmp_path_factory):
    d = tmp_path_factory.mktemp("ref")
    write_workbook(d / "SAP_Info.xlsx")
    write_full_journal(d / "Confirmation_Journal.xlsx")
    head = ["Site", "Product", "Identified Stock (Identified Stock ID)", "Logistics Area (Logistics Area ID)",
            "Created On", "Conf.Document Type", "Conf.ID", "Reference Document ID", "Effective Qty"]
    rows = [["Confirmation Journal"] + [None] * 8, head,
            # the 900 kg of M1 at 07:00 that line-and-time matching gives to job B names job A
            ["EXTHQ1", "RMMOZZ", "M1", "GRATINGLINES", ts("07:00"), PC, "501", "A1", -900],
            # 30 kg consumed for job C long after its last pallet: only the reference ties it to C
            ["EXTHQ1", "RMSLICE", "K2", "SL_1", ts("13:00"), PC, "620", "C3", -30],
            # on a goods-and-activity confirmation the reference is another document, not an order
            ["EXTHQ1", "RMSLICE", "K2", "FLOOR5", ts("12:50"), GA, "619", "C3", -30]]
    pd.DataFrame(rows).to_excel(d / "journal2.xlsx", sheet_name="Confirmation Journal with ref", header=False,
                                index=False)
    return run(read_workbook([str(d / "SAP_Info.xlsx"), str(d / "Confirmation_Journal.xlsx"), str(d / "journal2.xlsx")]))


def test_order_reference_is_ground_truth(referenced):
    s = {x["order_id"]: x for x in referenced.summaries}
    assert s["A1"]["cheese_consumed_kg"] == pytest.approx(1925 + 900)
    assert s["B2"]["cheese_consumed_kg"] == pytest.approx(1000)
    assert s["C3"]["cheese_consumed_kg"] == pytest.approx(750)
    assert s["A1"]["consumption_from"] == "order reference in the journal + matched by line and time"
    c = referenced.consumption
    assert set(c.loc[c["via"] == "reference", "conf"]) == {"501", "620"}
    assert ("confirmation journal (confirmations referencing this order) and consumption matched to the job by line "
            "and time") in s["C3"]["narrative"]


@pytest.fixture(scope="module")
def odd_pallets(tmp_path_factory):
    d = tmp_path_factory.mktemp("odd")
    write_workbook(d / "SAP_Info.xlsx")
    head = ["Site", "Product", "Identified Stock (Identified Stock ID)", "Logistics Area (Logistics Area ID)",
            "Created On", "Conf.Document Type", "Conf.ID", "Restricted", "Effective Qty"]
    # job A's usual pallet is 100 cases; two more pallets off that count, one of them posted on the line's area
    rows = [["Confirmation Journal"] + [None] * 8, head,
            ["EXTHQ1", "FGBLEND", "X1", "FG_STAGING", ts("03:45"), PC, "250", "#", 40],
            ["EXTHQ1", "FGBLEND", "X2", "GRATINGLINES", ts("03:50"), PC, "251", "#", 7]]
    pd.DataFrame(rows).to_excel(d / "extra.xlsx", sheet_name="Confirmation Journal", header=False, index=False)
    return run(read_workbook([str(d / "SAP_Info.xlsx"), str(d / "extra.xlsx")]))


def test_pallets_off_the_usual_count_and_on_a_line_area(odd_pallets, result):
    c = codes(odd_pallets, "A1")
    f = c["PALLET_QUANTITIES_IRREGULAR"]
    assert f.severity == "HIGH" and "Usual pallet for FGBLEND is 100 cases, but 2 pallets aren't: X1 40, X2 7." in f.message
    assert "UNUSUAL_PALLET_SIZE" not in c
    assert c["OUTPUT_ON_LINE_AREA"].message == ("Output posted to a line area instead of FG_STAGING: 251 at 19.08 03:50 "
                                               "(7 on pallet X2, GRATINGLINES).")
    a = next(s for s in odd_pallets.summaries if s["order_id"] == "A1")
    assert a["irregular_pallets"] == ["X1", "X2"]
    # the plain workbook: every pallet at the usual count, none on a line area
    assert not {"PALLET_QUANTITIES_IRREGULAR", "OUTPUT_ON_LINE_AREA"} & set(codes(result, "A1"))


def test_summary_says_job_ran_out_of_cheese_only_when_far_short(full):
    s = {x["order_id"]: x for x in full.summaries}
    # A1: 400 of 1,000 cases made and 1,925 of 4,925 kg of cheese in (about what 400 cases need)
    assert ("Only 400 of the 1,000 cases planned were made, and only 1,925 kg of the 4,925 kg of cheese planned went in, "
            "so it looks like the job ran out of cheese.") in s["A1"]["narrative"]
    # B2 made more than planned, C3 made the plan: nothing about running out
    assert "ran out of cheese" not in s["B2"]["narrative"] and "ran out of cheese" not in s["C3"]["narrative"]


def test_same_order_sheet_in_two_files_is_not_counted_twice(tmp_path):
    # a newer export of the order inputs next to SAP_Info: each order's lines come from the latest file only
    write_workbook(tmp_path / "SAP_Info.xlsx")
    write_full_journal(tmp_path / "Confirmation_Journal.xlsx")
    comp = pd.read_excel(tmp_path / "SAP_Info.xlsx", sheet_name="OUT+IN", header=None)
    comp.loc[comp[7] == "RMSLICE", 10] = 800            # job C's cheese plan changed in the newer export
    comp.to_excel(tmp_path / "input_output.xlsx", sheet_name="Production order input-output", header=False, index=False)
    res = run(read_workbook([str(tmp_path / f) for f in ("SAP_Info.xlsx", "Confirmation_Journal.xlsx", "input_output.xlsx")]))
    s = {x["order_id"]: x for x in res.summaries}
    assert s["C3"]["cheese_planned_kg"] == pytest.approx(800)                      # not 700 + 800, and the newer value
    assert s["A1"]["cheese_planned_kg"] == pytest.approx(1477.5 + 3447.5)          # not doubled
    assert sum(1 for c in s["A1"]["components"] if c["material"] == "BOBOX") == 1


def test_offcut_bin_put_back_is_a_reversal_not_offcuts_made():
    # job 2173: bin batches consumed, most put back later on the same order (same weight, positive);
    # a positive row on a bin batch the order never consumed is offcuts made
    t = lambda hm: pd.Timestamp(f"2026-09-29 {hm}")
    rows = [("MBMJOFF", "55459", "2173", t("08:22"), -9.69), ("MBMJOFF", "55459", "2173", t("08:55"), 9.69),
            ("MBMJOFF", "55642", "2173", t("08:16"), -9.72),
            ("MBMJOFF", "55653", "2173", t("08:17"), -9.83),
            ("MBMJOFF", "55472", "2173", t("08:23"), -9.83), ("MBMJOFF", "55472", "2173", t("08:53"), 9.83),
            ("MBMJOFF", "90001", "2173", t("09:30"), 12.00),     # new bin: offcuts made
            ("MBMJOFF", "55642", "9999", t("09:40"), 9.72)]      # another order: not this order's reversal
    j = pd.DataFrame(rows, columns=["material", "batch", "ref", "time", "qty"]).assign(is_prod=True)
    c = consumption_rows(j, Rules())
    assert c["qty"].sum() == pytest.approx(-(9.72 + 9.83))
    assert set(c.loc[c["qty"] > 0, "batch"]) == {"55459", "55472"}
    # without an order reference a bin filled and emptied by different jobs can't be told from a reversal
    c2 = consumption_rows(j.assign(ref=None), Rules())
    assert (c2["qty"] > 0).sum() == 0


@pytest.fixture(scope="module")
def restricted(tmp_path_factory):
    d = tmp_path_factory.mktemp("restricted")
    write_workbook(d / "SAP_Info.xlsx")
    write_full_journal(d / "Confirmation_Journal.xlsx")
    head = ["Site", "Product", "Identified Stock (Identified Stock ID)", "Logistics Area (Logistics Area ID)",
            "Created On", "Conf.Document Type", "Conf.ID", "Reference Document ID", "Restricted", "Effective Qty"]
    rows = [["Confirmation Journal"] + [None] * 9, head,
            ["EXTHQ1", "RMMOZZ", "M1", "GRATINGLINES", ts("07:00"), PC, "501", "A1", "#", -900],
            # job A's cheese batch put on restricted (X) afterwards, and an unrelated restricted batch
            ["EXTHQ1", "RMMOZZ", "M1", "EDH01-REGRADING", ts("23:59"), GA, "900", "#", "X", 50],
            ["EXTHQ1", "RMBIR20EX", "80000075090", "EDH01-REGRADING", ts("23:58"), GA, "901", "#", "X", 20],
            # unrestricted: a move with "#" in the Restricted column
            ["EXTHQ1", "BUSL108RM", "46209", "EDH01-REGRADING", ts("15:10"), "Warehouse Confirmation", "902", "2141", "#", -60]]
    pd.DataFrame(rows).to_excel(d / "journal2.xlsx", sheet_name="Confirmation Journal", header=False, index=False)
    wb = read_workbook([str(d / "SAP_Info.xlsx"), str(d / "Confirmation_Journal.xlsx"), str(d / "journal2.xlsx")])
    return wb, run(wb)


def test_restricted_stock_is_flagged_on_the_orders_that_used_it(restricted):
    wb, res = restricted
    r = restricted_stock(wb.journal)
    assert list(zip(r["material"], r["batch"])) == [("RMBIR20EX", "80000075090"), ("RMMOZZ", "M1")]
    f = codes(res, "A1")["RESTRICTED_STOCK"]
    assert f.severity == "HIGH"
    assert f.message == ("Restricted stock on 1 batch(es) this job made or used: RMMOZZ M1 50.00 at EDH01-REGRADING "
                         "19.08 23:59 (Goods and Activity Confirmation 900).")
    assert "RESTRICTED_STOCK" not in codes(res, "C3")


def test_restricted_status_change_survives_a_journal_without_the_column():
    # put on restricted: -789.82 unrestricted and +789.82 restricted on one posting; an export without the
    # Restricted column nets them to a single 0 row
    from sap_variance.reconcile import _merge_journals
    t = pd.Timestamp("2026-08-03 09:31")
    cols = ["conf", "material", "batch", "area", "time", "doc", "qty", "is_prod"]
    big = pd.DataFrame([["47", "RMRF20EX50", "80000084869", "5F05B3", t, GA, 0.0, False],
                        ["48", "RMMOZZ", "M1", "GRATINGLINES", t, PC, -10.0, True]], columns=cols)
    small = pd.DataFrame([["47", "RMRF20EX50", "80000084869", "5F05B3", t, GA, -789.82, False, False],
                          ["47", "RMRF20EX50", "80000084869", "5F05B3", t, GA, 789.82, False, True]],
                         columns=cols + ["restricted"])
    m = _merge_journals([big, pd.concat([small] * 3, ignore_index=True).iloc[:2]])
    assert len(m) == 3 and m["qty"].sum() == pytest.approx(-10.0)
    r = restricted_stock(m)
    assert list(r["qty"]) == [789.82] and list(r["batch"]) == ["80000084869"]


def test_offsetting_variances_on_the_same_line_are_paired():
    # jobs 2484 and 2443: same line and cheese at the same time, one 567.3 kg in with no output, the other
    # 502.7 kg more out than in; a third job on another line with the opposite variance is not paired
    from sap_variance.reconcile import Finding, pair_offsetting
    t = lambda hm: pd.Timestamp(f"2026-10-05 {hm}")
    def s(oid, line, start, end, mat, unacc):
        return {"order_id": oid, "fg": "FG" + oid, "line": line, "area": None, "start": t(start), "last_regular_output": t(end),
                "cheese_consumed_by_material": {mat: 1000.0}, "components": [], "narrative": "N.",
                "mass": {"unaccounted": unacc, "tolerance": 50.0}, "cheese_diff_kg": None, "cheese_tolerance_kg": None}
    a = s("2484", "SLICING_L1", "07:56", "09:53", "RMRMED20FF", 567.27)
    b = s("2443", "SLICING_L1", "09:07", "23:32", "RMRMED20FF", -502.74)
    c = s("9001", "SLICING_L2", "09:00", "10:00", "RMRMED20FF", -560.0)
    f = pair_offsetting([a, b, c], [Finding("2484", "INFO", "X", "")], Rules())
    off = {x.order_id: x.message for x in f if x.code == "OFFSETTING_VARIANCE"}
    assert set(off) == {"2484", "2443"}
    assert off["2484"] == ("Job 2443 (FG2443) ran on SLICING_L1 at the same time with the same cheese (RMRMED20FF): on this "
                           "job 567.3 kg went in with no output; on 2443 502.7 kg more came out than went in. Together they're "
                           "off by only +64.5 kg, so cheese booked to one job was probably used by the other: compare the two.")
    assert a["linked"]["order_id"] == "2443" and b["linked"]["order_id"] == "2484" and "linked" not in c


def test_more_out_than_in_is_flagged_within_tolerance(tmp_path):
    # job 2571: 1,141 cases of 6x1kg (6,846 kg at pack weight) and 760.12 kg of offcuts from 7,502 kg of cheese: 104.1 kg
    # more out than in. The cases count at the pack weight (no recipe giveaway), and more out than in is flagged even
    # though it's within the 5% tolerance.
    t = lambda h: f"10.10.2026 {h:02d}:00:00 GMTUK"
    comp_head = ["Production Order ID", "Production Order Status", "Earliest Start Date Time", "Requested Start Date",
                 "Requested Start Date Time", "Output Product ID", "Resource ID", "Input Material ID", "Output Material ID",
                 "Output Material ID (Text)", "Planned Quantity", "Open Quantity", "Fulfilled Quantity", "Counter",
                 "Open Quantity", "Fulfilled Quantity"]
    comp = [["2571", "Finished", t(6), None, t(6), "MASL2061EX", "SLICING_L2", "RMMA20BF", "MASL2061EX", None, 7465.9, 0, 7502, 1, 0, 1141]]
    out_head = ["Production Order", "Production Order (Output Product)", "Production Order (Output Product Text)", "Product",
                "Product (Text)", "Production Order Creation Date", "Production Order Latest End Date Time",
                "Production Start Date Time", "Planned Quantity", "Open Quantity", "Fulfilled Quantity"]
    outs = [["2571", "MASL2061EX", "Mature Sliced Cheddar 6x1kg", "MASL2061EX", "Mature Sliced Cheddar 6x1kg", None, t(23), t(6), 1120, 0, 1141],
            [None, None, None, "MBSLOFF", "Slicing offcuts", None, None, None, 672, 0, 760.12]]
    j_head = ["Site", "Product", "Identified Stock (Identified Stock ID)", "Logistics Area (Logistics Area ID)", "Created On",
              "Conf.Document Type", "Conf.ID", "Reference Document ID", "Restricted", "Effective Qty"]
    J = [["EXTHQ1", "RMMA20BF", "X1", "SL_2", t(5), GA, "1", "#", "#", 7502],
         ["EXTHQ1", "RMMA20BF", "X1", "SL_2", t(20), PC, "2", "2571", "#", -7502]]
    left, i = 1141, 0
    while left > 0:
        q = min(104, left); left -= q
        J.append(["EXTHQ1", "MASL2061EX", f"P{i}", "FG_STAGING", t(7 + i), PC, str(10 + i), "2571", "#", q]); i += 1
    J.append(["EXTHQ1", "MBSLOFF", "OFF1", "SL_2", t(20), PC, "99", "2571", "#", 760.12])
    path = tmp_path / "job2571.xlsx"
    with pd.ExcelWriter(path) as xw:
        for name, head, rows in [("OUT+IN", comp_head, comp), ("output", out_head, outs), ("Confirmation Journal", j_head, J)]:
            pd.DataFrame([[name] + [None] * (len(head) - 1), head, *rows]).to_excel(xw, sheet_name=name, header=False, index=False)
    res = run(read_workbook([str(path)]))
    s = next(x for x in res.summaries if x["order_id"] == "2571")
    assert s["mass"]["kg_per_case"] == pytest.approx(6.0)
    assert s["mass"]["unaccounted"] == pytest.approx(7502 - 1141 * 6 - 760.12)
    assert s["variance"]["variance_kg"] == pytest.approx(s["variance"]["ga_actual"])
    f = codes(res, "2571")
    assert "MASS_OUT_EXCEEDS_IN" in f and f["MASS_OUT_EXCEEDS_IN"].severity == "MEDIUM" and "MASS_BALANCES" not in f
    assert "within the 5% tolerance" in f["MASS_OUT_EXCEEDS_IN"].message
    # and the possible reasons look for a cause rather than calling it within tolerance
    texts = " ".join(x["text"] for x in s["variance_reasons"])
    assert "nothing to explain" not in texts and "Offcuts declared are 75.5 kg above expected" in texts
