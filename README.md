# SAP production variance checker

Reads SAP ByDesign spreadsheet exports, checks each production order's cheese
input against its output and offcuts, and flags anything that doesn't add up,
so someone can find out why and correct it.

You can give it several spreadsheets at once. They are read together and
cross-referenced:

| What it finds in a file | Used for |
|---|---|
| **Order list**: Production Order ID, Planned / Fulfilled / Open Quantity, Status, Material ID | Output quantity, planned quantity, closed-short checks |
| **Confirmation journal**: Production Order ID, Material ID, Identified Stock (batch), Confirmed Quantity, Input/Output, Reversed | Cheese issued per material and batch, offcuts, reversals, FG confirmed |
| **Product master** (optional): Material ID, Pack kg, Starch %, Blend Ratio | kg per case, starch and blend recipe when the description doesn't say |

Each table is detected from its column headers, wherever it is in the file,
even with title rows above it. The same order can appear in several files,
and the tool flags any disagreement between them.

## Setup

```bash
pip install -r requirements.txt
```

## Use

```bash
# Ask for order IDs interactively (repeat as often as you like)
python -m sap_variance orders.xlsx journal.xlsx product_master.csv

# Specific orders
python -m sap_variance exports/ --orders "589, 746 783"

# Every order in the files
python -m sap_variance exports/ --all --excel report.xlsx
```

A folder argument reads every `.xlsx`, `.xls`, `.csv` in it.
Try it on demo data: `python -m sap_variance.sample_data sample_data && python -m sap_variance sample_data`

Output goes to the console plus an Excel report with these sheets:
**Flags** (with blank *Reason code / Resolved by / Notes* columns for whoever
investigates), **Orders**, **Components** (per material and batch),
**Swap candidates**, **Batches**, and **Files read** (which columns were
recognised in each file).

## Confirmation journal straight from ByDesign

The journal you pull for one production order has no order column. Its
columns are *Site, Product, Identified Stock, Logistics Area, Created On,
Conf.Document Type, Conf.ID, Effective Qty*. Say which order it belongs to:

```bash
python -m sap_variance conf_jtest.xlsx orders.xlsx --journal-order conf_jtest.xlsx=589
```

If you don't, and the file name has exactly one number in it (e.g. `journal_589.xlsx`),
that number is used. Otherwise you're asked. The web page asks with a box on screen.

How the journal is read:

* **Effective Qty is signed.** Negative = stock left that logistics area, positive = arrived.
* **Only `Production Confirmation` rows are consumption and output.** A material whose
  net is negative is an input (cheese, boxes, film, labels); positive is output.
  `Goods and Activity` and `Warehouse` confirmations are stock moves
  (stores to line, line back to stores, put-away) and are used for the batch checks.
* **If the file holds several products,** only the confirmations that output this
  order's product are used, plus confirmations with no output on the same line
  within 60 minutes. The rest are listed under `OTHER_PRODUCTS_IN_JOURNAL`.

Extra checks on this format:

| Check | Meaning |
|---|---|
| `BATCH_ON_TWO_LINES` | The same batch consumed on two lines at overlapping times (HIGH for cheese) |
| `USED_BEFORE_ARRIVAL` | Consumed on a line before SAP shows the batch being moved there |
| `LEFTOVER_NOT_RETURNED` / `LEFT_ON_LINE` | Moved to the line, not all consumed, rest never moved back |
| `CONFIRMATION_WITHOUT_OUTPUT` | A production confirmation that consumed materials but records no output |
| `OTHER_PRODUCTS_IN_JOURNAL` / `UNKNOWN_PRODUCT` / `FG_NOT_IN_JOURNAL` | The journal covers more than this order, or not this order's product |
| `NO_CHEESE_IN_JOURNAL` | No cheese among the job's lines: none issued, export cut off, or unrecognised cheese codes |

Packaging is recognised by material IDs starting `BO`, `LA`, `BASEFILM`, `TOPFILM`
or `PILLOW` (change with `packaging_id_prefixes` in a config file).

## How the balance is calculated

```
output kg        = fulfilled cases x kg per case
expected cheese  = output kg x (1 - starch %)        starch: 1.5% grated, 0% otherwise
variance         = cheese issued - expected cheese - offcuts
tolerance        = the larger of 5% of expected or 50 kg
```

Positive variance = more cheese booked than the output explains.
Negative = output with no cheese behind it.
Expected cheese is always based on the **fulfilled** quantity, not the planned one.

## Checks

| Check | Meaning |
|---|---|
| `NO_CHEESE_ISSUED` | Output confirmed with at most 10% of the cheese it needs |
| `CHEESE_UNDER_ISSUED` / `CHEESE_OVER_ISSUED` | Variance outside tolerance |
| `ISSUED_TO_PLAN` | Cheese matches the *planned* quantity while far less was confirmed (e.g. job 589): output under-confirmed or leftover never returned |
| `HALF_ISSUED_BLEND` | A 50/50 or 70/30 blend with only one cheese issued |
| `BLEND_RATIO_OFF` | Both cheeses issued but the split is off the recipe by more than 8 points |
| `CROSS_ORDER_SWAP` | One order over and another under on the same cheese within 7 days, amounts nearly cancel: cheese confirmed against the wrong order |
| `CLOSED_SHORT` | Open quantity 0 but under 90% of the plan confirmed |
| `OVER_PRODUCED` | Over 110% of plan |
| `OUTPUT_MISMATCH` | Header fulfilled quantity differs from FG confirmed in the journal |
| `NEGATIVE_BATCH` / `BATCH_NEGATIVE_OVERALL` | More reversed than issued on a batch |
| `REVERSALS` | Which batches were reversed and which were finally used |
| `SOURCE_CONFLICT` | Two files disagree about the same order |
| `NO_JOURNAL_LINES` / `NO_ORDER_HEADER` | Order is in one kind of file but not the other |
| `NO_PACK_WEIGHT` | kg per case unknown: add the material to the product master |
| `NOT_CLOSED` | Nothing open but status not Closed |
| `HIGH_OFFCUTS` | Offcuts over 15% of cheese issued |

## Adapting to your exports

If a column isn't picked up, check **Files read** in the report, then add the
header text to a JSON config and pass `--config my_config.json` (see
`config.example.json`). The same file can change tolerances, the starch
percentage, the swap window, and the keywords used to tell cheese from
offcuts, starch and packaging. Cheese is recognised by an `RM` material ID
prefix or a cheese word in the description. A `Component Type` column in the
product master overrides this for any material.

## Tests

```bash
python -m pytest
```

## Web version

`web/` holds a browser version of the same checks (`web/engine.js` is a
JavaScript port of `loader.py`, `products.py` and `analysis.py`). Open
`web/index.html`, drop in the exports, and enter order IDs. Files are read
in the browser and never uploaded. If you change a rule in the Python
package, change it in `engine.js` too. `web/demo-data.js` is generated from
`sap_variance/sample_data.py`.
