# SAPA mobile

**Open it on your phone: https://nsikak-joseph-ikpong.github.io/SAPA_mobile/**

SAPA mobile is the cheese variance checker from the SAP project, set up to be used from a phone. It reads
SAP ByDesign spreadsheet exports, checks each production order's cheese input against its output and
offcuts, and flags anything that doesn't add up, so someone can find out why and correct it.

## Open it on your phone

The checker is a web page hosted on GitHub Pages, so the phone needs nothing installed and doesn't have
to be on the office network.

1. **On the laptop**, save the SAP exports (`.xlsx`) into a folder your phone can also see: OneDrive,
   Google Drive, iCloud Drive or Dropbox. For example, make a `SAPA` folder in OneDrive and save the
   order list, confirmation journal and stock overview exports there.
2. **On the phone**, open https://nsikak-joseph-ikpong.github.io/SAPA_mobile/ (add it to the home
   screen: Safari *Share → Add to Home Screen*, Chrome *⋮ → Add to Home screen*).
3. Tap **Load SAP files** and pick the exports. iPhone: *Browse → OneDrive / Drive / iCloud Drive*. Android:
   *☰ → OneDrive / Drive*, or the *Files* app. You can pick several at once.
4. Type a job number, a batch for its history, or use the stock trace (the camera button scans a
   pallet label's QR code).

The files are read on the phone and kept in its browser, so they're still there next time. Nothing is
uploaded to GitHub or anywhere else. When you save newer exports on the laptop, load them again on the
phone; *Remove* / *Remove all files* clears the old ones.

The phone can't open files straight off the laptop's disk; they have to go through a synced folder
(step 1), email, or a USB cable. If you'd rather the files never leave the laptop, use
`python serve.py --share` on the office Wi-Fi instead (see *Use it from your phone (office Wi-Fi)*).

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

## Run the checker page on your computer (localhost)

```bash
python serve.py
```

This opens http://localhost:8000 in your browser (`--port 8080` for another port,
`--no-browser` to not open it). Only your computer can reach it, and the files you
load stay in the browser. The spreadsheet reader is bundled in `web/vendor/`, so it
works without internet access. Stop it with Ctrl+C.

The page itself needs nothing from `requirements.txt`, only Python 3.9 or later.

**In PyCharm:**
1. Open this folder as a project (File > Open), and pick a Python interpreter when
   asked (or Settings > Project > Python Interpreter > Add Interpreter > Virtualenv).
2. Open `requirements.txt` and click *Install requirements* in the yellow bar (for the
   command-line checker and tests).
3. Right-click `serve.py` > *Run 'serve'*. The browser opens on the checker; the red
   Stop button stops it. After that, the green Run button starts it again.

## Use it from your phone (office Wi-Fi)

```bash
python serve.py --share
```

The first time, it asks for a password for the phone (at least 8 characters; kept hashed in
`.checker_login.json`, never committed; change it with `python serve.py --set-password`). It prints the
address to open on the phone, e.g. `http://192.168.1.25:8000`. On the phone, on the same Wi-Fi as this
computer, open that address and log in; the phone can save the password and fill it in with Face ID or a
fingerprint next time. Sessions last 12 hours; five wrong passwords lock that phone out for 10 minutes.

The checker page open on this computer does the checking: the phone sends a job number, a batch for its
history, or a stock trace, and the page here works it out from the SAP files loaded here and sends back only
the finished result. The SAP files never go to the phone. So keep this computer on (plugged in, sleep off), with
`serve.py --share` running and the checker page open with the files loaded; if the page is closed, the phone
says so. Nothing extra is installed: it's plain Python.

