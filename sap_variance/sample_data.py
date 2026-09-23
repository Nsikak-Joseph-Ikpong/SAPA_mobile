"""Write demo spreadsheets shaped like SAP ByDesign exports.

Orders 589, 746 and 783 use the figures from the hand-worked examples; the
rest demonstrate each check. Run:  python -m sap_variance.sample_data [folder]
"""

from __future__ import annotations

import sys
from pathlib import Path

import pandas as pd

ORDER_HEADERS = ["Production Order ID", "Required On (Date)", "Material ID", "",
                 "Production Order Status", "Planned Quantity", "Fulfilled Quantity", "Open Quantity"]

ORDERS = [
    ["114", "05.08.2026", "MISL20121NA", "Nandos Mild Sliced Cheddar 20g 12x1kg", "Started", "700.00", "707.00", "0.00"],
    ["589", "19.08.2026", "MCGR155EF7030", "29716 Everyday Favourites Grated Mozzare", "Started", "2,254.00", "490.00", "0.00"],
    ["746", "20.08.2026", "SMSL20500BK", "Smoked Sliced Cheddar 20g 12x500g", "Started", "852.00", "1,008.00", "0.00"],
    ["783", "21.08.2026", "MAGR155BA", "Grated Mozzarella 5x1kg", "Closed", "686.00", "720.00", "0.00"],
    ["1400", "08.09.2026", "RWGR262BF5050", "Red & White Grated 50/50 6x2kg", "Closed", "214.00", "214.00", "0.00"],
    ["1439", "09.09.2026", "WHGR155EF", "Everyday Fav Grated Mild White 5x1", "Closed", "700.00", "700.00", "0.00"],
    ["1466", "11.09.2026", "WHGR155EF", "Everyday Fav Grated Mild White 5x1", "Closed", "500.00", "500.00", "0.00"],
    ["1482", "12.09.2026", "MCGR155BA7030", "Grated Mozzarella/Cheddar 70/30 5x1kg", "Closed", "126.00", "126.00", "0.00"],
]

# A second export that disagrees with the first on order 746's planned quantity
SECOND_ORDERS = [
    ["746", "20.08.2026", "SMSL20500BK", "Smoked Sliced Cheddar 20g 12x500g", "Started", "850.00", "1,008.00", "0.00"],
]

JOURNAL_HEADERS = ["Production Order ID", "Confirmation ID", "Posting Date", "Material ID",
                   "Material Description", "Identified Stock", "Input/Output", "Confirmed Quantity",
                   "Unit of Measure", "Reversed", "Created By"]


