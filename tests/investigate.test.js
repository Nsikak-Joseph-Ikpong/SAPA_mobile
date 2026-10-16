// The variance investigator on a small made-up week (node tests/investigate.test.js; run by tests/test_investigate.py).
//   Job A (GRATING_L4): 200 cases of WHGR155EF (5 kg a case, 1,000 kg of cheese), only 500 kg booked. Pallet P2
//     (500 kg) was moved to the line during its run, never booked to any job, and written off two days later.
//   Job B (GRATING_L4): still running when the journal ends: cheese booked, no pallets yet.
const assert = require("assert");
const R = require("../web/reconcile.js");
global.OrderCheck = R;
const I = require("../web/investigate.js");

const t = (d, hm) => `${d}.10.2026 ${hm}:00`;
const comp = [["Production Order ID", "Production Order Status", "Earliest Start Date Time", "Requested Start Date", "Requested Start Date Time", "Output Product ID", "Resource ID", "Input Material ID", "Planned Quantity", "Open Quantity", "Fulfilled Quantity"],
  ["A", "Finished", t("05", "08:00"), "05.10.2026", t("05", "08:00"), "WHGR155EF", "GRATING_L4", "RMMC20BF", 1000, 0, 0],
  ["B", "Started", t("07", "20:00"), "07.10.2026", t("07", "20:00"), "WHGR155EF", "GRATING_L4", "RMMC20BF", 1000, 0, 0]];
const outs = [["Production Order", "Production Order (Output Product)", "Production Order (Output Product Text)", "Product", "Product (Text)", "Production Start Date Time", "Planned Quantity", "Open Quantity", "Fulfilled Quantity"],
  ["A", "WHGR155EF", "Grated Mild White 5x1kg", "WHGR155EF", "Grated Mild White 5x1kg", t("05", "08:00"), 200, 0, 200],
  ["B", "WHGR155EF", "Grated Mild White 5x1kg", "WHGR155EF", "Grated Mild White 5x1kg", t("07", "20:00"), 200, 200, 0]];
const PC = "Production Confirmation", GA = "Goods and Activity Confirmation";
const J = (mat, batch, area, when, doc, conf, ref, qty) => ["EDH01", mat, batch, area, when, doc, conf, ref, "#", qty];
const jr = [["Site", "Product", "Identified Stock (Identified Stock ID)", "Logistics Area (Logistics Area ID)", "Created On", "Conf.Document Type", "Conf.ID", "Reference Document ID", "Restricted", "Effective Qty"],
  // pallets received into the store before the jobs
  J("RMMC20BF", "P1", "7A01", t("01", "06:00"), "Warehouse Confirmation", "1", "#", 500),
  J("RMMC20BF", "P2", "7A02", t("01", "06:00"), "Warehouse Confirmation", "2", "#", 500),
  J("RMMC20BF", "P3", "7A03", t("01", "06:00"), "Warehouse Confirmation", "3", "#", 1000),
  // job A: P1 moved up and booked; P2 moved up during the run, never booked
  J("RMMC20BF", "P1", "7A01", t("05", "07:50"), GA, "10", "#", -500), J("RMMC20BF", "P1", "GRATINGLINES", t("05", "07:50"), GA, "10", "#", 500),
  J("RMMC20BF", "P1", "GRATINGLINES", t("05", "07:55"), PC, "11", "A", -500),
  J("RMMC20BF", "P2", "7A02", t("05", "09:00"), GA, "12", "#", -500), J("RMMC20BF", "P2", "GRATINGLINES", t("05", "09:00"), GA, "12", "#", 500),
  J("WHGR155EF", "F1", "FG_STAGING", t("05", "09:30"), PC, "13", "A", 100), J("WHGR155EF", "F2", "FG_STAGING", t("05", "10:30"), PC, "14", "A", 100),
  // two days later P2 is taken off the line with no destination: written off
  J("RMMC20BF", "P2", "GRATINGLINES", t("07", "15:00"), GA, "15", "#", -500),
  // job B: P3 moved up and booked, no pallets yet
  J("RMMC20BF", "P3", "7A03", t("07", "19:50"), GA, "20", "#", -1000), J("RMMC20BF", "P3", "GRATINGLINES", t("07", "19:50"), GA, "20", "#", 1000),
  J("RMMC20BF", "P3", "GRATINGLINES", t("07", "19:55"), PC, "21", "B", -1000)];
const sheets = [{ file: "orders.xlsx", sheet: "Inputs", rows: comp }, { file: "orders.xlsx", sheet: "Outputs", rows: outs }, { file: "journal.xlsx", sheet: "Journal", rows: jr }];
const ctx = R.prepare(R.readWorkbook(sheets));

const a = I.run(ctx, "A", 7);
assert(!a.error, a.error);
assert(a.gap < -400 && a.gap > -600, `A should be about 500 kg short, is ${a.gap}`);
assert.deepStrictEqual(a.checks.filter((c) => c.decisive), [], "A is finished");
const nb = a.causes.find((c) => c.key === "never_booked");
assert(nb, "A: the never-booked pallet is found: " + JSON.stringify(a.causes.map((c) => c.key)));
assert.strictEqual(nb.conf, "strong");
assert.deepStrictEqual(nb.batches, ["P2"]);
assert(nb.items[0].written_off && nb.items[0].written_off.length === 1, "A: P2's write-off is shown");
assert(a.explained <= Math.abs(a.gap) + 1e-6, "never explains more than the gap");
assert(/written off/.test(a.story.join(" ")), "the story says it was written off");

const b = I.run(ctx, "B", 7);
assert(!b.error, b.error);
assert(b.checks.some((c) => c.kind === "running" && c.decisive), "B is still running");
assert.strictEqual(b.causes.length, 0, "a running job gets no causes");
console.log("investigate: ok");
