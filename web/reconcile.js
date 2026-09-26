// Browser port of sap_variance/reconcile.py: check production orders against the confirmation
// journal of the ByDesign workbook. Same rules, thresholds and messages - keep them in step.
(function (root) {
  "use strict";

  const RULES = {
    line_areas: { SLICING_L1: "SL_1", SLICING_L2: "SL_2", SLICING_L3: "SL_3", GRATING_L4: "GRATINGLINES", GRATING_L5: "GRATINGLINES" },
    skip_resources: ["FLOOR_WASTE", "LINE_RECOVERY"],
    cheese_prefixes: ["RM"], not_cheese_prefixes: ["RMPS"], offcut_pattern: /^MB.*OFF$/,
    lead_hours: 2, tail_hours: 1, return_hours: 24, order_start_slack_hours: 1, max_order_age_hours: 72,
    bulk_pallets: 4, late_hours: 2, tolerance_pct: 0.05, tolerance_kg: 50, blend_tolerance: 0.08,
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
    for (let i = 0; i < Math.min(6, rows.length); i++) {
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

  // sheets: [{file, sheet, rows: [[...], ...]}]
  function readWorkbook(sheets) {
    const found = {}, names = {};
    for (const sh of sheets) {
      const [kind, h] = findHeader(sh.rows);
      if (!kind) continue;
      const fr = frame(sh.rows, h);
      if (found[kind]) found[kind].rows.push(...fr.rows); else found[kind] = fr;
      names[kind] = `${sh.file} [${sh.sheet}]`;
    }
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

    // journal
    const jf = found.journal;
    const bc = col(jf, "identifiedstock"), ac = col(jf, "logisticsarea");
    const journal = [];
    for (const r of jf.rows) {
      const t = time(r.createdon), q = num(r.effectiveqty);
      if (isNaN(t) || isNaN(q)) continue;
      const doc = String(r.confdocumenttype);
      journal.push({ site: r.site, material: str(r.product), batch: id(r[bc]), area: str(r[ac]), time: t, doc,
        conf: id(r.confid), qty: q, is_prod: /production/i.test(doc) });
    }

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
    return out;
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

  function assignCheese(wb, windows, perConf) {
    const recipe = {};
    for (const c of wb.components) if (isCheese(c.material)) (recipe[c.order_id] ||= new Set()).add(c.material);
    const moves = wb.journal.filter((r) => !r.is_prod && r.qty > 0);
    const lineAreas = new Set(Object.values(RULES.line_areas));
    const arrivals = moves.filter((r) => isCheese(r.material) && lineAreas.has(r.area));
    const nextOut = {};
    for (const c of perConf) if (c.pallets < RULES.bulk_pallets) (nextOut[c.order_id] ||= []).push(c.time);
    for (const k in nextOut) nextOut[k].sort((a, b) => a - b);
    const winsByArea = {};
    for (const w of windows) if (w.area && !isNaN(w.begin) && !isNaN(w.end)) (winsByArea[w.area] ||= []).push(w);
    const starts = {}, resources = {};
    for (const w of windows) { starts[w.order_id] = w.start; resources[w.order_id] = w.resource; }
    const sends = [];
    for (const r of arrivals) {
      const cands = (winsByArea[r.area] || []).filter((w) => w.begin <= r.time && w.end >= r.time && recipe[w.order_id]?.has(r.material)).map((w) => w.order_id);
      if (!cands.length) continue;
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
      for (const v of m.values()) { const k = Math.round(v); counts.set(k, (counts.get(k) || 0) + 1); }
      let best = null, bc = -1;
      for (const [v, c] of counts) if (c > bc || (c === bc && v < best)) { best = v; bc = c; }
      if (best >= 10) out[fg] = best;
    }
    return out;
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
    const perCase = planned_out && cheeseComps.length ? sum(cheeseComps.map((c) => c.planned)) / planned_out : null;
    const issued = sum(cheeseComps.map((c) => (isNaN(c.fulfilled) ? 0 : c.fulfilled)));
    const cheeseOpen = sum(cheeseComps.map((c) => (isNaN(c.open) ? 0 : c.open)));
    const needed = perCase ? perCase * order_out : null;
    let cheeseSource = null;
    if (needed && order_out > 0) {
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

    const offcuts = idx.byp.get(oid) || [];
    const summary = {
      order_id: oid, status: o.status, fg, fg_text: o.fg_text, line: o.resource, area, start: o.start, last_regular_output: last,
      planned_out, order_out, journal_out, output_confirmations: confs.length, cheese_kg_per_case: perCase,
      cheese_source: cheeseSource, cheese_issued_kg: issued, cheese_needed_kg: needed, cheese_open_kg: cheeseOpen,
      cheese_sent_kg: sent, cheese_returned_kg: back, cheese_used_kg: used, cheese_est_needed_kg: estNeeded, cheese_est_output: estOut, offcuts_kg: sum(offcuts.map((b) => (isNaN(b.fulfilled) ? 0 : b.fulfilled))),
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
    const idx = {
      orders: new Map(orders.map((o) => [o.order_id, o])), comps: groupBy(wb.components, "order_id"),
      windows: new Map(windows.map((w) => [w.order_id, w])), outputs: groupBy(outputs.filter((r) => r.order_id !== null), "order_id"),
      perConf: groupBy(perConf, "order_id"), sends: groupBy(sends, "order_id"), byp: groupBy(wb.byproducts, "order_id"),
    };
    const active = new Set([...idx.outputs.keys(), ...idx.sends.keys()]);
    const seqByRes = new Map();
    for (const o of orders.filter((o) => !isNaN(o.start)).sort((a, b) => a.start - b.start)) {
      if (!seqByRes.has(o.resource)) seqByRes.set(o.resource, []);
      seqByRes.get(o.resource).push(o.order_id);
    }
    const journalRange = wb.journal.length ? [Math.min(...wb.journal.map((r) => r.time)), Math.max(...wb.journal.map((r) => r.time))] : null;
    return { wb, orders, outputs, sends, idx, active, seqByRes, typical: typicalPallets(outputs), journalRange,
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

  const api = { RULES, readWorkbook, prepare, check, verdict, isCheese, fmt: { f, fs, dm, dmy } };
  root.OrderCheck = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
