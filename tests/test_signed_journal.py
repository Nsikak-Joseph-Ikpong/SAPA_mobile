"""Confirmation journals in ByDesign's own export format: signed Effective Qty per
logistics area, no production order column (one journal is pulled per order)."""

import pandas as pd
import pytest

from sap_variance import analyse, load_files, load_settings
from sap_variance.cli import main

HEADERS = ["Site", "Product", "Identified Stock (Identified Stock ID)", "Logistics Area (Logistics Area ID)",
           "Created On", "Conf.Document Type", "Conf.ID", "Effective Qty"]
GA, PC, WH = "Goods and Activity Confirmation", "Production Confirmation", "Warehouse Confirmation"


def row(mat, batch, area, time, doc, conf, qty):
    return ["EXTHQ1", mat, batch, area, f"24.09.2026 {time} GMTUK", doc, conf, qty]


ROWS = [
    # 1,000kg of cheese batch 60001 moved from stores to SL_1
    row("RMMC20BF", "60001", "CHEESE_STORE", "00:05:00", GA, "100", -1000),
    row("RMMC20BF", "60001", "SL_1", "00:05:00", GA, "100", 1000),
    # Two production confirmations on SL_1: 50 cases x 6kg each, 300kg cheese each
    row("RMMC20BF", "60001", "SL_1", "00:30:00", PC, "101", -300),
    row("BO61LB", "49704", "SL_1", "00:30:00", PC, "101", -50),
    row("TSSL20500X", "70001", "FG_STAGING", "00:30:00", PC, "101", 50),
    row("RMMC20BF", "60001", "SL_1", "01:30:00", PC, "102", -300),
    row("BO61LB", "49704", "SL_1", "01:30:00", PC, "102", -50),
    row("TSSL20500X", "70002", "FG_STAGING", "01:30:00", PC, "102", 50),
    # Boxes booked on SL_1 with no output
    row("BO61LB", "49704", "SL_1", "01:45:00", PC, "103", -20),
    # Another product on SL_2 confirmed against the SAME cheese batch, at the same time
    row("RMMC20BF", "60001", "SL_2", "01:00:00", PC, "104", -200),
    row("OTSL20500Y", "70003", "FG_STAGING", "01:00:00", PC, "104", 33),
    # Finished pallets put away / shipped: not consumption
    row("TSSL20500X", "70001", "FG_STAGING", "02:00:00", GA, "105", -50),
    row("TSSL20500X", "70001", "7K05B1", "02:00:00", GA, "105", 50),
    row("TSSL20500X", "70001", "7K05B1", "03:00:00", WH, "106", -50),
    row("TSSL20500X", "70001", "#", "03:00:00", WH, "106", 50),
]


@pytest.fixture()
def files(tmp_path):
    journal = tmp_path / "journal_900.xlsx"
    pd.DataFrame(ROWS, columns=HEADERS).to_excel(journal, index=False)
    orders = tmp_path / "orders.csv"
    orders.write_text("Production Order ID,Material ID,Material Description,Production Order Status,"
                      "Planned Quantity,Fulfilled Quantity,Open Quantity\n"
                      "900,TSSL20500X,Test Sliced 20g 12x500g,Closed,100,100,0\n")
    return journal, orders


def run(paths, orders=None):
    s = load_settings(None)
    return analyse(load_files([str(p) for p in paths], s, orders), s)


def test_order_taken_from_file_name_and_job_selected(files):
    a = run(files)
    r = a.results["900"]
    m = r.metrics
    assert m["fulfilled_qty"] == 100 and m["fg_in_journal"] == 100
    assert m["cheese_issued_kg"] == pytest.approx(600)        # SL_2's 200kg belongs to the other product
    assert m["variance_kg"] == pytest.approx(0)
    assert m["line"] == "SL_1"
    codes = {f.code: f for f in r.flags}
    assert "OTHER_PRODUCTS_IN_JOURNAL" in codes and "OTSL20500Y" in codes["OTHER_PRODUCTS_IN_JOURNAL"].message
    assert "103" in codes["CONFIRMATION_WITHOUT_OUTPUT"].message
    assert codes["BATCH_ON_TWO_LINES"].severity == "HIGH"
    left = codes["LEFTOVER_NOT_RETURNED"]
    assert left.severity == "HIGH" and left.kg == pytest.approx(400)   # 1000 in, 600 used, none returned
    kinds = set(r.components["kind"])
    assert "movement" not in kinds and {"cheese", "packaging", "fg"} <= kinds


def test_journal_order_given_explicitly(files, tmp_path):
    journal, orders = files
    renamed = tmp_path / "conf_jtest.xlsx"
    journal.rename(renamed)
    a = run([renamed, orders], {"conf_jtest.xlsx": "900"})
    assert a.results["900"].metrics["cheese_issued_kg"] == pytest.approx(600)


def test_unknown_product_without_order_list(files):
    journal, _ = files
    a = run([journal])
    codes = {f.code for f in a.results["900"].flags}
    assert "UNKNOWN_PRODUCT" in codes and "NO_ORDER_HEADER" in codes


def test_cli_requires_order_for_orderless_journal(files, tmp_path, capsys):
    journal, orders = files
    renamed = tmp_path / "conf_jtest.xlsx"
    journal.rename(renamed)
    assert main([str(renamed), str(orders), "--all", "--no-excel"]) == 2
    assert "--journal-order" in capsys.readouterr().err
    assert main([str(renamed), str(orders), "-j", "conf_jtest.xlsx=900", "--all", "--no-excel"]) == 0
