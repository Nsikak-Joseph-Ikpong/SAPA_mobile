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
4. Type a job number, a batch for its history, or use the stock trace (the camera button opens the camera: point
   it at a label, and once it's read the camera closes and the trace shows by itself).

The files are read on the phone and kept in its browser, so they're still there next time. Nothing is
uploaded to GitHub or anywhere else. When you save newer exports on the laptop, load them again on the
phone; *Remove* / *Remove all files* clears the old ones.

The phone can't open files straight off the laptop's disk; they have to go through a synced folder
(step 1), email, or a USB cable. If you'd rather the files never leave the laptop, use
`python serve.py --share` on the office Wi-Fi instead (see *Use it from your phone (office Wi-Fi)*).

## Variance investigator

https://nsikak-joseph-ikpong.github.io/SAPA_mobile/investigate.html (or **Variance investigator** from any page's title
menu, or **Investigate this job** on an order in the checker). It uses the SAP files loaded on the checker: keep loading
the month's confirmation journal there each day. Type a production order, pick **2 weeks** (7 days either side of the
job) or **1 week** (3½ days either side), and click **Investigate**.

Cheese can't appear or vanish: when a job's output has no cheese booked for it, the blocks it used are still in SAP and
turn up somewhere else. The investigation works through it in the order an analyst would:

1. **The gap in plain words:** what the output needs, what was booked (blocks and offcut bags apart) and the variance,
   also as blocks (≈ 20 kg) or offcut bags (7–13 kg).
2. **Checked first** (things that aren't lost cheese): the job was still running when the journal was exported (then
   nothing else is reported); it started before the journal begins; pallets booked to the wrong order (same product,
   same line, after its own cheese stopped while the other job was still consuming); a pallet booked twice; the recipe
   case weight.
3. **Most likely causes**, each marked *strong*, *medium* or *weak* with the kg it explains (never more than the gap in
   all; **Explained** shows how much): a pallet moved to the line during the run but never booked (and whether it was
   written off or is still on the line); a whole pallet booked minutes after it was moved once the job already had
   what it needed; pallets moved in for another job; pallets booked to a job that's over. Only this cheese counts,
   offcut bags are handled as bags, batches that started before the journal aren't called over-consumed, and the
   shared grating area (L4/L5) is marked *medium* when a pallet could belong to either job.
4. **Offcut bags:** how much of the cheese should be bags (from at least 3 other jobs on the product, else the recipe),
   and how many bags look unscanned.
5. **Other jobs it touched** and **do the jobs on this cheese net out?** over the week: if they cancel, the cheese was
   booked to the wrong jobs; if not, it's really missing (or extra).
6. **Where the cheese is now:** stock SAP still shows on the lines, write-offs, part pallets from the **Stock
   Overview** export (load it on the checker), and batches booked below zero.

**Copy the summary** gives it all in plain words for an email or report. **Every job in the window** (folded away)
lists the week's jobs; click any to investigate it.

## Stock take

`stocktake.html` (*Stock take* in the page menu) uses the stock overview and confirmation journal loaded on the
checker. Type a product and tap *Show stock*, or pick one of the suggestions that come up as you type (the codes starting
with what's typed, and from three letters those whose description has it, each with its description and batches on
hand, and *Every product starting …* first): a prefix lists every product it starts (RMMA lists RMMA10EX, RMMA20BF…,
with a button per product to narrow it), the full code just that one. *Counting in* limits the list by logistics
area: type and the matching areas are suggested (spaces and underscores aside, so "floor 5" suggests FLOOR5_A,
FLOOR_5C…), with *All areas* first; pick one for that area, or leave part of a name to count in every area it
matches. Each batch on hand is a row: SAP's quantity, the label's quantity, the difference, a count typed by hand, the
product and SAP's area.