Limits: it works on the office network only (not from home or mobile data), the phone has to be on a network
that can reach this computer (guest Wi-Fi usually can't), Windows Firewall asks once whether Python may accept
connections (allow *Private networks*), and plain `http` isn't encrypted, so it's for the office network only.
Ask IT before using it with a personal phone.

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
(matched on Conf.ID, product and batch). When another kind of sheet comes from more than one file (for example
the order inputs in SAP_Info and in a newer "Production order input-output" export), each order's lines are
taken from the latest file only, so nothing is counted twice; the stock overview is taken from the latest file.

**Order reference (ground truth).** When the journal export has a *Reference Document ID* column (e.g.
*confirmation journal 2*, sheet *Confirmation Journal with ref*), a production confirmation's reference
is its production order. Every production confirmation that references an order on the order sheets is
tied to that order outright: cheese and offcuts consumed, starch, output pallets and repacks (finished goods
referencing an order that makes another product are a repack into it). The reference wins over the order
fulfilment report and over the rules below. On warehouse and goods-and-activity confirmations the reference
is another document, so they're not tied this way. A confirmation that references an order not on the
order sheets is left alone rather than given to another order. When the referenced journal is loaded next
to an older journal without the column, each posting keeps its reference whichever export it came from.
Postings with no reference (older exports) still go through the fulfilment report and line-and-time
matching, and the summary says which source each order's cheese came from.

**Offsetting variances (two jobs to compare).** When you check a job, every other job on the same line
(resource, or a shared line area such as GRATINGLINES) that ran within 12 hours of it is checked too. Two jobs are
linked when they share a block cheese, both are beyond tolerance in opposite directions (one has cheese in with no
output, the other more out than in; or over and under on cheese when there is no mass balance) and together they
nearly cancel (within 35% of the larger). Each job gets its best such partner. Both get a MEDIUM
`OFFSETTING_VARIANCE` flag and a sentence in the summary, and the page shows the two side by side: product, run
times, cases, cheese consumed, cheese per case, offcuts, mass in and out, each job's variance, what moving the
cheese would leave, and every consumption posting of the shared cheese on either job by time, to spot postings
booked to one job while the other was running (e.g. jobs 2484 and 2443: +567.3 and -502.7 kg, net +64.5 kg).

**Compare desk (cards side by side).** Any card (an order, a comparison or a stock trace) can be dragged by its
header, or its *Compare* button, to a side or corner of the screen, like Windows snap: the left or right edge
takes half the screen, the top or bottom corners a quarter, and a preview shows where it will land. Clicking
*Compare* offers the same places from a menu (touch screens, keyboard). Up to four cards, each scrolling on its own;
a card dropped on a used place replaces it, and a quarter dropped on a half splits it. With one side used the page
keeps the other half and scrolls as usual, so more orders can be checked next to the pinned one; with both sides
used the desk fills the screen, with *Back to the page* and a *Compare desk (n)* button to return. On narrow
screens the desk stacks the cards full width. The cards on the desk are copies; the page keeps its own.

**Stock overview in the trace.** Load a Stock Overview export with the other files (it's recognised by its
*On-Hand Stock* and *Logistics Area* columns; the report's "Result" subtotal rows are skipped). The trace then shows
what SAP has on hand for the batch right now: logistics area (ID and name), site, on-hand quantity and unit,
restricted, external ID (e.g. PO569-01), production and expiry dates and days to expire, next to the journal's own
running total, with a note when the two differ. A batch that is on hand but has no postings in the journal's dates
is still found.

**Scan a label (stock trace).** In the stock trace, the camera button next to the batch box opens the phone's
camera (or a file picker on a computer). The photo's QR code gives the product and batch, as on the plant's labels:
`(90)RCSL2061WF1856(10)50085` (GS1: 90 = product, 10 = batch, 97 = label ID); both boxes fill in and the trace runs.
It works over the phone link (plain http) because it uses a photo, not live video. The QR reader is the browser's
own where there is one, else jsQR (bundled in `web/vendor/`, Apache-2.0). The trace page shows the product name,
totals (made, used, stock now, postings, restricted), where the batch sits by the journal and the stock overview,
a table of the production orders that made or used it (booked to the line beforehand, used, what was left after
and where; each order number opens that order's check), goods movements by document type, and every journal
posting with its reference, restricted mark, quantity, running stock and order, sortable and filterable.

**Restricted stock.** When the journal export has a *Restricted* column, rows marked `X` are restricted
stock (`#` or blank is unrestricted). As soon as the journal is loaded, the page shows a red alert listing
every restricted posting (product, Identified Stock ID, area, time, document, Conf.ID, quantity), sortable
and filterable, with each batch's history a click away. Any order that made, consumed, moved to its line or
repacked a batch with a restricted posting gets a HIGH `RESTRICTED_STOCK` flag naming those postings, and
batch history and the stock trace mark restricted rows. Quantities aren't changed: a restricted posting
still counts as the stock movement it is. Older exports without the column show no restricted stock, so add
*Restricted* to the journal report's layout.

Without a reference, postings are tied to orders:

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
* **summary**: each order opens with a plain-words summary of what was found, e.g. "Regarding job 1971
  (MJFG2122EX, Finely Grated Monterey Jack 6x2kg), I found from the order fulfilment report that the total
  input is 4,736.26 kg: 3,515.1 kg of cheese blocks, 1,137.56 kg of offcuts, 75.6 kg of starch and 8 kg of
  repacks: 4 packs of MJFG2122EX (0.67 cases). The plan was 400 cases (400 × 12 kg = 4,800 kg) and 420 cases
  were made (420 × 12 kg = 5,040 kg). That's 303.74 kg more out than went in, so it's not clear how 420
  cases were made with less cheese, even counting the repacks.", followed, when the variance is outside
  tolerance, by the cheese-only giveaway and the strongest journal lead. Cheese that went in with no output
  is stated as "X kg of cheese has no output and is unaccounted for". When 75% or less of the planned cases
  were made and 75% or less of the planned cheese went in, and that cheese is about what the cases made need
  (75-125%), it adds "so it looks like the job ran out of cheese"; small shortfalls say nothing. Other findings stay in the findings
  list, not the summary. It's also the Summary column of the variance report. Under the figures, three bar
  charts show product planned / made / in the journal (cases) and cheese planned / needed for what was made
  / consumed (kg, repacks hatched on the consumed bar), and offcuts planned / expected for the cases made / made (kg);
* **repacks**: finished goods used as an input (a product some order makes, e.g. REMMCSL10200ALD and
  REMMRSL12160SM going into job 1868). They're taken from the order sheet when it lists them, else the
  order fulfilment report, else the journal: a production confirmation consuming finished goods (not the
  reversal of a job's own pallet) belongs to the job making that same product while it runs (start to
  last pallet plus 15 minutes), or else to a repack job (`RE...`) that started up to 10 minutes before it. Cases are weighed by the product's own case weight
  (from its text, pack code or recipe: 189 cases of a 10x200g product = 378 kg) and added to the cheese in
  the cheese check, mass balance and variance, but always shown apart: their own tile, variance columns
  (cheese consumed, repacks in, actual cheese issued = both), rows in planned/actual/open, and a table of
  the postings (`REPACK_INPUT`; `REPACK_WEIGHT_UNKNOWN` when no case weight is found);
* **planned, actual and open** for the product (cases), offcuts made, cheese blocks, offcuts used,
  starch and repacks (cases). Open is worked out as planned − actual (the order sheet's open quantity isn't reliable); actual
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
or under double, is `PALLET_CONFIRMED_MORE_THAN_ONCE` (MEDIUM). One pallet off the usual count (the last of a
run) is normal; two or more pallets off it (e.g. 112, 112, 7, 43 where 112 is usual) are
`PALLET_QUANTITIES_IRREGULAR` (HIGH, those pallets in red on the page). Output posted to a line's logistics
area (SL_1/2/3, GRATINGLINES) instead of FG_STAGING is `OUTPUT_ON_LINE_AREA` (MEDIUM, shaded on the page).
The Excel report lists the order's inputs, the output postings and the cheese moved to the line.
On the web page, clicking a pallet or batch number (in the output postings or the cheese consumed table)
opens that batch's full confirmation history from the journal: every confirmation in time order with its
type, Conf.ID, logistics area, Effective Qty and the running stock after each row.

## Hosting the web tool on GitHub Pages

`.github/workflows/pages.yml` publishes the `web/` folder to GitHub Pages on every push to `main` or to
`claude/vibrant-ritchie-p1ubko` (the default branch for now), or when run by hand from the Actions tab
(*Deploy web tool to GitHub Pages → Run workflow*). One-time setup: in the repository go to
**Settings → Pages → Build and deployment → Source** and choose **GitHub Actions**, then run the workflow
once. The page is then at `https://nsikak-joseph-ikpong.github.io/SAPA_mobile/`.

The page is static: files you load are read in your browser and kept there (IndexedDB), nothing is uploaded.
The **Stock trace** section takes a batch (pallet) number, and optionally a product code, and lists every
confirmation journal posting for it in time order: receipts, moves, consumption, output, reversals and scrap, with
the running stock, the logistics area, and the order each posting belongs to (as tied by the checks: the journal's
order reference, output pallets, cheese consumed, repacks). It also shows where the batch sits by the journal, the
stock overview for it, and links to the orders involved. Several batches can be traced at once (comma-separated).

Each loaded file has a **Remove** button that takes just that file out of the check and out of the saved
files; **Remove all files** clears them all.
GitHub Pages sites are public on the internet (unless the account is GitHub Enterprise), and Pages on a
private repository needs a paid GitHub plan; the page itself holds only the synthetic demo data.
