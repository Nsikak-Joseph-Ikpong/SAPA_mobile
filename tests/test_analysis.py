import pandas as pd
import pytest

from sap_variance import analyse, load_files, load_settings
from sap_variance.cli import main
from sap_variance.loader import parse_sheet, to_number
from sap_variance.products import parse_blend, parse_pack_kg
from sap_variance.sample_data import write_sample_files


@pytest.fixture(scope="module")
def analysis(tmp_path_factory):
    folder = tmp_path_factory.mktemp("sample")
    write_sample_files(folder)
    settings = load_settings(None)
    return analyse(load_files([str(folder)], settings), settings)


def codes(analysis, oid):
    return {f.code for f in analysis.results[oid].flags}


def test_order_589_matches_hand_calculation(analysis):
    m = analysis.results["589"].metrics
    assert m["cheese_issued_kg"] == pytest.approx(11171.55)
    assert m["expected_cheese_kg"] == pytest.approx(2413.25)
    assert m["variance_kg"] == pytest.approx(8758.30)
    assert {"ISSUED_TO_PLAN", "CLOSED_SHORT", "NOT_CLOSED"} <= codes(analysis, "589")


def test_order_783_uses_fulfilled_not_planned(analysis):
    m = analysis.results["783"].metrics
    assert m["expected_cheese_kg"] == pytest.approx(720 * 5 * 0.985)
    assert m["variance_kg"] == pytest.approx(2164.09 - 3546.0)
    assert "CHEESE_UNDER_ISSUED" in codes(analysis, "783")


def test_order_746_sliced_has_no_starch(analysis):
    m = analysis.results["746"].metrics
    assert m["pack_kg"] == 6 and m["starch_pct"] == 0
    assert m["variance_kg"] == pytest.approx(3829.44 - 6048)
    assert {"CHEESE_UNDER_ISSUED", "SOURCE_CONFLICT", "OVER_PRODUCED"} <= codes(analysis, "746")


def test_order_114_balances_with_offcuts_and_reversal(analysis):
    r = analysis.results["114"]
    assert r.metrics["variance_kg"] == pytest.approx(0)
    assert not [f for f in r.flags if f.severity in ("HIGH", "MEDIUM")]
    assert "REVERSALS" in codes(analysis, "114")
    kinds = dict(zip(r.components["material_id"], r.components["kind"]))
    assert kinds["PKBOX12"] == "packaging" and kinds["OCMC001"] == "offcut" and kinds["MISL20121NA"] == "fg"


def test_blend_and_no_issue_checks(analysis):
    assert "HALF_ISSUED_BLEND" in codes(analysis, "1400")
    assert {"NO_CHEESE_ISSUED", "HALF_ISSUED_BLEND"} <= codes(analysis, "1482")
    assert "HALF_ISSUED_BLEND" not in codes(analysis, "589")  # 67/33 is within tolerance of 70/30


def test_cross_order_swap_found(analysis):
    pair = analysis.swaps.iloc[0]
    assert {pair["order_a"], pair["order_b"]} == {"1439", "1466"}
    assert "17001" in pair["shared_batches"]
    swap_flag = next(f for f in analysis.results["1439"].flags if f.code == "CROSS_ORDER_SWAP")
    assert swap_flag.related_orders == "1466"


def test_journal_only_order(analysis):
    assert "NO_ORDER_HEADER" in codes(analysis, "2001")


def test_requested_subset_still_cross_references(tmp_path):
    write_sample_files(tmp_path)
    settings = load_settings(None)
    a = analyse(load_files([str(tmp_path)], settings), settings, ["1439", "999"])
    assert a.requested == ["1439"] and a.missing == ["999"]
    assert "CROSS_ORDER_SWAP" in {f.code for f in a.flags}


def test_cli_writes_excel(tmp_path, capsys):
    write_sample_files(tmp_path / "in")
    out = tmp_path / "report.xlsx"
    assert main([str(tmp_path / "in"), "--orders", "589, 783", "--excel", str(out)]) == 0
    assert "ISSUED_TO_PLAN" in capsys.readouterr().out
    sheets = pd.read_excel(out, sheet_name=None)
    assert set(sheets["Flags"]["Order"].astype(str)) == {"589", "783"}
    assert "Reason code" in sheets["Flags"].columns


@pytest.mark.parametrize("text,expected", [
    ("2,254.00", 2254.0), ("1.234,50", 1234.5), ("3,5", 3.5), ("12.5-", -12.5), ("(40)", -40.0), ("", None),
])
def test_to_number(text, expected):
    value = to_number(text)
    assert (value != value) if expected is None else value == pytest.approx(expected)


@pytest.mark.parametrize("desc,kg", [
    ("Nandos Mild Sliced Cheddar 20g 12x1kg", 12), ("Everyday Fav Grated Mild White 5x1", 5),
    ("Sliced Cheddar 20g 12x500g", 6), ("Red & White 50/50 2kg", 2), ("Everyday Favourites Grated Mozzare", None),
])
def test_parse_pack_kg(desc, kg):
    assert parse_pack_kg(desc) == kg


def test_parse_blend():
    assert parse_blend("Mozzarella/Cheddar 70/30") == (0.7, 0.3)
    assert parse_blend(None, "MCGR155EF7030") == (0.7, 0.3)
    assert parse_blend("Mild White 5x1", "WHGR155EF") is None


def test_header_detection_skips_title_rows_and_custom_alias(tmp_path):
    raw = pd.DataFrame([
        ["My report", None, None],
        ["Job", "Planned", "Made"],
        ["589", "2,254", "490"],
    ])
    settings = load_settings(None)
    settings.column_aliases["planned_qty"].append("planned")
    settings.column_aliases["fulfilled_qty"].append("made")
    table = parse_sheet(raw, "x.xlsx", "Sheet1", settings)
    assert table.kind == "orders" and table.header_row == 2
    assert table.df.loc[0, "planned_qty"] == 2254