def _journal_rows() -> list[list]:
    rows = []

    def add(order, date, material, desc, batch, direction, qty, uom="kg", reversed_=""):
        conf = f"C{len(rows) + 1:05d}"
        rows.append([order, conf, date, material, desc, batch, direction, qty, uom, reversed_, "OPERATOR1"])

    ched, mozz, red, white = ("Mild Cheddar Block 20kg", "Mozzarella Block 20kg",
                              "Red Leicester Block 20kg", "Mild White Cheddar Block 20kg")
    # 114: sliced, balances once offcuts are counted; one batch corrected by reversal
    for b, q in (("16001", 1000), ("16002", 1000), ("16003", 1000), ("16004", 1000),
                 ("16005", 500), ("16007", 1000), ("16008", 1000), ("16009", 1000), ("16011", 784)):
        add("114", "05.08.2026", "RMMC20BF", ched, b, "Input", q)
    add("114", "05.08.2026", "RMMC20BF", ched, "16010", "Input", 500)
    add("114", "05.08.2026", "RMMC20BF", ched, "16010", "Input", 500, reversed_="X")
    add("114", "05.08.2026", "RMMC20BF", ched, "16006", "Input", 500)
    add("114", "05.08.2026", "OCMC001", "Cheddar Offcuts", "OC114", "Output", 300)
    add("114", "05.08.2026", "PKBOX12", "Box 12x1kg", "", "Input", 707, "EA")
    add("114", "05.08.2026", "PKTOP01", "Topfilm 320mm", "", "Input", 55, "kg")
    add("114", "05.08.2026", "MISL20121NA", "Nandos Mild Sliced Cheddar 20g 12x1kg", "FG114", "Output", 707, "CS")

    # 589: cheese issued for the full planned 2,254 cases, only 490 confirmed
    for b, q in (("15101", 1000), ("15102", 1000), ("15103", 1000), ("15104", 675.6)):
        add("589", "19.08.2026", "RMMC20BF", ched, b, "Input", q)
    for b, q in (("15201", 1000), ("15202", 1000), ("15203", 1000), ("15204", 1000),
                 ("15205", 1000), ("15206", 1000), ("15207", 1000), ("15208", 495.95)):
        add("589", "19.08.2026", "RMMO10BF", mozz, b, "Input", q)
    add("589", "19.08.2026", "RMPS001", "Potato Starch 25kg", "PS01", "Input", 36.75)
    add("589", "19.08.2026", "MCGR155EF7030", "Everyday Favourites Grated Mozzarella", "FG589", "Output", 490, "CS")

    # 746: 1,008 cases x 6kg but only 3,829.44kg issued
    add("746", "20.08.2026", "RMMC20BF", ched, "16311", "Input", 2000)
    add("746", "20.08.2026", "RMMC20BF", ched, "16312", "Input", 1829.44)
    add("746", "20.08.2026", "SMSL20500BK", "Smoked Sliced Cheddar 20g 12x500g", "FG746", "Output", 1008, "CS")

    # 783: 720 cases confirmed, cheese issued matches neither plan nor output
    add("783", "21.08.2026", "RMMO10BF", mozz, "15301", "Input", 1000)
    add("783", "21.08.2026", "RMMO10BF", mozz, "15302", "Input", 1164.09)
    add("783", "21.08.2026", "MAGR155BA", "Grated Mozzarella 5x1kg", "FG783", "Output", 720, "CS")

    # 1400: 50/50 blend with only the red cheese issued
    add("1400", "08.09.2026", "RMRL20BF", red, "17101", "Input", 1000)
    add("1400", "08.09.2026", "RMRL20BF", red, "17102", "Input", 246.7)
    add("1400", "08.09.2026", "RWGR262BF5050", "Red & White Grated 50/50 6x2kg", "FG1400", "Output", 214, "CS")

    # 1439 / 1466: same material, 2 days apart, one short and one over by ~the same amount
    add("1439", "09.09.2026", "RMWC20BF", white, "17001", "Input", 1000)
    add("1439", "09.09.2026", "RMWC20BF", white, "17002", "Input", 699.5)
    add("1439", "09.09.2026", "WHGR155EF", "Everyday Fav Grated Mild White 5x1", "FG1439", "Output", 700, "CS")
    add("1466", "11.09.2026", "RMWC20BF", white, "17001", "Input", 1000)
    add("1466", "11.09.2026", "RMWC20BF", white, "17003", "Input", 1000)
    add("1466", "11.09.2026", "RMWC20BF", white, "17004", "Input", 1000)
    add("1466", "11.09.2026", "RMWC20BF", white, "17005", "Input", 1162.5)
    add("1466", "11.09.2026", "WHGR155EF", "Everyday Fav Grated Mild White 5x1", "FG1466", "Output", 500, "CS")

    # 1482: 70/30 blend completed with 9.5kg of cheese
    add("1482", "12.09.2026", "RMMO10BF", mozz, "17201", "Input", 9.5)
    add("1482", "12.09.2026", "MCGR155BA7030", "Grated Mozzarella/Cheddar 70/30 5x1kg", "FG1482", "Output", 126, "CS")

    # 2001: journal lines for an order that is in no order export
    add("2001", "12.09.2026", "RMMC20BF", ched, "17301", "Input", 400)

    # SAP-style grouping: order ID only on the first line of each order
    last = None
    for row in rows:
        if row[0] == last:
            row[0] = ""
        else:
            last = row[0]
    return rows


PRODUCTS = pd.DataFrame([
    {"Material ID": "MCGR155EF7030", "Material Description": "Everyday Favourites Grated Mozzarella/Cheddar 70/30 5x1kg",
     "Pack kg": 5, "Starch %": 1.5, "Blend Ratio": "70/30"},
    {"Material ID": "MISL20121NA", "Material Description": "Nandos Mild Sliced Cheddar 20g 12x1kg",
     "Pack kg": 12, "Starch %": 0, "Blend Ratio": ""},
    {"Material ID": "RMPS001", "Material Description": "Potato Starch 25kg", "Pack kg": "", "Starch %": "",
     "Blend Ratio": "", },
])


def write_sample_files(folder: str | Path) -> list[Path]:
    folder = Path(folder)
    folder.mkdir(parents=True, exist_ok=True)

    orders_path = folder / "production_orders.xlsx"
    with pd.ExcelWriter(orders_path, engine="openpyxl") as w:
        sheet = [["Production Orders", *[""] * 7], ["Selection: Required On 01.08.2026 - 30.09.2026", *[""] * 7],
                 [""] * 8, ORDER_HEADERS, *ORDERS]
        pd.DataFrame(sheet).to_excel(w, sheet_name="Production Orders", header=False, index=False)

    journal_path = folder / "confirmation_journal.xlsx"
    with pd.ExcelWriter(journal_path, engine="openpyxl") as w:
        sheet = [["Confirmation Journal", *[""] * 10], [""] * 11, JOURNAL_HEADERS, *_journal_rows()]
        pd.DataFrame(sheet).to_excel(w, sheet_name="Journal", header=False, index=False)

    second_path = folder / "production_orders_rerun.csv"
    pd.DataFrame(SECOND_ORDERS, columns=ORDER_HEADERS).to_csv(second_path, index=False)

    products_path = folder / "product_master.csv"
    PRODUCTS.to_csv(products_path, index=False)
    return [orders_path, journal_path, second_path, products_path]


if __name__ == "__main__":
    target = sys.argv[1] if len(sys.argv) > 1 else "sample_data"
    for p in write_sample_files(target):
        print(p)
