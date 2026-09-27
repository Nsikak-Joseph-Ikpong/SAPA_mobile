// Browser port of sap_variance/reconcile.py: check production orders against the confirmation
// journal of the ByDesign workbook. Same rules, thresholds and messages - keep them in step.
(function (root) {
  "use strict";

  const RULES = {
    line_areas: { SLICING_L1: "SL_1", SLICING_L2: "SL_2", SLICING_L3: "SL_3", GRATING_L4: "GRATINGLINES", GRATING_L5: "GRATINGLINES" },
    skip_resources: ["FLOOR_WASTE", "LINE_RECOVERY"],
    cheese_prefixes: ["RM"], not_cheese_prefixes: ["RMPS"], offcut_pattern: /^MB.*OFF$/,
    lead_hours: 2, tail_hours: 1, return_hours: 24, order_start_slack_hours: 1, max_order_age_hours: 72,
    bulk_pallets: 4, late_hours: 2, handoff_minutes: 30, consumption_grace_minutes: 15, start_anchor_seconds: 2, tolerance_pct: 0.05, tolerance_kg: 50, blend_tolerance: 0.08, offcut_tolerance: 0.03,
  };
  const SEV = { HIGH: 0, MEDIUM: 1, LOW: 2, INFO: 3 };
  const H = 3600000;

  // ------------------------------------------------------------ values
  const isNil = (v) => v === null || v === undefined || (typeof v === "number" && isNaN(v)) || (typeof v === "string" && v.trim() === "");
  const key = (v) => (isNil(v) ? "" : String(v).toLowerCase().replace(/[^a-z0-9%]/g, ""));
  function num(v) {
    if (isNil(v)) return NaN;
    if (typeof v === "number") return v;
    const s = String(v).replace(/,/g, "").replace(/[^0-9.\-]/g, "");
    return s === "" ? NaN : Number(s);
  }
  function time(v) {
    if (isNil(v)) return NaN;
    if (v instanceof Date) return Date.UTC(v.getFullYear(), v.getMonth(), v.getDate(), v.getHours(), v.getMinutes(), v.getSeconds());
    if (typeof v === "number") return Math.round((v - 25569) * 86400000);   // Excel serial date
    const m = String(v).trim().match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
    if (m) return Date.UTC(+m[3], +m[2] - 1, +m[1], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
    const d = Date.parse(v);
    return isNaN(d) ? NaN : d;
  }
  function id(v) {
    if (isNil(v)) return null;
    if (typeof v === "number" && Number.isInteger(v)) return String(v);
    return String(v).trim();
  }
  const str = (v) => (isNil(v) ? "nan" : String(v).trim());

  // ------------------------------------------------------------ formatting (matches Python's format specs)
  // Python rounds the exact binary value and sends exact halves to the even digit; do the same
  // Python-style rounding: on the exact binary value, exact halves to even
  function fixed(x, d) {
    const t = x.toFixed(d);
    if (!Number.isFinite(x) || Math.abs(x) >= 1e21) return t;
    const exact = Math.abs(x).toFixed(100), dot = exact.indexOf(".");
    const rest = exact.slice(dot + 1 + d);
    if (!/^50*$/.test(rest)) return t;
    const scaled = Math.round(Math.abs(x) * Math.pow(10, d) - 0.5);
    const even = scaled % 2 === 0 ? scaled : scaled + 1;
    return (x < 0 ? "-" : "") + (even / Math.pow(10, d)).toFixed(d);
  }
  const group = (t) => { const [i, dec] = t.split("."); return i.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (dec !== undefined ? "." + dec : ""); };
  const f = (v, d = 0) => (v < 0 || Object.is(v, -0) ? "-" : "") + group(fixed(Math.abs(v), d));
  const fs = (v, d = 0) => (v < 0 || Object.is(v, -0) ? "-" : "+") + group(fixed(Math.abs(v), d));
  const pct = (v, d = 1, signed = false) => (v < 0 ? "-" : signed ? "+" : "") + fixed(Math.abs(v * 100), d) + "%";
  const pad = (n) => String(n).padStart(2, "0");
  const dm = (t) => { const d = new Date(t); return `${pad(d.getUTCDate())}.${pad(d.getUTCMonth() + 1)} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`; };
  const hm = (t) => { const d = new Date(t); return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`; };
  const dmy = (t) => { const d = new Date(t); return `${pad(d.getUTCDate())}.${pad(d.getUTCMonth() + 1)}.${d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`; };
  const sum = (a) => a.reduce((x, y) => x + y, 0);

  // ------------------------------------------------------------ reading
  const SIGNATURES = {
    journal: ["confid", "effectiveqty"],
    components: ["inputmaterialid", "resourceid"],
    outputs: ["productionorderoutputproduct", "product", "productionstartdatetime"],
    inputs: ["inputproduct", "operationid"],
    stock: ["onhandstock", "logisticsarea"],
  };

  function findHeader(rows) {
    for (let i = 0; i < Math.min(15, rows.length); i++) {
      const keys = new Set((rows[i] || []).map(key));
      for (const [kind, sig] of Object.entries(SIGNATURES)) if (sig.every((k) => keys.has(k))) return [kind, i];
    }
    return [null, -1];
  }

  function frame(rows, h) {
    const seen = {};
    const names = (rows[h] || []).map((v) => { const k = key(v) || "col"; seen[k] = (seen[k] ?? -1) + 1; return seen[k] ? `${k}.${seen[k]}` : k; });
    const out = [];
    for (let i = h + 1; i < rows.length; i++) {
      const r = rows[i] || [];
      const o = {};
      names.forEach((n, j) => (o[n] = r[j] ?? null));
      out.push(o);
    }
    return { names, rows: out };
  }
  const col = (fr, prefix) => fr.names.find((n) => n.startsWith(prefix));
  function ffill(rows, cols) {
    const last = {};
    for (const r of rows) for (const c of cols) { if (isNil(r[c])) r[c] = last[c] ?? null; else last[c] = r[c]; }
  }

  function journalRows(jf) {
    const bc = col(jf, "identifiedstock"), ac = col(jf, "logisticsarea");
    const journal = [];
    for (const r of jf.rows) {
      const t = time(r.createdon), q = num(r.effectiveqty);
      if (isNaN(t) || isNaN(q)) continue;
      const doc = String(r.confdocumenttype);
      journal.push({ site: r.site, material: str(r.product), batch: id(r[bc]), area: str(r[ac]), time: t, doc,
        conf: id(r.confid), qty: q, is_prod: /production/i.test(doc) });
    }
    return journal;
  }

  // Several exports of the journal can overlap (e.g. one with only receiving rows, one with both
  // sides). The fullest one is kept whole; the others only add postings it doesn't have.
  function mergeJournals(journals) {
    const js = journals.map((j, i) => [j, i]).sort((a, b) => b[0].length - a[0].length || a[1] - b[1]).map((x) => x[0]);
    const k = (r) => `${r.conf}|${r.material}|${r.batch}`;
    const seen = new Set(js[0].map(k));
    const out = js[0].slice();
    for (const j of js.slice(1)) for (const r of j) if (!seen.has(k(r))) out.push(r);
    return out;
  }

  // sheets: [{file, sheet, rows: [[...], ...]}]
  function readWorkbook(sheets) {
    const found = {}, names = {}, journals = [], jnames = [];
    for (const sh of sheets) {
      const [kind, h] = findHeader(sh.rows);
      if (!kind) continue;
      const fr = frame(sh.rows, h);
      if (kind === "journal") { journals.push(journalRows(fr)); jnames.push(`${sh.file} [${sh.sheet}]`); continue; }
      if (found[kind]) found[kind].rows.push(...fr.rows); else found[kind] = fr;
      names[kind] = `${sh.file} [${sh.sheet}]`;
    }
    if (journals.length) { found.journal = mergeJournals(journals); names.journal = jnames.join(", "); }
    const missing = ["journal", "components"].filter((k) => !found[k]);
    if (missing.length) throw new Error("Could not find these sheets (by their column headers): " + missing.join(", "));

    // inputs per order
    const c = found.components.rows;
    ffill(c, ["productionorderid", "productionorderstatus", "outputproductid", "resourceid", "earlieststartdatetime", "requestedstartdatetime"]);
    const comp = c.map((r) => ({
      order_id: id(r.productionorderid), status: r.productionorderstatus, fg: str(r.outputproductid), resource: r.resourceid,
      requested_start: time(r.requestedstartdatetime), material: str(r.inputmaterialid),
      planned: num(r.plannedquantity), open: num(r.openquantity), fulfilled: num(r.fulfilledquantity),
      out_open: num(r["openquantity.1"]), out_fulfilled: num(r["fulfilledquantity.1"]),
    })).filter((r) => r.order_id !== null);

    // outputs and by-products
    const head = {}, byp = [];
    if (found.outputs) {
      const o = found.outputs.rows;
      ffill(o, ["productionorder", "productionorderoutputproduct", "productionorderoutputproducttext"]);
      for (const r of o) {
        const x = {
          order_id: id(r.productionorder), fg: str(r.productionorderoutputproduct), fg_text: r.productionorderoutputproducttext,
          material: str(r.product), text: r.producttext, planned: num(r.plannedquantity), fulfilled: num(r.fulfilledquantity),
          start_actual: time(r.productionstartdatetime), latest_end: time(r.productionorderlatestenddatetime),
        };
        if (x.material === x.fg) {
          const hd = (head[x.order_id] ||= { planned_out: 0, fulfilled_out: 0, start_actual: NaN, latest_end: NaN, fg_text: undefined });
          if (!isNaN(x.planned)) hd.planned_out += x.planned;
          if (!isNaN(x.fulfilled)) hd.fulfilled_out += x.fulfilled;
          if (!isNaN(x.start_actual) && !(x.start_actual >= hd.start_actual)) hd.start_actual = x.start_actual;
          if (!isNaN(x.latest_end) && !(x.latest_end <= hd.latest_end)) hd.latest_end = x.latest_end;
          if (hd.fg_text === undefined && !isNil(x.fg_text)) hd.fg_text = x.fg_text;
        } else byp.push(x);
      }
    }
    const first = (v, cur) => (cur === undefined || (isNil(cur) && !isNil(v)) ? v : cur);
    const byOrder = new Map();
    for (const r of comp) {
      const o = byOrder.get(r.order_id) || {};
      for (const k of ["status", "fg", "resource", "requested_start", "out_open", "out_fulfilled"]) o[k] = first(r[k], o[k]);
      byOrder.set(r.order_id, o);
    }
    const orders = [...byOrder].map(([oid, o]) => {
      const hd = head[oid];
      const planned_out = hd ? hd.planned_out : o.out_open + o.out_fulfilled;
      const fulfilled_out = hd ? hd.fulfilled_out : o.out_fulfilled;
      const start_actual = hd ? hd.start_actual : NaN;
      return { order_id: oid, ...o, planned_out, fulfilled_out, start_actual, latest_end: hd ? hd.latest_end : NaN,
        fg_text: hd ? hd.fg_text ?? null : null, start: isNaN(start_actual) ? o.requested_start : start_actual };
    });

    const journal = found.journal;

    // stock overview
    let stock = [];
    if (found.stock) {
      const sf = found.stock, sb = col(sf, "identifiedstockidentifiedstockid");
      stock = sf.rows.filter((r) => String(r.material) !== "Result").map((r) => ({
        area: String(r.logisticsarea), material: str(r.material), batch: id(r[sb]), qty: num(r.onhandstock) }));
    }
    return { orders, components: comp, byproducts: byp, journal, stock, sheets: names };
  }

  // ------------------------------------------------------------ matching
  function isCheese(m) {
    const u = String(m).toUpperCase();
    if (RULES.not_cheese_prefixes.some((p) => u.startsWith(p))) return false;
    return RULES.cheese_prefixes.some((p) => u.startsWith(p)) || RULES.offcut_pattern.test(u);
  }

  function assignOutputs(wb) {
    const fgs = new Set(wb.orders.map((o) => o.fg));
    const out = wb.journal.filter((r) => r.is_prod && fgs.has(r.material)).map((r) => ({ ...r, order_id: null }));
    const started = wb.orders.filter((o) => !isNaN(o.start_actual) || !["released", "canceled", "cancelled"].includes(String(o.status).toLowerCase()));
    const starts = {};
    for (const o of started) if (!isNaN(o.start)) (starts[o.fg] ||= []).push([o.order_id, o.start]);
    for (const k in starts) starts[k].sort((a, b) => a[1] - b[1]);
    const slack = RULES.order_start_slack_hours * H, maxAge = RULES.max_order_age_hours * H;
    for (const r of out) {
      let best = null;
      for (const [oid, st] of starts[r.material] || []) { if (st <= r.time + slack) best = [oid, st]; else break; }
      r.order_id = best && r.time - best[1] <= maxAge ? best[0] : null;
    }
    // A negative row is a reversal only for a pallet the order posted as output; otherwise it's
    // finished goods used as an input (rework)
    const made = new Set(out.filter((r) => r.qty > 0).map((r) => `${r.order_id}|${r.material}|${r.batch}`));
    return out.filter((r) => r.qty > 0 || made.has(`${r.order_id}|${r.material}|${r.batch}`));
  }

  function perConfirmation(outputs) {
    const m = new Map();
    for (const r of outputs) {
      if (!(r.qty > 0) || r.order_id === null) continue;
      const k = r.order_id + "\u0000" + r.conf;
      if (!m.has(k)) m.set(k, { order_id: r.order_id, conf: r.conf, time: r.time, batches: new Set(), cases: 0 });
      const c = m.get(k);
      c.time = Math.min(c.time, r.time); if (r.batch !== null) c.batches.add(r.batch); c.cases += r.qty;
    }
    return [...m.values()].map((c) => ({ ...c, pallets: c.batches.size, bulk: c.batches.size >= RULES.bulk_pallets }));
  }

  function orderWindows(orders, perConf) {
    const reg = {}, any = {};
    for (const c of perConf) {
      const a = (any[c.order_id] ||= [Infinity, -Infinity]); a[0] = Math.min(a[0], c.time); a[1] = Math.max(a[1], c.time);
      if (!c.bulk) { const b = (reg[c.order_id] ||= [Infinity, -Infinity]); b[0] = Math.min(b[0], c.time); b[1] = Math.max(b[1], c.time); }
    }
    return orders.map((o) => {
      const r = reg[o.order_id] || any[o.order_id];
      const first_out = r ? r[0] : NaN, last_regular = r ? r[1] : NaN;
      const cand = [o.start, first_out].filter((v) => !isNaN(v));
      const begin = cand.length ? Math.min(...cand) - RULES.lead_hours * H : NaN;
      const endBase = isNaN(last_regular) ? o.latest_end : last_regular;
      return { order_id: o.order_id, start: o.start, latest_end: o.latest_end, resource: o.resource, first_out, last_regular,
        begin, end: isNaN(endBase) ? NaN : endBase + RULES.tail_hours * H, area: RULES.line_areas[o.resource] ?? null };
    });
  }

  function lineContext(wb, windows, perConf) {
    const recipe = {};
    for (const c of wb.components) if (isCheese(c.material)) (recipe[c.order_id] ||= new Set()).add(c.material);
    const nextOut = {};
    for (const c of perConf) if (c.pallets < RULES.bulk_pallets) (nextOut[c.order_id] ||= []).push(c.time);
    for (const k in nextOut) nextOut[k].sort((a, b) => a - b);
    const winsByArea = {};
    for (const w of windows) if (w.area && !isNaN(w.begin) && !isNaN(w.end)) (winsByArea[w.area] ||= []).push(w);
    const starts = {}, resources = {}, lastOut = {};
    for (const w of windows) { starts[w.order_id] = w.start; resources[w.order_id] = w.resource; lastOut[w.order_id] = w.last_regular; }
    return { recipe, nextOut, winsByArea, starts, resources, lastOut };
  }

  // The order a cheese posting on a line belongs to: an order on that area whose run covers the posting and
  // whose recipe has the cheese. A job already running owns it over the next job on the same line; between
  // jobs running side by side (L4 and L5 share GRATINGLINES), the next regular output decides.
  function pickOwner(r, lc) {
    const { recipe, nextOut, winsByArea, starts, resources } = lc;
    const cands = (winsByArea[r.area] || []).filter((w) => w.begin <= r.time && w.end >= r.time && recipe[w.order_id]?.has(r.material)).map((w) => w.order_id);
    if (!cands.length) return null;
    const soonest = (oid) => { const t = (nextOut[oid] || []).find((x) => x >= r.time); return t === undefined ? Infinity : t; };
    const running = cands.filter((c) => !isNaN(starts[c]) && starts[c] <= r.time);
    let owner;
    if (running.length) {
      const latest = new Map();
      for (const c of running) { const res = resources[c]; if (!latest.has(res) || starts[c] > starts[latest.get(res)]) latest.set(res, c); }
      const vals = [...latest.values()];
      owner = vals.reduce((b, c) => (soonest(c) < soonest(b) ? c : b), vals[0]);
    } else {
      const st = (c) => (isNaN(starts[c]) ? Infinity : starts[c]);
      owner = cands.reduce((b, c) => (st(c) < st(b) ? c : b), cands[0]);
    }
    return [owner, cands];
  }

  // Cheese consumed on production confirmations: negative cheese rows (positive block-cheese rows are
  // reversals). Positive offcut-bin rows are offcuts produced, not consumption.
  const consumptionRows = (journal) => journal.filter((r) => r.is_prod && r.qty !== 0 && isCheese(r.material) && !(RULES.offcut_pattern.test(r.material.toUpperCase()) && r.qty > 0));

  const ctype = (m) => { const u = String(m).toUpperCase(); return RULES.offcut_pattern.test(u) ? u : u.slice(0, 4); };

  function assignConsumption(wb, windows, perConf, outputs) {
    const lc = lineContext(wb, windows, perConf);
    // Cheese isn't consumed for a job after its last pallet: once output stops (plus a short grace),
    // a job can no longer own consumption postings
    const lastAny = new Map();
    for (const r of outputs) if (r.qty > 0 && r.order_id !== null && !(lastAny.get(r.order_id) >= r.time)) lastAny.set(r.order_id, r.time);
    const grace = RULES.consumption_grace_minutes * 60000;
    const capped = {};
    for (const [area, ws] of Object.entries(lc.winsByArea)) capped[area] = ws.map((w) => {
      const la = lastAny.get(w.order_id);
      return la === undefined || w.end <= la + grace ? w : { ...w, end: la + grace };
    });
    const lcc = { ...lc, winsByArea: capped };
    // SAP's production start is the time of the order's first confirmation, often its first cheese
    // consumption: a posting at an order's start belongs to that order
    const areas = {};
    for (const w of windows) areas[w.order_id] = w.area;
    const anchor = {};
    for (const o of wb.orders) if (!isNaN(o.start_actual) && o.order_id in areas) (anchor[areas[o.order_id]] ||= []).push([o.start_actual, o.order_id]);
    const tol = RULES.start_anchor_seconds * 1000;
    // a cheese not in any running job's recipe is taken as a substitute by a job on that line using the same type of cheese
    const types = {};
    for (const [o, ms] of Object.entries(lc.recipe)) types[o] = new Set([...ms].map(ctype));
    const lcTyped = { ...lcc, recipe: types };
    const lineAreas = new Set(Object.values(RULES.line_areas));
    const cons = consumptionRows(wb.journal).filter((r) => lineAreas.has(r.area)).map((r, i) => [r, i])
      .sort((a, b) => a[0].time - b[0].time || a[1] - b[1]).map((x) => x[0]);
    const lastUser = new Map(), rows = [];
    for (const r of cons) {
      const key = r.material + "\u0000" + r.batch;
      let owner = null, cands = [], substitute = false;
      const anchored = (anchor[r.area] || []).filter(([t, o]) => Math.abs(t - r.time) <= tol && types[o]?.has(ctype(r.material))).map(([, o]) => o);
      if (r.qty > 0 && lastUser.has(key)) { owner = lastUser.get(key); cands = [owner]; }   // a reversal goes back to the job that consumed the batch
      else if (anchored.length) { owner = anchored[0]; cands = anchored; }
      else {
        let picked = pickOwner(r, lcc);
        if (!picked) { picked = pickOwner({ area: r.area, time: r.time, material: ctype(r.material) }, lcTyped); substitute = !!picked; }
        if (picked) [owner, cands] = picked;
        if (owner !== null) {
          // posted after the owner's last output and just before the next job on that line starts: it's for the next job
          const lo = lc.lastOut[owner];
          const nxt = cands.filter((c) => lc.resources[c] === lc.resources[owner] && !isNaN(lc.starts[c]) && lc.starts[c] > r.time && lc.starts[c] <= r.time + RULES.handoff_minutes * 60000);
          if (!isNaN(lo) && r.time > lo && nxt.length) owner = nxt.reduce((b, c) => (lc.starts[c] < lc.starts[b] ? c : b), nxt[0]);
        }
      }
      if (r.qty < 0 && owner !== null) lastUser.set(key, owner);
      rows.push({ order_id: owner, material: r.material, batch: r.batch, area: r.area, time: r.time, conf: r.conf, consumed: -r.qty,
        candidates: cands.length, other_orders: cands.filter((c) => c !== owner).join(", "), substitute });
    }
    return rows;
  }

  // Starch is backflushed with the output: its rows sit on the order's output confirmations
  function starchConsumed(journal, outputs) {
    const byConf = new Map(), seen = new Set();
    for (const r of outputs) {
      if (r.order_id === null || !(r.qty > 0)) continue;
      const k = r.order_id + "|" + r.conf;
      if (seen.has(k)) continue; seen.add(k);
      if (!byConf.has(r.conf)) byConf.set(r.conf, []);
      byConf.get(r.conf).push(r.order_id);
    }
    const out = new Map();
    for (const r of journal) {
      if (!r.is_prod || !RULES.not_cheese_prefixes.some((p) => r.material.toUpperCase().startsWith(p))) continue;
      for (const oid of byConf.get(r.conf) || []) out.set(oid, (out.get(oid) || 0) - r.qty);
    }
    return out;
  }

  // Batches consumed for more than the biggest quantity ever posted for them (a pallet weight)
  function overConsumedBatches(journal) {
    const used = new Map(), size = new Map();
    for (const r of consumptionRows(journal)) { const k = r.material + "\u0000" + r.batch; used.set(k, (used.get(k) || 0) - r.qty); }
    for (const r of journal) if (r.qty > 0) { const k = r.material + "\u0000" + r.batch; if (!(size.get(k) >= r.qty)) size.set(k, r.qty); }
    const out = new Map();
    for (const [k, u] of used) { const sz = size.get(k); if (sz && u > sz + Math.max(1, 0.01 * sz)) out.set(k, [u, sz]); }
    return out;
  }

  function assignCheese(wb, windows, perConf) {
    const lc = lineContext(wb, windows, perConf);
    const moves = wb.journal.filter((r) => !r.is_prod && r.qty > 0);
    const lineAreas = new Set(Object.values(RULES.line_areas));
    const arrivals = moves.filter((r) => isCheese(r.material) && lineAreas.has(r.area));
    const sends = [];
    for (const r of arrivals) {
      const picked = pickOwner(r, lc);
      if (!picked) continue;
      const [owner, cands] = picked;
      sends.push({ order_id: owner, material: r.material, batch: r.batch, area: r.area, time: r.time, conf: r.conf, sent: r.qty,
        candidates: cands.length, other_orders: cands.filter((c) => c !== owner).join(", ") });
    }
    // returns: the same batch arriving somewhere else soon after, before it is sent to the line again
    const batches = new Set(sends.map((s) => s.batch));
    const byBatch = new Map();
    for (const m of moves) if (batches.has(m.batch)) { const k = m.material + "\u0000" + m.batch; if (!byBatch.has(k)) byBatch.set(k, []); byBatch.get(k).push(m); }
    for (const g of byBatch.values()) g.sort((a, b) => a.time - b.time);
    for (const s of sends) {
      let qty = 0; const dest = [];
      for (const m of byBatch.get(s.material + "\u0000" + s.batch) || []) {
        if (!(m.time > s.time && m.time <= s.time + RULES.return_hours * H)) continue;
        if (m.area === s.area) break;
        if (!m.area.startsWith("#")) { qty += m.qty; dest.push(`${f(m.qty, 2)} to ${m.area} (${hm(m.time)})`); }
      }
      s.returned = Math.min(qty, s.sent); s.returned_to = dest.join("; ");
    }
    return sends;
  }

  function typicalPallets(outputs) {
    const per = {};
    for (const r of outputs) if (r.qty > 0) { const m = (per[r.material] ||= new Map()); m.set(r.batch, (m.get(r.batch) || 0) + r.qty); }
    const out = {};
    for (const [fg, m] of Object.entries(per)) {
      if (m.size < 5) continue;
      const counts = new Map();
      for (const v of m.values()) { const k = Number(fixed(v, 0)); counts.set(k, (counts.get(k) || 0) + 1); }
      let best = null, bc = -1;
      for (const [v, c] of counts) if (c > bc || (c === bc && v < best)) { best = v; bc = c; }
      if (best >= 10) out[fg] = best;
    }
    return out;
  }

  // ------------------------------------------------------------ variance (plant variance report layout)
  const PACK = /(\d+)\s*[xX]\s*(\d+(?:[.,]\d+)?)(?![\d.,])\s*(kg|k|grm|gr|g)?(?![A-Za-z])/gi;
  // Case weight from a pack size in the product text: 6x1kg, 40x5kg, 12x160g, 4x2.88k, 10 x 180 (grams when a bare
  // number is 50 or more). A size with a unit wins over a bare one (90x90 is a slice size).
  function packWeight(text) {
    const found = [...String(text ?? "").matchAll(PACK)];
    if (!found.length) return null;
    const m = found.find((x) => x[3]) || found[0];
    const n = parseInt(m[1], 10), q = parseFloat(m[2].replace(",", ".")), unit = (m[3] || "").toLowerCase();
    const grams = unit.startsWith("g") || (!unit && q >= 50);
    const w = grams ? (n * q) / 1000 : n * q;
    return w >= 0.05 && w <= 1000 ? w : null;
  }
  // the pack code in a job code: the first run of two or more digits (MAGR200GB -> 200, MOGR2122EU -> 2122)
  const packCode = (fg) => { const m = /\d{2,}/.exec(String(fg ?? "")); return m ? m[0] : null; };
  // case weight per pack code, learnt from products whose text states the pack size; codes whose products disagree are left out
  function learnPackCodes(orders) {
    const seen = new Map(), done = new Set();
    for (const o of orders) {
      const key = o.fg + "\u0000" + o.fg_text;
      if (done.has(key)) continue; done.add(key);
      const code = packCode(o.fg), w = packWeight(o.fg_text);
      if (code && w) { if (!seen.has(code)) seen.set(code, new Set()); seen.get(code).add(Number(fixed(w, 3))); }
    }
    const out = new Map();
    for (const [c, ws] of seen) if (ws.size === 1) out.set(c, [...ws][0]);
    return out;
  }
  // Nominal weight per unit of output. Products whose recipe needs about 1 kg per unit are counted in kg. Otherwise the pack
  // size in the product text, else the pack code in the job code, else the recipe. A text or code weight more than about 2x
  // away from the recipe isn't trusted.
  function caseWeight(text, recipeNet, fg, codeWeights) {
    if (recipeNet && Math.abs(recipeNet - 1) <= 0.03) return [1, "output counted in kg (the recipe needs about 1 kg per unit)"];
    const plausible = (w) => !recipeNet || recipeNet <= 0 || (recipeNet / w >= 0.45 && recipeNet / w <= 2.2);
    const w = packWeight(text);
    if (w && plausible(w)) return [w, "pack size in the product text"];
    const code = packCode(fg);
    if (code && codeWeights && codeWeights.has(code) && plausible(codeWeights.get(code))) return [codeWeights.get(code), `job code (pack code ${code}, as other products with that code)`];
    if (recipeNet > 0) return [Number(fixed(recipeNet, 3)), "recipe (cheese + starch less offcuts, per case)"];
    return [null, null];
  }
  // Cheese, starch and offcuts per case from the recipe. When the recipe's product weight per case is more than 5%
  // away from the case weight, the cheese (and its offcuts) is scaled to the case weight; starch stays as planned.
  function recipePerCase(pCheese, pStarch, pOff, plannedOut, cw) {
    const cheesePc = pCheese / plannedOut, starchPc = pStarch / plannedOut, offPc = pOff / plannedOut;
    const net = cheesePc + starchPc - offPc;
    let k = 1;
    if (cw && net > 0 && Math.abs(net - cw) / cw > 0.05 && cheesePc - offPc > 0) k = cw > starchPc ? (cw - starchPc) / (cheesePc - offPc) : cw / net;
    return { cheese_pc: cheesePc * k, starch_pc: starchPc, off_pc: offPc * k, in_pc: cheesePc * k + starchPc, net_pc: cheesePc * k + starchPc - offPc * k,
      recipe_net: net, scale: k, corrected: k !== 1, case_weight: cw };
  }

  function varianceView(o, comps, cheeseComps, offc, order_out, journal_out, cheeseSource, consumed, starchIn, issued, usedEst, codeWeights, rec) {
    const planned_out = isNaN(o.planned_out) ? null : o.planned_out;
    if (!planned_out) return null;
    const starchComps = comps.filter((c) => RULES.not_cheese_prefixes.some((p) => c.material.toUpperCase().startsWith(p)));
    const pCheese = sum(cheeseComps.map((c) => c.planned)), pStarch = sum(starchComps.map((c) => c.planned));
    const pOff = sum(offc.map((b) => (isNaN(b.planned) ? 0 : b.planned))), madeOff = sum(offc.map((b) => (isNaN(b.fulfilled) ? 0 : b.fulfilled)));
    const recipeNet = (pCheese + pStarch - pOff) / planned_out;
    const [cw, cwFrom] = caseWeight(o.fg_text, recipeNet, o.fg, codeWeights);
    const actual = order_out || journal_out;
    if (cw === null || !actual) return null;
    const starchSheet = sum(starchComps.map((c) => (isNaN(c.fulfilled) ? 0 : c.fulfilled)));
    let actualCheese, cheeseFrom;
    if (cheeseSource === "consumed") { actualCheese = consumed + starchIn; cheeseFrom = "cheese consumed in the journal + starch"; }
    else if (cheeseSource === "order") { actualCheese = issued + starchSheet; cheeseFrom = "cheese issued on the order sheet + starch"; }
    else if (cheeseSource === "journal") { actualCheese = usedEst + starchSheet; cheeseFrom = "estimate from cheese moved to the line + starch"; }
    else return null;
    const nominalOut = actual * cw, expected = rec ? actual * rec.in_pc : (actual * (pCheese + pStarch)) / planned_out, expOff = rec ? actual * rec.off_pc : (actual * pOff) / planned_out;
    const gaExp = expected - nominalOut - expOff, gaAct = actualCheese - nominalOut - madeOff, outOff = nominalOut + madeOff, diff = outOff - actualCheese;
    return { case_weight: cw, case_weight_from: cwFrom, uom: cwFrom.startsWith("output counted in kg") ? "kg" : "Case", planned_fg: planned_out, actual_fg: actual, nominal_planned: planned_out * cw,
      nominal_output: nominalOut, expected_cheese: expected, actual_cheese: actualCheese, actual_cheese_from: cheeseFrom,
      expected_offcuts: expOff, actual_offcuts: madeOff, ga_expected: gaExp, ga_actual: gaAct, output_plus_offcuts: outOff,
      difference: diff, diff_pct: actualCheese ? diff / actualCheese : null, planned_input_pct: nominalOut ? expected / nominalOut : null,
      variance_kg: gaAct - gaExp, tolerance: Math.max(RULES.tolerance_pct * expected, RULES.tolerance_kg), recipe_kg_per_case: recipeNet };
  }

  const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const byBatchSorted = (rows, val) => {
    const m = new Map();
    for (const r of rows) { const k = r.material + "\u0000" + r.batch; if (!m.has(k)) m.set(k, [r.material, r.batch, 0]); m.get(k)[2] += val(r); }
    return [...m.values()].sort((a, b) => cmpStr(a[0], b[0]) || cmpStr(String(a[1]), String(b[1])));
  };

  // Possible reasons for the variance, with the journal evidence behind each
  function varianceReasons(oid, v, cons, sendsO, w, consumption, codes, recipeBlocks, recipe, consumedByMaterial, ctx) {
    const out = [], v0 = v.variance_kg;
    const rn = v.recipe_kg_per_case, cwv = v.case_weight;
    if (rn && cwv && Math.abs(rn - cwv) / cwv > 0.05) out.push({ kg: null, text: `The recipe plans ${f(rn, 3)} kg of cheese and starch per case (less offcuts) for a ${f(cwv, 3)} kg case (${pct(rn / cwv - 1, 0, true)}), so expected cheese uses the case weight instead: check the recipe (BOM).` });
    if (Math.abs(v0) <= v.tolerance) return out.concat([{ kg: null, text: `Cheese is within tolerance of the plan (${fs(v0, 1)} kg against the giveaway the recipe allows), so there's nothing to explain.` }]);
    const area = w.area, types = new Set([...recipe].map(ctype));
    const lineAreas = new Set(Object.values(RULES.line_areas));
    if (v0 < 0) {
      if (sendsO.length) {
        const left = [];
        for (const [m, b, moved] of byBatchSorted(sendsO, (s) => s.sent - s.returned)) {
          const usedB = ctx.consumedByBatch.get(m + "\u0000" + b) || 0;
          if (moved - usedB > 1) left.push([m, b, moved - usedB]);
        }
        if (left.length) {
          const kg = sum(left.map((x) => x[2]));
          out.push({ kg, text: `${f(kg, 1)} kg of cheese was moved to ${area} for this run but never consumed in SAP: ` + left.slice(0, 8).map(([m, b, q]) => `${m} ${b} ${f(q, 1)} kg`).join(", ") + (left.length > 8 ? ` and ${left.length - 8} more` : "") + ". If it went into the product, its consumption is missing." });
        }
      }
      if (consumption) {
        const un = consumption.filter((c) => c.order_id === null && c.area === area && c.time >= w.begin && c.time <= w.end && types.has(ctype(c.material)));
        if (un.length && sum(un.map((c) => c.consumed)) > 1) {
          const kg = sum(un.map((c) => c.consumed));
          out.push({ kg, text: `${f(kg, 1)} kg of similar cheese was consumed on ${area} during the run but couldn't be tied to any job: ` + [...new Set(un.map((c) => c.material))].sort().join(", ") + "." });
        }
        const amb = consumption.filter((c) => c.order_id !== null && c.order_id !== oid && (c.other_orders || "").split(", ").includes(oid));
        if (amb.length) {
          const by = new Map();
          for (const c of amb) by.set(c.order_id, (by.get(c.order_id) || 0) + c.consumed);
          const kg = sum(amb.map((c) => c.consumed));
          out.push({ kg, text: `${f(kg, 1)} kg consumed on ${area} was given to ` + [...by.keys()].sort().map((k) => `order ${k} (${f(by.get(k), 1)} kg)`).join(", ") + " but could belong to this order (both were on the line at the time)." });
        }
      }
      for (const m of recipeBlocks) if (!((consumedByMaterial.get(m) || 0) > 0) && consumption) out.push({ kg: null, text: `${m} is in the recipe but none was consumed for this run: it was used without a consumption posting, or the product was made without it.` });
      if (codes.has("OUTPUT_NOT_ON_ORDER") || codes.has("PALLET_CONFIRMED_MORE_THAN_ONCE") || codes.has("UNUSUAL_PALLET_SIZE")) out.push({ kg: null, text: "Output may be overstated: see the pallet and output findings below." });
      if (v.actual_offcuts - v.expected_offcuts > 25) out.push({ kg: v.actual_offcuts - v.expected_offcuts, text: `Offcuts declared are ${f(v.actual_offcuts - v.expected_offcuts, 1)} kg above expected; if they're overstated, less cheese is missing.` });
      if (!out.length) out.push({ kg: null, text: "No trace in the journal: cheese was used without being moved or consumed in SAP, or the output is overstated." });
    } else {
      const amb = cons.filter((c) => c.candidates > 1);
      if (amb.length) {
        const kg = sum(amb.map((c) => c.consumed));
        const others = [...new Set(amb.map((c) => c.other_orders).join(", ").split(", "))].filter(Boolean).sort();
        out.push({ kg, text: `${f(kg, 1)} kg of this order's consumption could belong to order(s) ${others.join(", ")}, on the line at the same time.` });
      }
      if (cons.length) {
        const ret = [];
        for (const [m, b, net] of byBatchSorted(cons, (c) => c.consumed)) {
          if (net <= 1) continue;
          const bRows = cons.filter((c) => c.material === m && c.batch === b);
          const last = Math.max(...bRows.map((c) => c.time));
          const later = (ctx.movesByBatch.get(m + "\u0000" + b) || []).filter((x) => x.time > last && x.time <= last + RULES.return_hours * H && !lineAreas.has(x.area) && !x.area.startsWith("#"));
          if (!later.length) continue;
          const rev = -sum(bRows.filter((c) => c.consumed < 0).map((c) => c.consumed));
          const q = Math.min(Math.max(0, sum(later.map((x) => x.qty)) - rev), net);
          if (q <= 1) continue;
          ret.push([m, b, q, later[0].area, later[0].time]);
        }
        if (ret.length) {
          const kg = sum(ret.map((x) => x[2]));
          out.push({ kg, text: `${f(kg, 1)} kg was moved back off the line after being consumed, without the consumption being reversed: ` + ret.slice(0, 8).map(([m, b, q, a, t]) => `${m} ${b} ${f(q, 1)} kg to ${a} at ${dm(t)}`).join(", ") + "." });
        }
      }
      if (v.expected_offcuts - v.actual_offcuts > 25) out.push({ kg: v.expected_offcuts - v.actual_offcuts, text: `Offcuts declared are ${f(v.expected_offcuts - v.actual_offcuts, 1)} kg below expected: offcuts not declared, or more cheese went to waste.` });
      if (codes.has("OUTPUT_NOT_IN_JOURNAL") || codes.has("OUTPUT_NOT_ON_ORDER")) out.push({ kg: null, text: "Output may be understated: see the output findings below." });
      out.push({ kg: null, text: "Otherwise: giveaway (overfill above the nominal case weight) or waste on the line that wasn't posted." });
    }
    return out.map((x, i) => [x, i]).sort((a, b) => -(a[0].kg || 0) + (b[0].kg || 0) || a[1] - b[1]).map((x) => x[0]);
  }

  // ------------------------------------------------------------ checks
  function groupBy(rows, k) { const m = new Map(); for (const r of rows) { const v = r[k]; if (!m.has(v)) m.set(v, []); m.get(v).push(r); } return m; }

  function checkOrder(oid, ctx) {
    const { wb, idx } = ctx;
    const o = idx.orders.get(oid), comps = idx.comps.get(oid) || [], w = idx.windows.get(oid);
    const out = idx.outputs.get(oid) || [];
    const confs = (idx.perConf.get(oid) || []).slice().sort((a, b) => a.time - b.time);
    const cheese = idx.sends.get(oid) || [];
    const findings = [];
    const flag = (severity, code, message) => findings.push({ order_id: oid, severity, code, message });
    let cheese_diff = null, cheese_tol = null;

    const fg = o.fg;
    const planned_out = isNaN(o.planned_out) ? null : o.planned_out;
    const order_out = isNaN(o.fulfilled_out) ? 0 : o.fulfilled_out;
    const journal_out = out.length ? sum(out.map((r) => r.qty)) : 0;
    const area = w.area;

    if (out.length && Math.abs(journal_out - order_out) > Math.max(2, 0.02 * Math.max(journal_out, order_out))) {
      flag("HIGH", "OUTPUT_NOT_ON_ORDER", `The journal shows ${f(journal_out)} cases of ${fg} posted for this job, the order shows ${f(order_out)} fulfilled (${fs(journal_out - order_out)}).`);
    }
    if (!out.length && order_out > 0) {
      flag("MEDIUM", "OUTPUT_NOT_IN_JOURNAL", `The order shows ${f(order_out)} fulfilled but no output of ${fg} was found in the journal for this job (outside the journal's dates, or posted as another product).`);
    }

    const last = w.last_regular, odd = [];
    for (const c of confs) {
      const late = !isNaN(last) && c.time > last && c.time - last > RULES.late_hours * H;
      if (c.bulk || late) {
        const why = [];
        if (c.bulk) why.push(`${c.pallets} pallets at once`);
        if (late) why.push(`${fixed((c.time - last) / H, 1)} h after the line's last regular output`);
        odd.push(`${c.conf} at ${dm(c.time)}: ${f(c.cases)} cases (${why.join(", ")})`);
      }
    }
    if (odd.length) flag("MEDIUM", "OUTPUT_POSTED_IN_BULK_OR_LATE", "Output posted in bulk or late: " + odd.join("; ") + ".");

    const typ = ctx.typical[fg];
    if (typ && out.length) {
      const over = [], oddSize = [];
      const byBatch = [...groupBy(out, "batch")].sort((a, b) => (String(a[0]) < String(b[0]) ? -1 : String(a[0]) > String(b[0]) ? 1 : 0));
      for (const [b, g] of byBatch) {
        const gross = sum(g.filter((r) => r.qty > 0).map((r) => r.qty)), net = sum(g.map((r) => r.qty));
        if (gross > 1.5 * typ) over.push(`${b}: ${f(gross)} cases confirmed on one pallet` + (net !== gross ? `, corrected to ${f(net)}` : ""));
        else if (net > typ * 1.02) oddSize.push(`${b}: ${f(net)}`);
      }
      if (over.length) flag("MEDIUM", "PALLET_CONFIRMED_MORE_THAN_ONCE", `Usual pallet for ${fg} is ${f(typ)} cases. ` + over.join("; ") + ".");
      if (oddSize.length) flag("LOW", "UNUSUAL_PALLET_SIZE", `Usual pallet for ${fg} is ${f(typ)} cases; larger pallets: ` + oddSize.join(", ") + ". Worth a physical count.");
    }
    const rev = out.filter((r) => r.qty < 0);
    if (rev.length) flag("INFO", "OUTPUT_REVERSED", "Output reversed: " + rev.map((r) => `${r.conf} at ${dm(r.time)} (${f(r.qty)} on pallet ${r.batch})`).join("; ") + ".");

    // output on the order: planned vs fulfilled vs open
    const status = String(o.status), out_open = isNaN(o.out_open) ? null : o.out_open;
    if (planned_out && order_out > planned_out + Math.max(1, 0.02 * planned_out)) {
      const extra = order_out - planned_out;
      flag(extra > 0.1 * planned_out ? "MEDIUM" : "LOW", "OUTPUT_OVER_PLAN", `${f(order_out)} cases made against ${f(planned_out)} planned (${fs(extra)}, ${pct(extra / planned_out, 0, true)}).`);
    } else if (planned_out && order_out < planned_out - Math.max(1, 0.02 * planned_out)) {
      const left = planned_out - order_out;
      if (out_open) flag("INFO", "OUTPUT_STILL_OPEN", `${f(out_open)} of ${f(planned_out)} planned cases still open to make.`);
      else flag("LOW", "OUTPUT_SHORT_OF_PLAN", `${f(order_out)} of ${f(planned_out)} planned cases made and nothing left open (${f(-left)}); order status ${status}.`);
    }

    // inputs on the order: fulfilled vs what the fulfilled output needs
    const scale = planned_out ? order_out / planned_out : null;
    const compRows = [], short = [], over = [];
    const cheeseComps = comps.filter((c) => isCheese(c.material));
    for (const c of comps) {
      const need = scale !== null ? c.planned * scale : null;
      const booked = isNaN(c.fulfilled) ? 0 : c.fulfilled;
      compRows.push({ material: c.material, planned: c.planned, fulfilled: booked, open: c.open, needed_for_output: need,
        difference: need !== null ? booked - need : null, cheese: isCheese(c.material) });
      if (isCheese(c.material) || need === null || !(need > 0)) continue;
      if (booked < need - Math.max(2, 0.03 * need)) short.push([c.material, booked, need]);
      else if (booked > need + Math.max(2, 0.1 * need)) over.push([c.material, booked, need]);
    }
    if (short.length) {
      const worst = Math.max(...short.map(([, fl, e]) => (e - fl) / e));
      flag(worst > 0.1 ? "HIGH" : "MEDIUM", "INPUTS_SHORT_FOR_OUTPUT", `For the ${f(order_out)} cases on the order the recipe needs more than was issued: ` + short.map(([m, fl, e]) => `${m} ${f(fl, 2)} issued vs ${f(e, 2)} needed`).join("; ") + ".");
    }
    if (over.length) flag("LOW", "INPUTS_OVER_FOR_OUTPUT", `More issued than the ${f(order_out)} cases need: ` + over.map(([m, fl, e]) => `${m} ${f(fl, 2)} issued vs ${f(e, 2)} needed`).join("; ") + ".");

    // cheese issued to the order
    let perCase = planned_out && cheeseComps.length ? sum(cheeseComps.map((c) => c.planned)) / planned_out : null;
    let rec = null;
    if (perCase) {
      const stC = comps.filter((c) => RULES.not_cheese_prefixes.some((p) => c.material.toUpperCase().startsWith(p)));
      const offC = idx.byp.get(oid) || [];
      const pCh = sum(cheeseComps.map((c) => c.planned)), pSt = sum(stC.map((c) => c.planned)), pOf = sum(offC.map((b) => (isNaN(b.planned) ? 0 : b.planned)));
      const [cwO] = caseWeight(o.fg_text, (pCh + pSt - pOf) / planned_out, o.fg, ctx.codeWeights);
      rec = recipePerCase(pCh, pSt, pOf, planned_out, cwO);
      perCase = rec.cheese_pc;
    }
    const issued = sum(cheeseComps.map((c) => (isNaN(c.fulfilled) ? 0 : c.fulfilled)));
    const cheeseOpen = sum(cheeseComps.map((c) => (isNaN(c.open) ? 0 : c.open)));
    const needed = perCase ? perCase * order_out : null;
    let cheeseSource = null;
    const hasCons = ctx.hasCons, cons = hasCons ? idx.cons.get(oid) || [] : [];
    if (needed && order_out > 0 && !hasCons) {
      const lines = cheeseComps.map((c) => `${c.material} ${f(isNaN(c.fulfilled) ? 0 : c.fulfilled, 2)} of ${f(c.planned * scale, 2)} kg`).join("; ");
      if (issued === 0) {
        cheeseSource = "journal";
        flag("INFO", "CHEESE_NOT_ON_ORDER_SHEET", `No cheese issue shows on the order sheet (${lines}), so cheese input is estimated from the confirmation journal (cheese moved to the line during the run).`);
      } else {
        cheeseSource = "order";
        const tol = Math.max(RULES.tolerance_pct * needed, RULES.tolerance_kg);
        cheese_diff = issued - needed; cheese_tol = tol;
        const msg = `Cheese issued ${f(issued, 1)} kg, the ${f(order_out)} cases need ${f(needed, 1)} kg (${fixed(perCase, 3)} kg/case): ${lines}.`;
        if (Math.abs(cheese_diff) <= tol) flag("INFO", "CHEESE_BALANCES", msg + ` Difference ${fs(cheese_diff, 1)} kg is within tolerance.`);
        else {
          let sev = Math.abs(cheese_diff) > Math.max(3 * tol, 500) ? "HIGH" : "MEDIUM", extra = "";
          if (cheese_diff < 0 && cheese.length) {
            // the order sheet can miss issues: check the journal estimate too
            const moved = sum(cheese.map((c) => c.sent - c.returned));
            extra = ` The journal shows about ${f(moved, 1)} kg moved to the line for this run`;
            if (moved >= needed - tol) { sev = "MEDIUM"; extra += ", enough for the output, so the order sheet is probably missing issues."; } else extra += ".";
          }
          flag(sev, cheese_diff > 0 ? "CHEESE_OVER_ISSUED" : "CHEESE_UNDER_ISSUED", msg + ` Difference ${fs(cheese_diff, 1)} kg (${pct(cheese_diff / needed, 1, true)}).` + extra);
        }
        // blend: shares of the block cheeses (offcut bins can stand in for their own cheese)
        const plan = {}, got = {}; let pt = 0, gt = 0;
        for (const c of cheeseComps) {
          if (c.material.toUpperCase().startsWith("MB")) continue;
          const g = isNaN(c.fulfilled) ? 0 : c.fulfilled;
          plan[c.material] = (plan[c.material] || 0) + c.planned; got[c.material] = (got[c.material] || 0) + g; pt += c.planned; gt += g;
        }
        const mats = Object.keys(plan).sort();
        if (mats.length > 1 && gt > 0) {
          const off = mats.map((m) => [m, got[m] / gt, plan[m] / pt]).filter(([, a2, sh]) => Math.abs(a2 - sh) > RULES.blend_tolerance);
          if (off.length) flag("MEDIUM", "BLEND_SPLIT_OFF", "Cheese issued in a different split from the recipe: " + off.map(([m, a2, sh]) => `${m} ${pct(a2, 0)} vs ${pct(sh, 0)} planned`).join("; ") + ".");
        }
      }
    }

    // estimate from the journal when the order sheet shows no cheese: the journal has no cheese
    // consumption lines, so cheese moved to the job's line during its run, less moved away again
    const sent = cheese.length ? sum(cheese.map((s) => s.sent)) : 0, back = cheese.length ? sum(cheese.map((s) => s.returned)) : 0;
    const used = sent - back;
    const estOut = journal_out || order_out, estNeeded = perCase ? perCase * estOut : null;
    if (cheeseSource === "journal" && estNeeded) {
      const materials = [...new Set(cheeseComps.map((c) => c.material))].sort();
      const moved = new Set(cheese.map((c) => c.material));
      const notMoved = materials.filter((m) => !moved.has(m) && !m.toUpperCase().startsWith("MB"));
      if (!cheese.length) {
        flag("MEDIUM", "NO_CHEESE_SEEN", `No cheese for this job shows anywhere: nothing issued on the order sheet and none of ${materials.join(", ")} moved to ${area || "the line"} during the run.`);
      } else {
        const tol = Math.max(RULES.tolerance_pct * estNeeded, RULES.tolerance_kg);
        cheese_diff = used - estNeeded; cheese_tol = tol;
        const msg = `Estimate from the journal: ${f(sent, 1)} kg moved to ${area}, ${f(back, 1)} kg moved away again, so about ${f(used, 1)} kg used. The ${f(estOut)} cases ${journal_out ? "in the journal " : ""}need ${f(estNeeded, 1)} kg (${fixed(perCase, 3)} kg/case).`;
        if (notMoved.length) flag("INFO", "CHEESE_FROM_STORE", `${notMoved.join(", ")} never moved to ${area} during the run: issued straight from store or already on the line, so it isn't in the journal estimate.`);
        if (Math.abs(cheese_diff) <= tol) flag("INFO", "CHEESE_BALANCES_EST", msg + ` Difference ${fs(cheese_diff, 1)} kg is within tolerance.`);
        else flag("MEDIUM", cheese_diff > 0 ? "CHEESE_OVER_EST" : "CHEESE_UNDER_EST", msg + ` Difference ${fs(cheese_diff, 1)} kg (${pct(cheese_diff / estNeeded, 1, true)}).`);
        const shared = cheese.filter((c) => c.candidates > 1);
        if (shared.length) {
          const others = [...new Set(shared.map((c) => c.other_orders).join(", ").split(", "))].filter(Boolean).sort();
          flag("INFO", "CHEESE_SHARED_LINE", `${shared.length} cheese move(s) (${f(sum(shared.map((c) => c.sent)), 1)} kg) on ${area} could also belong to order(s) ${others.join(", ")}, on ${area} around the same time; they were given to this order because it was already running or its next output followed soonest.`);
        }
      }
    }

    // cheese consumed, from the journal's production confirmations
    let mass = null, consumedIn = null, needIn = null;
    // sums rounded to 6 decimals so the float summing order can't tip a displayed figure
    const r6 = (x) => Number(x.toFixed(6));
    const consumed = r6(sum(cons.map((c) => c.consumed)));
    const byMat = new Map();
    for (const c of cons) byMat.set(c.material, (byMat.get(c.material) || 0) + c.consumed);
    for (const [k, v] of byMat) byMat.set(k, r6(v));
    if (hasCons && perCase && (journal_out || order_out)) {
      cheeseSource = "consumed";
      const plan = new Map(); let pt = 0;
      for (const c of cheeseComps) { plan.set(c.material, (plan.get(c.material) || 0) + c.planned); pt += c.planned; }
      const mats = [...plan.keys()].sort();
      const share = new Map(mats.map((m) => [m, plan.get(m) / pt]));
      // what goes in per case is cheese and starch (197 + 3 kg for a 200 kg dolav): both sides include starch
      const stPc = rec.starch_pc, inPc = rec.in_pc;
      const starchUsedO = ctx.starchUsed.get(oid) || 0;
      consumedIn = r6(consumed + starchUsedO);
      needIn = inPc * estOut;
      const cheeseNeed = perCase * estOut;
      let matsTxt = mats.map((m) => `${m} ${f(byMat.get(m) || 0, 1)} of ${f(share.get(m) * cheeseNeed, 1)} kg`).join("; ");
      if (stPc) matsTxt += `; starch ${f(starchUsedO, 1)} of ${f(stPc * estOut, 1)} kg`;
      const others = [...byMat.keys()].filter((m) => !share.has(m)).sort();
      const sheet = issued ? ` The order sheet shows ${f(issued, 1)} kg of cheese issued.` : " None of the cheese shows on the order sheet.";
      const otherOut = journal_out && order_out !== journal_out ? ` (the order shows ${f(order_out)} cases, which need ${f(inPc * order_out, 1)} kg)` : "";
      // mass balance: everything in (cheese blocks, offcuts, starch) vs everything out (product, offcuts made).
      // Product weight per case comes from the recipe: cheese + starch planned, less the offcuts planned, over the planned cases.
      const starchComps = comps.filter((c) => RULES.not_cheese_prefixes.some((p) => c.material.toUpperCase().startsWith(p)));
      const pCheese = sum(cheeseComps.map((c) => c.planned)), pStarch = sum(starchComps.map((c) => c.planned));
      const offc = idx.byp.get(oid) || [];
      const pOff = sum(offc.map((b) => (isNaN(b.planned) ? 0 : b.planned))), madeOff = sum(offc.map((b) => (isNaN(b.fulfilled) ? 0 : b.fulfilled)));
      const netPc = rec.net_pc;
      const starchIn = ctx.starchUsed.get(oid) || 0;
      const offcutIn = sum([...byMat.keys()].sort().filter((m) => RULES.offcut_pattern.test(m.toUpperCase())).map((m) => byMat.get(m)));
      const massIn = consumed + starchIn, productKg = estOut * netPc, massOut = productKg + madeOff, unacc = massIn - massOut;
      const massTol = Math.max(RULES.tolerance_pct * massIn, RULES.tolerance_kg);
      const offScale = pOff ? (estOut * rec.off_pc) / pOff : 0;
      mass = { in: massIn, blocks_in: consumed - offcutIn, offcuts_in: offcutIn, starch_in: starchIn, out: massOut, product: productKg,
        kg_per_case: netPc, cases: estOut, offcuts_made: madeOff, offcuts_planned: pOff * offScale, unaccounted: unacc, tolerance: massTol };
      const massText = `In ${f(massIn, 1)} kg (cheese blocks ${f(consumed - offcutIn, 1)}, offcuts ${f(offcutIn, 1)}, starch ${f(starchIn, 1)}); out ${f(massOut, 1)} kg (product ${f(estOut)} cases × ${fixed(netPc, 3)} kg = ${f(productKg, 1)}, offcuts made ${f(madeOff, 1)}).`;
      if (!cons.length) {
        mass = null;
        const moved = sent ? ` ${f(sent, 1)} kg was moved to ${area} during the run.` : "";
        flag("HIGH", "CHEESE_NOT_CONSUMED", `No cheese consumption in the journal for this run: the ${f(estOut)} cases need ${f(needIn, 1)} kg of cheese and starch (${fixed(inPc, 3)} kg/case)${otherOut}.${moved}${sheet}`);
      } else {
        const tol = Math.max(RULES.tolerance_pct * needIn, RULES.tolerance_kg);
        cheese_diff = consumedIn - needIn; cheese_tol = tol;
        const msg = `Cheese and starch consumed ${f(consumedIn, 1)} kg, the ${f(estOut)} cases ${journal_out ? "in the journal " : ""}need ${f(needIn, 1)} kg (${fixed(inPc, 3)} kg/case)${otherOut}: ${matsTxt}`
          + (others.length ? `; also ${others.map((m) => `${m} ${f(byMat.get(m), 1)} kg`).join(", ")}` : "") + "." + sheet
          + (rec.corrected ? ` The recipe plans ${f(rec.recipe_net, 3)} kg per case for a ${f(rec.case_weight, 3)} kg case, so it's scaled to the case weight.` : "");
        const cheeseOff = Math.abs(cheese_diff) > tol;
        if (!cheeseOff) flag("INFO", "CHEESE_BALANCES", msg + ` Difference ${fs(cheese_diff, 1)} kg is within tolerance.`);
        else if (pOff > 0 && Math.abs(unacc) <= massTol) {
          // the extra (or missing) cheese came out as more (or fewer) offcuts than planned
          flag("LOW", cheese_diff > 0 ? "CHEESE_OVER_USED" : "CHEESE_UNDER_USED", msg + ` Difference ${fs(cheese_diff, 1)} kg (${pct(cheese_diff / needIn, 1, true)}). Everything that went in came out as product or offcuts (offcuts made ${f(madeOff, 1)} kg against ${f(pOff * offScale, 1)} planned for these cases), so this is offcut yield, not missing cheese.`);
        } else flag(Math.abs(cheese_diff) > Math.max(3 * tol, 500) ? "HIGH" : "MEDIUM", cheese_diff > 0 ? "CHEESE_OVER_USED" : "CHEESE_UNDER_USED", msg + ` Difference ${fs(cheese_diff, 1)} kg (${pct(cheese_diff / needIn, 1, true)}).`);
        if (Math.abs(unacc) <= massTol) flag("INFO", "MASS_BALANCES", massText + ` Unaccounted ${fs(unacc, 1)} kg is within tolerance.`);
        else {
          const same = cheeseOff && (cheese_diff > 0) === (unacc > 0);
          const sev = same ? "INFO" : Math.abs(unacc) > Math.max(3 * massTol, 500) ? "HIGH" : "MEDIUM";
          if (unacc > 0) flag(sev, "MASS_UNACCOUNTED", massText + ` ${f(unacc, 1)} kg (${pct(unacc / massIn, 1)}) went in but didn't come out as product or offcuts: waste, giveaway, or output or offcuts not posted.`);
          else flag(sev, "MASS_OUT_EXCEEDS_IN", massText + ` ${f(-unacc, 1)} kg more came out than went in: inputs used but not consumed in SAP, or output overstated.`);
        }
        if (pOff > 0 && massIn > 0) {
          const planRate = pOff / (pCheese + pStarch), rate = madeOff / massIn, extra = madeOff - planRate * massIn;
          if (order_out > 0 && madeOff === 0) flag("LOW", "OFFCUTS_NOT_DECLARED", `No offcuts declared on the order (${f(pOff, 1)} kg planned, ${[...new Set(offc.map((b) => b.material))].sort().join(", ")}).`);
          else if (rate - planRate > RULES.offcut_tolerance && extra >= 25) flag("MEDIUM", "OFFCUTS_OVER_PLAN", `Offcuts made ${f(madeOff, 1)} kg, ${pct(rate, 1)} of what went in against ${pct(planRate, 1)} planned (${fs(extra, 1)} kg): ${offc.map((b) => `${b.material} ${f(isNaN(b.fulfilled) ? 0 : b.fulfilled, 1)} kg`).join(", ")}.`);
        }
        const blocks = mats.filter((m) => !m.toUpperCase().startsWith("MB"));
        const bt = sum(blocks.map((m) => share.get(m))), gt = sum(blocks.map((m) => byMat.get(m) || 0));
        if (blocks.length > 1 && gt > 0) {
          const off = blocks.map((m) => [m, (byMat.get(m) || 0) / gt, share.get(m) / bt]).filter(([, a2, sh]) => Math.abs(a2 - sh) > RULES.blend_tolerance);
          if (off.length) flag("MEDIUM", "BLEND_SPLIT_OFF", "Cheese consumed in a different split from the recipe: " + off.map(([m, a2, sh]) => `${m} ${pct(a2, 0)} vs ${pct(sh, 0)} planned`).join("; ") + ".");
        }
        const shared = cons.filter((c) => c.candidates > 1);
        if (shared.length) {
          const oth = [...new Set(shared.map((c) => c.other_orders).join(", ").split(", "))].filter(Boolean).sort();
          flag("INFO", "CHEESE_SHARED_LINE", `${shared.length} consumption posting(s) (${f(sum(shared.map((c) => c.consumed)), 1)} kg) on ${area} could also belong to order(s) ${oth.join(", ")}, on ${area} around the same time; they were given to this order because it was already running or its next output followed soonest.`);
        }
      }
      const seenB = new Set(), over = [];
      for (const c of cons) {
        const k = c.material + "\u0000" + c.batch;
        if (seenB.has(k)) continue; seenB.add(k);
        if (ctx.overBatches.has(k)) over.push([c.material, c.batch, ...ctx.overBatches.get(k)]);
      }
      if (over.length) flag("MEDIUM", "BATCH_OVER_CONSUMED", "Batch consumed for more than it held: " + over.map(([m, b, u, sz]) => `${m} ${b} consumed ${f(u, 2)} kg in total (this job ${f(sum(cons.filter((c) => c.material === m && c.batch === b).map((c) => c.consumed)), 2)}), largest quantity posted for it ${f(sz, 2)} kg`).join("; ") + ".");
    }

    const offcuts = idx.byp.get(oid) || [];
    const variance = varianceView(o, comps, cheeseComps, offcuts, order_out, journal_out, cheeseSource, consumed, ctx.starchUsed.get(oid) || 0, issued, used, ctx.codeWeights, rec);
    let reasons = [];
    if (variance) {
      const blocks = [...new Set(cheeseComps.map((c) => c.material))].filter((m) => !RULES.offcut_pattern.test(m.toUpperCase())).sort();
      reasons = varianceReasons(oid, variance, cons, cheese, w, hasCons ? ctx.consumption : null, new Set(findings.map((x) => x.code)),
        hasCons ? blocks : [], new Set(cheeseComps.map((c) => c.material)), byMat, ctx);
    }
    const summary = {
      order_id: oid, status: o.status, fg, fg_text: o.fg_text, line: o.resource, area, start: o.start, last_regular_output: last,
      planned_out, order_out, journal_out, output_confirmations: confs.length, cheese_kg_per_case: perCase,
      cheese_source: cheeseSource, cheese_issued_kg: issued, cheese_needed_kg: needed, cheese_open_kg: cheeseOpen,
      cheese_sent_kg: sent, cheese_returned_kg: back, cheese_used_kg: used, cheese_est_needed_kg: cheeseSource === "consumed" ? needIn : estNeeded, cheese_est_output: estOut, cheese_consumed_kg: consumed, cheese_consumed_by_material: Object.fromEntries(byMat), mass, variance, variance_reasons: reasons,
      cheese_planned_kg: sum(cheeseComps.map((c) => c.planned)), starch_planned_kg: sum(comps.filter((c) => RULES.not_cheese_prefixes.some((p) => c.material.toUpperCase().startsWith(p))).map((c) => c.planned)), input_kg_per_case: rec ? rec.in_pc : null, input_consumed_kg: cheeseSource === "consumed" ? consumed + (ctx.starchUsed.get(oid) || 0) : null, cheese_planned_offcuts_kg: sum(cheeseComps.filter((c) => RULES.offcut_pattern.test(c.material.toUpperCase())).map((c) => c.planned)), consumption: cons.slice().sort((a, b) => a.time - b.time), offcuts_kg: sum(offcuts.map((b) => (isNaN(b.fulfilled) ? 0 : b.fulfilled))),
      cheese_diff_kg: cheese_diff, cheese_tolerance_kg: cheese_tol, components: compRows,
      outputs: out.slice().sort((a, b) => a.time - b.time), confirmations: confs, cheese_moves: cheese.slice().sort((a, b) => a.time - b.time),
    };
    findings.sort((a, b) => SEV[a.severity] - SEV[b.severity]);
    return { summary, findings };
  }

  function pairCarryOver(results, ctx) {
    const byId = new Map(results.map((r) => [r.summary.order_id, r.summary]));
    const seq = ctx.orders.filter((o) => byId.has(o.order_id) && !isNaN(o.start)).sort((a, b) => a.start - b.start);
    const replace = new Map();
    for (const [res, g] of groupBy(seq, "resource")) {
      const ids = g.map((o) => o.order_id);
      for (let i = 0; i + 1 < ids.length; i++) {
        const a = ids[i], b = ids[i + 1], sa = byId.get(a), sb = byId.get(b);
        const da = sa.cheese_diff_kg, db = sb.cheese_diff_kg;
        if (sa.cheese_source !== "journal" || sb.cheese_source !== "journal") continue;
        if (da === null || db === null || replace.has(a) || replace.has(b)) continue;
        if (Math.abs(da) <= sa.cheese_tolerance_kg || Math.abs(db) <= sb.cheese_tolerance_kg || !(da > 0 && db < 0)) continue;
        const endA = !isNaN(sa.last_regular_output) ? sa.last_regular_output : sa.start;
        if (isNaN(endA) || isNaN(sb.start) || sb.start - endA > 12 * H) continue;
        if (Math.abs(da + db) / Math.max(Math.abs(da), Math.abs(db)) > 0.35) continue;
        const msg = `Orders ${a} and ${b} ran one after the other on ${res}: ${a} is ${fs(da, 1)} kg on the journal estimate and ${b} is ${fs(db, 1)} kg (net ${fs(da + db, 1)} kg). Cheese left on the line after the first job was used by the next one without being returned and re-issued in SAP.`;
        for (const oid of [a, b]) replace.set(oid, { order_id: oid, severity: "MEDIUM", code: "CHEESE_CARRIED_OVER", message: msg });
      }
    }
    for (const r of results) {
      const rep = replace.get(r.summary.order_id);
      if (!rep) continue;
      const i = r.findings.findIndex((x) => x.code === "CHEESE_OVER_EST" || x.code === "CHEESE_UNDER_EST");
      if (i >= 0) { r.findings[i] = rep; r.findings.sort((a, b) => SEV[a.severity] - SEV[b.severity]); }
    }
  }

  // ------------------------------------------------------------ entry points
  function prepare(wb) {
    const orders = wb.orders.filter((o) => !RULES.skip_resources.includes(o.resource));
    const outputs = assignOutputs(wb);
    const perConf = perConfirmation(outputs);
    const windows = orderWindows(orders, perConf);
    const sends = assignCheese(wb, windows, perConf);
    // journals exported with both sides carry cheese consumption; receiving-only exports don't
    const hasCons = consumptionRows(wb.journal).some((r) => r.qty < 0 && !RULES.offcut_pattern.test(r.material.toUpperCase()));
    const consumption = hasCons ? assignConsumption(wb, windows, perConf, outputs) : [];
    const overBatches = hasCons ? overConsumedBatches(wb.journal) : new Map();
    const starchUsed = hasCons ? starchConsumed(wb.journal, outputs) : new Map();
    const consumedByBatch = new Map(), movesByBatch = new Map();
    if (hasCons) for (const r of consumptionRows(wb.journal)) { const k = r.material + "\u0000" + r.batch; consumedByBatch.set(k, (consumedByBatch.get(k) || 0) - r.qty); }
    for (const r of wb.journal) if (!r.is_prod && r.qty > 0) { const k = r.material + "\u0000" + r.batch; if (!movesByBatch.has(k)) movesByBatch.set(k, []); movesByBatch.get(k).push(r); }
    for (const g of movesByBatch.values()) g.sort((a, b) => a.time - b.time);
    const idx = {
      orders: new Map(orders.map((o) => [o.order_id, o])), comps: groupBy(wb.components, "order_id"),
      windows: new Map(windows.map((w) => [w.order_id, w])), outputs: groupBy(outputs.filter((r) => r.order_id !== null), "order_id"),
      perConf: groupBy(perConf, "order_id"), sends: groupBy(sends, "order_id"), cons: groupBy(consumption.filter((c) => c.order_id !== null), "order_id"), byp: groupBy(wb.byproducts, "order_id"),
    };
    const active = new Set([...idx.outputs.keys(), ...idx.sends.keys()]);
    const seqByRes = new Map();
    for (const o of orders.filter((o) => !isNaN(o.start)).sort((a, b) => a.start - b.start)) {
      if (!seqByRes.has(o.resource)) seqByRes.set(o.resource, []);
      seqByRes.get(o.resource).push(o.order_id);
    }
    let jmin = Infinity, jmax = -Infinity;
    for (const r of wb.journal) { if (r.time < jmin) jmin = r.time; if (r.time > jmax) jmax = r.time; }
    const journalRange = wb.journal.length ? [jmin, jmax] : null;
    return { wb, orders, outputs, sends, idx, active, seqByRes, hasCons, overBatches, starchUsed, codeWeights: learnPackCodes(wb.orders), consumption, consumedByBatch, movesByBatch, typical: typicalPallets(outputs), journalRange,
      unassigned: outputs.filter((r) => r.order_id === null) };
  }

  function verdict(findings) {
    const s = new Set(findings.map((x) => x.severity));
    return s.has("HIGH") ? "PROBLEMS" : s.has("MEDIUM") ? "CHECK" : "OK";
  }

  // Check the requested orders; the jobs just before and after each on the same line are checked too,
  // so cheese carried from one job to the next is recognised.
  function check(ctx, orderIds) {
    const wanted = orderIds.map((x) => String(x).trim()).filter(Boolean);
    const known = wanted.filter((o) => ctx.idx.orders.has(o));
    const toCheck = [...known];
    for (const ids0 of ctx.seqByRes.values()) {
      const ids = ids0.filter((o) => ctx.active.has(o) || toCheck.includes(o));
      ids.forEach((o, i) => { if (wanted.includes(o)) for (const n of ids.slice(Math.max(i - 1, 0), i + 2)) if (!toCheck.includes(n)) toCheck.push(n); });
    }
    const results = toCheck.map((oid) => checkOrder(oid, ctx));
    pairCarryOver(results, ctx);
    const keep = results.filter((r) => wanted.includes(r.summary.order_id));
    keep.forEach((r) => (r.verdict = verdict(r.findings)));
    return { results: keep, missing: wanted.filter((o) => !ctx.idx.orders.has(o)) };
  }

  const sheetKinds = (sheets) => [...new Set(sheets.map((sh) => findHeader(sh.rows)[0]).filter(Boolean))].sort();
  const api = { RULES, readWorkbook, sheetKinds, prepare, check, verdict, isCheese, fmt: { f, fs, dm, dmy } };
  root.OrderCheck = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
