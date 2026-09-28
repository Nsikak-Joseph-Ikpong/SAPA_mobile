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
| `CHEESE_MATCHES_JOURNAL_NOT_ORDER` | Cheese balances against the output the journal confirms, but not against the order list's fulfilled quantity |
| `INPUTS_DISAGREE` | Cheese, boxes and starch each imply a different number of cases (1 box = 1 case) |
| `OUTPUT_WITHOUT_BOXES` | Finished goods confirmed with no boxes booked (confirmations reversed in full are ignored) |

Material codes: cheese starts `RM`, except potato starch `RMPS…`; boxes start `BO`;
other packaging starts `LA`, `BASEFILM`, `TOPFILM`, `PILLOW` or `OPA`. Change these with
`cheese_id_prefixes`, `starch_id_prefixes`, `box_id_prefixes` and `packaging_id_prefixes`
in a config file. The unit written in the quantity cell (`-1,002.11 kg`, `98.00 case`) is read too.
Set kg per case for products whose description doesn't say, e.g.
`{"pack_overrides": {"MCGR155EF7030": 5}}` in the config (the web page has a box for it).

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

## Checking orders against the confirmation journal (whole workbook)

```bash
python -m sap_variance.reconcile SAP_Info.xlsx                 # every order with activity
python -m sap_variance.reconcile SAP_Info.xlsx --orders "589 594"
```

Reads a workbook with these sheets (found by their column headers, names don't matter):
*Production Order (OUT+IN)*, *Production order (output products)*, *Production Order (INPUT)*,
*Confirmation Journal* and *Stock Overview*. A separate, fuller journal export can be passed as a second
file (`python -m sap_variance.reconcile SAP_Info.xlsx Confirmation_Journal.xlsx`, or added on the web page).
Where two journals overlap, the bigger one is used whole and the other only adds postings it lacks
(matched on Conf.ID, product and batch).

The journal has no order ID, so postings are tied to orders:

* **Output:** a pallet of product X goes to the latest order for X that had started when it was posted
  (actual start = the order's *Production Start Date Time*).
* **Cheese moved to the line (for the estimate):** cheese in the order's recipe moved to the order's line
  during its run (2 h before the first posting until 1 h after the last regular output) is listed with it. If the same batch moves
  away again within 24 h, that's a return. On the shared GRATINGLINES area, a job that is already running
  keeps the cheese over the next job on the same line. Between L4 and L5, the job whose next output comes
  soonest gets it.

Line to logistics area: SLICING_L1/2/3 → SL_1/2/3, GRATING_L4/L5 → GRATINGLINES.

For the output and every input the order sheet says what was planned, what was fulfilled (made /
issued) and what is still open. Inputs are judged against what the cases made need (planned × made ÷
planned output):

* **cheese consumed per order from the production order fulfilment export** when it's loaded: it lists every
  input confirmation with its production lot (order), Conf.ID and quantity. The Inventory Valuation Qty
  column is used (kg; Confirmed Qty can be in blocks). Each row is matched to the journal by Conf.ID and
  product for the batch and time. Orders the export doesn't cover (it tends to leave out orders still
  Started) fall back to the journal matching below, without the postings the export already assigns;
* **cheese consumed, from the confirmation journal** (when the journal export has both sides, e.g. the
  *Confirmation Journal* export with negative rows). Cheese consumption is posted as its own production
  confirmation (a negative cheese row, no order ID). Each posting on a line is tied to the order running
  there, as for output; a reversal (a positive block-cheese row) goes back to the order that consumed
  that batch; a posting at an order's production start (its first confirmation) belongs to it; nothing
  is owned by a job more than 15 minutes after its last pallet; a posting made after an order's last
  output and within 30 minutes of the next job's start on the same line goes to the next job; a cheese
  in no running job's recipe goes to a job using the same type of cheese (first four letters, e.g.
  RMMA20GB for RMMA20GR) as a substitute. Consumption vs needed (recipe × cases), the split between the
  block cheeses, no consumption at all (`CHEESE_NOT_CONSUMED`) and batches consumed for more than the
  pallet held (`BATCH_OVER_CONSUMED`) are checked;