*Scan labels* opens the camera across the screen and keeps it open while you walk the racks. The label nearest the
middle is read (both QR codes where it can: the small one holds the quantity), the batch is ticked, and the picture
says the label's quantity against SAP's ("label 1,007.71, SAP 1,000.00 (+7.71)"). The printed quantity is read in the
background (OCR, as Scan and check does) and shown next to the QR's ("✓ = QR", or "≠ QR"). A label SAP has in
another area than the one you're counting in, one not in SAP's stock, or one of another product is said on the
picture and listed under *Scanned, not in this list*. Click a batch number for its stock overview rows and every
transaction in the journal with the running stock (and a link to the full trace on the checker). Rows can be ticked
and counts typed by hand; the list filters and sorts by any column. The count is kept in that browser until *Start a
new count*, and *Download the count* saves it as Excel (the count, and what was scanned but isn't in the list).

Every camera view (the trace, pallet scanning, Scan and check, the stock take) has a zoom slider for labels out of
reach: the camera's own zoom where the phone has one, else the middle of the picture enlarged up to 4× and read at
the camera's full resolution.

## Scan and check on one device (phone or laptop)

Scanning inputs (offcut bags, cheese blocks, packaging) with a phone instead of the QR gun, so there's a record of
every label that went into a job, with a photo, checked against what SAP took. Everything happens on the one device:
nothing is linked or sent anywhere, so it works on any network.

1. Open https://nsikak-joseph-ikpong.github.io/SAPA_mobile/inputs.html?here, or open the checker and pick **Scan and
   check here** from its title (▾).
2. Type the job in **Job on the line** and tap **Set job**.
3. Load the SAP files on the device with **Load SAP files** (on a phone, from Files, OneDrive or an email attachment).
   Files loaded on the checker on the same device are picked up too.
4. Tap **Scan a bag**: the camera opens across the whole screen (as for the stock trace), reads the label (both QR
   codes), takes the picture and closes by itself.
   The bag shows in the list with its label check (the printed product code and quantity against the QR codes) and
   its SAP status, including **Already used on job …** (with the line and date) when the confirmation journal shows
   another job consumed it; that is also said straight away, with a long buzz. A label already scanned this session
   is refused. **No readable QR** takes a photo only.
5. **Export CSV** keeps the list; reloading the page clears it.

On a phone the scans show as cards and **Scan a bag** stays at the bottom of the screen. On a laptop it uses the
webcam. The full-screen camera is shared with the checker's stock trace (`web/camview.js`); the label is read as the bag
scanner reads it (zxing, both codes put together over a few frames).

## Label scanner demo (phone → laptop, linked)

The first version: the phone scans and sends each label to a laptop dashboard over the internet (WebRTC). It needs
the two to be able to link, which office networks often block (see *When the phone won't link* below); the one-device
page above doesn't.

**Moving between the pages.** Every page's title is a menu (click it, ▾) listing the pages: **Cheese variance
check** (the checker, https://nsikak-joseph-ikpong.github.io/SAPA_mobile/), **Scan and check here** (one device),
**Input products (linked)** (the laptop dashboard) and **Bag scanner (linked)** (the phone). A page opens in the same
tab, like any web page, on a phone too. The scans on Scan and check here and Input products are kept for the tab (in
the browser, on the device): go to the checker to trace a bag and come back, and they're still there; reloading the
page or **Clear all** removes them. A page with a live link (Input products with phones connected, the bag scanner
linked to a laptop) opens the other page in a new tab instead, so the link stays up; and if the linked Input products
is already open in another tab, the menu says so rather than opening a second copy (a second pairing code).

* **Laptop:** open https://nsikak-joseph-ikpong.github.io/SAPA_mobile/inputs.html, or pick **Input products** from the
  checker's title. It shows a pairing QR code.
  Type the job on the line in **Job on the line** and click **Set job**: every paired phone scans into that job
  (phones can't scan until a job is set; changing it here changes it on the phones).
* **Phone:** scan the pairing code with the phone's camera app. The scanner opens, already paired, showing the job.
  Tap **Scan**: the camera comes on, reads the label, takes the picture and goes off again. Tap **Scan next bag**
  for the next one. The camera also goes off by itself after 40 seconds without a code, or with **Cancel**.

**The label.** The plant's SAP labels carry two QR codes: the big one (goods movement) holds
`(90)<product>(10)<batch>`, the small one (scanning in) `<product>,<batch>,<quantity>,<unit>`, e.g.
`RMMA20BF,43282,1007.71,KGM` (KGM = kg, XCS = case, MTR = m). The phone reads both at once (zxing, any angle, several
codes per picture; with several labels in view, the one nearest the middle). Each frame is read scaled down for
speed, which can leave the small QR too small to read, so once one code of a label is found the other is looked for
where it should be, cut out of the frame at full resolution and enlarged. What different frames read is put
together, so the big QR from one frame and the small one from the next make a scan. When only one is readable (the
small one is often overprinted or creased) the phone says so ("Big QR ✓ · looking for the small QR… hold steady, a
little closer") and after 3 seconds goes ahead with what it has. If the full QR reader can't load, the phone says it
is reading one code at a time. Both pages show their version at the bottom (the commit, filled in when GitHub Pages
builds the site, and added to every file's address so phones don't keep old copies). A label is
sent once per session (same product, batch and quantity); **No readable QR** sends a photo only. The phone sends the
photo and a full-resolution close-up of the label cut out upright around the QR codes.

**Seeing what the scanner reads.** While the camera is on, each QR code it reads is outlined on the camera view (green
the big QR, blue the small one with its quantity; dashed when it was found by looking where the other code said it
should be), and **What the scanner reads** lists every code: its raw text, which code it is, and what it says
(product, batch, quantity and unit, with the unit code as printed in the QR), how often it was read and how it was
found, with the camera's resolution and how long a frame takes to read. **Just read a label (nothing is sent)** turns
the camera on to look at labels without a laptop or a job and without sending anything. After a scan, **Last scan**
shows both codes as read; on the laptop, clicking a scan shows them too.

**Checking the print.** On the laptop the label's large print, the product code and the quantity, is read (OCR,
Tesseract in the browser) and checked against the QR codes. The small print (batch, label numbers, dates) is hard to
read off a phone photo, so it only ever confirms: the batch comes from the QR codes, and the small "Quantity:" line
is a second reading of the quantity. The big QR fixes where everything is: measured on real labels, the product code
is printed just above it, the large quantity 3 to 5 big-QR widths to its right, the small QR 3.9 widths right and the
small print about 2 right and 1.5 to 2 up. So each field is cut out and read on its own at a set size, with the QR
codes blanked out; the whole label is read too when something is missing. A product code is a run of capitals, with
or without digits (RMMA20BF, or MBSLOFF for offcuts), and is compared allowing for the letters OCR mixes up (O and
0, I and 1, S and 5, B and 8…); titles in small letters are left out. Quantities on the labels always have a decimal
point ("87.0 case"), which keeps titles like "20kg" or "152 mm" out, and common misreadings ("kq" for kg, "973 39"
for 973.39) are put right. The **Label check** column shows **Product** and **Quantity**: ✓ the print agrees with the
QR code, ✗ two separate readings agree on something else (look at the photo), ? the print couldn't be read clearly;
one misreading on its own never shows as ✗. Without the small QR, the quantity comes from the large print, ✓ when the
small print says the same, and "unclear" with both readings when they disagree. **Batch** is ✓ when the small print
confirms it and "from QR" otherwise, never a warning. Under the quantity, a note says where it came from (small QR,
large print, small print, whole label, typed in). Tested on 15 photos of real labels (17 labels, some creased,
glared, handwritten on or overprinted): the QR codes were found on 15 labels, the printed product code agreed with
the QR on all 15, and with the small QR left out the quantity was read from the print right on 14 of 15 and never
wrong (the one missed is the older layout); 1 to 3 seconds a label, up to 6 on hard ones. The older layout (product
name under "Product:", rotated) still reads from its QR codes. The quantity is the small QR's, else the print's; it can be typed over. Click a photo to see it full size
with the close-up, both QR codes and the text that was read. The summary totals quantities per job and product;
**Export CSV** saves everything, and **Add a sample label** draws a label in the plant's layout to try it without a
phone.

**SAP history of each bag.** The inputs page uses the same SAP files as the checker: whatever was loaded on the
checker page in this browser is picked up automatically (or load them with **Load SAP files** on the inputs page,
which loads them for the checker too). Each bag then gets an **In SAP** status for the job it was scanned into:
consumed by that job (with SAP's quantity, and the difference when it doesn't match the label), not consumed (and
which job consumed it instead, where SAP still has it, or that SAP shows none left), not in the SAP files at all, or
not in the loaded journal yet when the scan is later than the journal's last posting; restricted stock is marked.
**Used on another job.** The confirmation journal is also searched for every other job that consumed
the bag's batch: the job (production order), its line (the order's Resource ID, e.g. SLICING_L2, else the line of
the logistics area), when it was consumed and how much. Each is shown under **In SAP**: "Already used on job 2601 ·
line SLICING_L1 · 10.10.2026 07:30 · 12.100 kg" when SAP used it before the scan (it has none of that bag left for
this job), or "Used on job 2601 after the scan" when SAP booked it to another job afterwards; consumption the journal
ties to no order is noted too. When the laptop has the SAP files loaded at the time of the scan and the bag was already
used, the phone is told at once: a red "Already used on job …" on the last scan and in its list, with a long buzz,
so the operator can set the bag aside. The summary counts bags used on another job per job, the bag window lists
those jobs, and the export has a column for them. The bag window sets the label's quantity next to what SAP first
booked for the batch. The summary counts bags consumed and
not consumed in SAP per job. Clicking a bag shows its SAP history (production orders that made or used it, every
confirmation journal posting with the running stock) and links to the full stock trace in the checker
(`index.html?trace=<batch>&product=<code>`; `?order=<id>` opens an order's check). Export a fresh journal after
the job and load it to see which scanned bags SAP took.

Nothing is stored anywhere: the phone sends to the laptop's browser directly (WebRTC, through PeerJS). PeerJS's
free cloud server (0.peerjs.com) only introduces the two browsers to each other. Reloading the laptop page clears
the scans (the pairing code stays the same). The camera needs `https`, so use the GitHub Pages address, not
`serve.py`.

**When the phone won't link (office networks).** The link goes straight from phone to laptop where the networks
allow it, and through PeerJS's free relay (port 3478) where they don't. Office networks and company-managed browsers
often block both: they let out only web traffic, on port 443. The phone then finds the laptop ("Laptop found ✓") but
the link never opens, and the laptop says a phone tried to connect. To get through:

1. On Input products, open **Connection: phone won't link?** under the pairing code and click **Check this
   network**. It says what gets out: the pairing service, direct links (UDP), PeerJS's relay, and your own relay.
2. If it says the network blocks the links, set up a relay on port 443. A free one: sign up at
   [Metered's Open Relay](https://www.metered.ca/tools/openrelay/) and copy the iceServers it shows (the list with
   `urls`, `username` and `credential`, including the `turns:…:443` entry); any TURN service works the same way.
   Paste it into the box and click **Use this relay**, or paste its credentials link (`https://…/api/v1/turn/credentials?apiKey=…`).
   The check runs again and should show **Your relay reached**.
3. Scan the pairing code with the phone again: the code now carries the relay (after `#` in the link, so it isn't
   sent to any server), and the phone keeps it.

The relay is kept in that laptop's browser, so it's set up once per laptop. It only carries the data when a direct
link isn't possible, and it passes it through without keeping it. Anyone who sees the pairing code could read the
relay's login from it; for more than a demo, use a relay account of your own with a usage limit. If even the
relay can't get through (the check shows "Your relay not reached"), ask IT to allow the relay's address on port
443, or WebRTC for this site. Libraries are bundled in `web/vendor/`: PeerJS (MIT),
qrcode-generator (MIT), zxing-wasm (MIT), Tesseract.js with its English data (Apache-2.0), jsQR (Apache-2.0).

## Variance checker

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

**Scan a label (stock trace).** In the stock trace, the camera button in the batch box opens the camera across the
whole screen (the picture in a rounded frame with a margin round it, the buttons under it). Point it at a label: as
soon as a QR code is read (the big one, `(90)RCSL2061WF1856(10)50085`, GS1: 90 = product, 10 = batch, 97 = label ID,
or the small one, `product,batch,quantity,unit`) the frame turns green, the camera closes by itself, both boxes fill
in and the trace shows, with nothing to tap. The ✕ button closes it without reading, as do a minute with no label
read and leaving the page; the light button switches the phone's torch where it can. With several labels in view, the one nearest the
middle is read. The QR reader is zxing, as in the bag scanner. Where there's no live camera (plain http, as over
`serve.py --share`, or the camera blocked) the button takes a photo instead, read by the browser's own QR reader or
jsQR (bundled in `web/vendor/`, Apache-2.0). The trace page shows the product name,
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
  RMMA20GB for RMMA20GR) as a substitute. Consumption (shown as input cheese) vs needed: cases × (the case weight, less any starch, plus the
  offcuts per case), with no giveaway; the recipe's cheese per case only without a case weight. The split between the
  block cheeses, no consumption at all (`CHEESE_NOT_CONSUMED`) and batches consumed for more than the
  pallet held (`BATCH_OVER_CONSUMED`) are checked;
* **mass balance** (with consumption): everything in (cheese blocks and offcuts consumed, plus starch
  backflushed on the order's output confirmations) against everything out (cases × product weight, plus
  offcuts made as booked on the order's by-products). Product weight per case is the case weight (the
  pack size, e.g. 6 kg for a 6×1 kg case), with no giveaway added, so whatever went in beyond the cases
  and the offcuts shows as unaccounted; only without a case weight does it come from the recipe (cheese +
  starch planned, less offcuts planned, over the planned cases).
  Offcut bins are made by slicing orders and consumed like any cheese by the orders whose recipe lists
  them. Flags: more went in than came out (`MASS_UNACCOUNTED`), more came out than went in
  (`MASS_OUT_EXCEEDS_IN`: beyond tolerance as before, and MEDIUM for anything over 5 kg inside it, since
  more can't come out than went in), offcut rate more than 3 points over plan (`OFFCUTS_OVER_PLAN`), no offcuts
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
  reasons say to check the BOM. The variance the reasons explain is GA actual, against the pack weight
  (cheese in, less the cases at their pack weight and the offcuts made); the giveaway the recipe allows (GA
  expected) isn't counted. Each order gets a list of possible reasons with the
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
*Offcuts made* lists each offcut bin the job made: the journal's production confirmations for an offcut bin
(a positive offcut row that isn't a reversal of the bin's consumption), tied to the job by its order reference,
else by the line and time while the job was running and booking those offcuts. It shows the bins' total against
the offcuts made on the order's by-products and says when the two differ. The offcuts made, output postings,
cheese consumed and cheese moved tables each have a filter box (type a batch, bin, pallet or Conf.ID to show
just those rows; the total follows) and sort by any column when its heading is clicked (the *Seen* column sorts
ticked pallets together). These tables are on the web page only; the Python checker's report doesn't list the bins.
Each pallet in the output postings has a *Seen* tick box for walking the floor: tick it when you've found
the pallet, and the table's heading counts how many of the order's pallets have been seen (e.g. "8 of 11
pallets seen"); a pallet booked twice is one tick. Ticks are kept in that browser (on that phone or laptop)
for 45 days, so they're still there after a reload or after loading newer SAP files. *Scan pallet labels*
above the table opens the camera across the screen and keeps it open: each pallet label it reads that's one of
the job's pallets is ticked (the pallet number is the label's batch, or any word on the QR code that matches one
of the job's pallets), and the picture says how many are still to find. A pallet already ticked, or one on another
job ("it's on job 2572"), is said on the picture and not ticked; the camera closes when every pallet is seen, or
after three minutes with no label read.

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