* **mass balance** (with consumption): everything in (cheese blocks and offcuts consumed, plus starch
  backflushed on the order's output confirmations) against everything out (cases × product weight, plus
  offcuts made as booked on the order's by-products). Product weight per case comes from the recipe:
  cheese + starch planned, less offcuts planned, over the planned cases (e.g. 6.068 kg for a 6×1 kg case).
  Offcut bins are made by slicing orders and consumed like any cheese by the orders whose recipe lists
  them. Flags: more went in than came out (`MASS_UNACCOUNTED`), more came out than went in
  (`MASS_OUT_EXCEEDS_IN`), offcut rate more than 3 points over plan (`OFFCUTS_OVER_PLAN`), no offcuts
  declared (`OFFCUTS_NOT_DECLARED`). When cheese is over or under the recipe but the balance closes, the
  difference is offcut yield and the cheese flag drops to LOW;
* **variance**, in the layout of the plant's variance report: case weight, planned and actual FG
  quantity, nominal weight planned and of output, expected and actual cheese, expected and actual
  offcuts, giveaway (GA) expected and actual, output weight + offcuts, the difference to cheese issued, its
  % and the cheese planned input %. Case weight comes from the pack size in the product text (6x1kg,
  40x5kg, 12x160g; a size with a unit wins over a slice size like 90x90), else the pack code in the job code
  (MAGR200GB -> 200 kg, MOGR2122EU -> 12 kg, MAGR155EF -> 5 kg: learnt from other products with the same
  code whose text states the pack size), else the recipe. Products whose recipe needs about 1 kg per unit
  (the CW lines) are counted in kg. The variance is cheese only: actual and expected cheese leave out
  starch, and the output side is the cheese in the nominal output (case weight less the planned starch:
  197 kg in a 200 kg dolav), so GA measures cheese giveaway only. When the recipe's weight per case is more than 5% off the case weight (e.g. two
  alternative cheeses both planned for the full case), the cheese is scaled to the case weight and the
  reasons say to check the BOM. Each order gets a list of possible reasons with the
  journal evidence: cheese moved to the line but never consumed, consumption on the line tied to no job
  or given to a neighbouring job, a recipe cheese not consumed at all, cheese moved back off the line
  without the consumption being reversed, offcuts above or below expected, output findings. The page can
  download the variance report for every order; the Excel report has it as its first sheet;
* **planned, actual and open** for the product (cases), offcuts made, cheese blocks, offcuts used and
  starch. Open is worked out as planned − actual (the order sheet's open quantity isn't reliable); actual
  cheese and starch are what the journal shows consumed, product and offcuts as made on the order. Open
  quantities are also in the variance report;
* when the journal has no consumption lines: cheese issued on the order sheet vs needed, or, when the
  sheet shows none, an estimate from cheese moved to the job's line during its run minus what was moved
  away again (never worse than CHECK; `CHEESE_CARRIED_OVER` when one job's surplus matches the next
  job's shortfall);
* packaging, labels and starch issued short or over for the output;
* output made vs planned, still open, or closed short with nothing left open.

The confirmation journal backs this up: output in the journal vs fulfilled on the order, output posted in
bulk or hours late, pallets larger than usual, reversals. A pallet whose confirmed cases are double or more
its usual size, and not corrected, is double booked (`PALLET_DOUBLE_BOOKED`, HIGH, listing each
confirmation and the cases the output is overstated by); a pallet confirmed more than once but corrected,
or under double, is `PALLET_CONFIRMED_MORE_THAN_ONCE` (MEDIUM).
The Excel report lists the order's inputs, the output postings and the cheese moved to the line.
On the web page, clicking a pallet or batch number (in the output postings or the cheese consumed table)
opens that batch's full confirmation history from the journal: every confirmation in time order with its
type, Conf.ID, logistics area, Effective Qty and the running stock after each row.
