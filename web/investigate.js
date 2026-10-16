// The variance investigator: one production order's variance, where it came from, and the other jobs it touched,
// over a week or two of the confirmation journal (the checker's SAP files; reconcile.js does the checking).
//
// Cheese can't appear or vanish: when a job's output has no cheese booked for it, the blocks it used are still in SAP,
// and they turn up somewhere else: booked to another job (which then looks over), left on the line area as stock SAP
// thinks is there, moved back, or written off. So the investigation follows the batches:
//   - for the job itself: batches moved to its line during its run but not booked to it, batches booked to it that were
//     moved to the line for another job (or after its run, or that SAP had none of), and where each one went;
//   - the other jobs in the window: those tied to it by a batch, and those off by about the same amount the other way
//     with the same cheese (on the same line and close in time counting most), with the best combination that cancels;
//   - the window as a whole: whether the jobs using this cheese net out (cheese booked to the wrong job) or not
//     (cheese really missing, or extra);
//   - stock SAP still shows on the lines, and batches SAP consumed more of than it had.
// Sign: + is cheese booked with no output for it, - is output with no cheese booked for it.
(function (root) {
  "use strict";
  const R = root.OrderCheck || (typeof require === "function" ? require("./reconcile.js") : null);
  const H = 3600000, DAY = 24 * H, KG = 1, STOCK_KG = 10;   // KG: under 1 kg is rounding; STOCK_KG: leftovers worth a look
  const { f, fs, dm } = R.fmt;
  const isOff = (m) => R.RULES.offcut_pattern.test(String(m).toUpperCase());
  const LINE_AREAS = new Set(Object.values(R.RULES.line_areas));
  const kg = (v) => `${f(v, 1)} kg`;

  // a job's variance: the mass balance (everything in against everything out) where it can be worked out, else the
  // cheese balance
  function measure(s) {
    if (s.mass) return { kind: "mass", v: s.mass.unaccounted, tol: s.mass.tolerance };
    if (s.cheese_diff_kg !== null && s.cheese_diff_kg !== undefined) return { kind: "cheese", v: s.cheese_diff_kg, tol: s.cheese_tolerance_kg };
    return null;
  }
  const dirOf = (m) => (!m ? "unknown" : m.v > m.tol ? "over" : m.v < -m.tol ? "short" : "ok");
  // block cheese and offcuts a job used or was meant to use
  function materials(s) {
    const all = new Set([...Object.entries(s.cheese_consumed_by_material || {}).filter(([, v]) => v > 0).map(([m]) => m),
      ...(s.components || []).filter((c) => c.cheese).map((c) => c.material)]);
    return { blocks: [...all].filter((m) => !isOff(m)).sort(), offcuts: [...all].filter(isOff).sort() };
  }
  const describe = (m) => (!m ? "can't be worked out" : m.v > 0 ? `${kg(m.v)} of cheese booked with no output for it` : `${kg(-m.v)} of output with no cheese booked for it`);

  function run(ctx, orderId, days = 7) {
    const oid = String(orderId || "").trim();
    if (!ctx.idx.orders.has(oid)) return { error: `Order ${oid} isn't in the loaded SAP files.` };
    const win = (id) => ctx.idx.windows.get(id);
    const w0 = win(oid);
    const centre = !isNaN(w0.start) ? w0.start : !isNaN(w0.first_out) ? w0.first_out : NaN;
    if (isNaN(centre)) return { error: `Order ${oid} has no start time or output in the loaded files.` };
    const range = ctx.journalRange || [centre, centre];
    const from = Math.max(centre - days * DAY, range[0]), to = Math.min(centre + days * DAY, range[1]);

    // ---------------------------------------------------------------- every job in the window, checked
    const inWindow = ctx.orders.filter((o) => {
      const w = win(o.order_id), t = w && !isNaN(w.start) ? w.start : w ? w.first_out : NaN;
      return o.order_id === oid || (!isNaN(t) && t >= from && t <= to && ctx.active.has(o.order_id));
    }).map((o) => o.order_id);
    const checked = R.check(ctx, inWindow).results;
    const jobs = new Map();
    for (const r of checked) {
      const s = r.summary, w = win(s.order_id), m = measure(s);
      const run0 = !isNaN(s.start) ? s.start : w.first_out, run1 = !isNaN(s.last_regular_output) && s.last_regular_output > run0 ? s.last_regular_output : run0;
      jobs.set(s.order_id, { id: s.order_id, s, verdict: r.verdict, findings: r.findings, m, dir: dirOf(m), line: s.line, area: s.area || w.area,
        fg: s.fg, fg_text: s.fg_text, start: run0, end: run1, begin: w.begin, until: w.end, mats: materials(s) });
    }
    const T = jobs.get(oid);
    const area = T.area || (T.s.consumption || []).map((c) => c.area).find((a) => LINE_AREAS.has(a)) || null;
    const allMats = new Set([...T.mats.blocks, ...T.mats.offcuts]);

    // Which job a move to a line was for: the job on that area whose run it falls in, counting the lead before a start
    // (cheese is moved up before a job starts) and not past its last output (a move after that is for the next job);
    // else the checker's owner of that arrival.
    const LEAD = R.RULES.lead_hours * H;
    const ownerOf = new Map();
    for (const x of ctx.sends) ownerOf.set(`${x.material}\u0000${x.batch}\u0000${x.time}\u0000${x.area}`, x.order_id);
    const jobAt = (a, t) => {
      const c = [...jobs.values()].filter((j) => j.area === a && t >= j.start - LEAD && t <= j.end + 0.25 * H);
      return c.length ? c.sort((x, y) => Math.abs(x.start - t) - Math.abs(y.start - t))[0].id : null;
    };
    const moveOwner = (r) => jobAt(r.area, r.time) || ownerOf.get(`${r.material}\u0000${r.batch}\u0000${r.time}\u0000${r.area}`) || null;

    // ---------------------------------------------------------------- the batches: where this job's variance came from
    const keys = new Map();   // material|batch -> { material, batch }
    for (const c of T.s.consumption || []) if (c.batch !== null) keys.set(c.material + "|" + c.batch, { material: c.material, batch: c.batch });
    for (const r of ctx.wb.journal) {
      if (!r.is_prod && r.qty > 0 && area && r.area === area && r.time >= T.begin && r.time <= T.until && R.isCheese(r.material)) keys.set(r.material + "|" + r.batch, { material: r.material, batch: r.batch });
    }
    const trace = (m, b) => { const t = R.traceStock(ctx, m, b); return t.products.find((p) => p.material === m) || null; };
    const evidence = [];
    for (const { material, batch } of keys.values()) {
      const p = trace(material, batch);
      if (!p) continue;
      const rows = p.rows;
      const stagedRows = rows.filter((r) => !r.is_prod && r.qty > 0 && r.area === area && r.time >= T.begin && r.time <= T.until && [oid, null].includes(moveOwner(r)));
      const staged = stagedRows.reduce((a, r) => a + r.qty, 0);
      const mine = rows.filter((r) => r.order === oid && r.qty < 0);
      const booked = -mine.reduce((a, r) => a + r.qty, 0);
      const others = p.byOrder.filter((o) => o.order !== oid && o.used > KG);
      const lineLeft = new Map();
      for (const r of rows) if (LINE_AREAS.has(r.area)) lineLeft.set(r.area, (lineLeft.get(r.area) || 0) + r.qty);
      const stillOn = [...lineLeft].filter(([, q]) => q > KG);
      const minBal = Math.min(0, ...rows.map((r) => r.balance));
      const odd = rows.filter((r) => !r.is_prod && !/goods and activity|inbound|outbound|goods receipt|delivery/i.test(r.doc));
      const base = { material, batch, staged, booked, rows };

      // moved to the line during this run, not (all) booked to it: where the rest went
      if (staged - booked > KG) {
        const rest = staged - booked, went = [];
        for (const o of others) if (o.last >= T.begin) went.push({ kind: "job", job: o.order, kg: o.used, at: o.first, text: `booked to job ${o.order} (${kg(o.used)}, ${dm(o.first)})` });
        for (const [a, q] of stillOn) went.push({ kind: "line", kg: q, area: a, text: `still on ${a} in SAP (${kg(q)})` });
        for (const r of odd.filter((r) => r.time >= T.begin && r.qty < 0)) went.push({ kind: "adjust", kg: -r.qty, text: `${r.doc} ${kg(-r.qty)} (${dm(r.time)})` });
        const back = rows.filter((r) => !r.is_prod && r.qty > 0 && r.time > T.begin && !LINE_AREAS.has(r.area) && r.area !== "FG_STAGING");
        for (const r of back) went.push({ kind: "back", kg: r.qty, area: r.area, text: `moved to ${r.area} (${kg(r.qty)}, ${dm(r.time)})` });
        evidence.push({ ...base, type: "not_booked", kg: rest, jobs: went.filter((x) => x.kind === "job").map((x) => x.job), went,
          text: `${kg(staged)} moved to ${area} during the run (${stagedRows.map((r) => dm(r.time)).join(", ")}), ${booked > KG ? kg(booked) : "none"} booked to this job`,
          where: went.length ? went.map((x) => x.text).join("; ") : "not booked anywhere in the loaded journal" });
      }
      // booked to this job but moved to the line for another job, after the run, or not at all
      if (booked > KG && booked - staged > KG && !(minBal < -KG && staged > KG)) {
        const moves = rows.filter((r) => !r.is_prod && r.qty > 0 && LINE_AREAS.has(r.area));
        const forOthers = moves.map((r) => ({ r, owner: moveOwner(r) })).filter((x) => x.owner && x.owner !== oid);
        const late = mine.filter((r) => r.time > T.until);
        const extra = booked - staged;
        let where;
        if (forOthers.length) where = forOthers.map((x) => `moved to ${x.r.area} for job ${x.owner} (${kg(x.r.qty)}, ${dm(x.r.time)})`).join("; ");
        else if (moves.some((r) => r.time < T.begin || r.time > T.until)) where = moves.filter((r) => r.time < T.begin || r.time > T.until).map((r) => `moved to ${r.area} ${dm(r.time)}, outside this run`).join("; ");
        else where = "SAP never moved it to a line";
        evidence.push({ ...base, type: "from_elsewhere", kg: extra, jobs: [...new Set(forOthers.map((x) => x.owner))],
          text: `${kg(booked)} booked to this job${late.length ? `, ${dm(late[0].time)} (after the run)` : ""}, ${staged > KG ? kg(staged) : "none"} of it moved to ${area || "the line"} during the run`, where });
      }
      // SAP consumed more of it than it had
      if (minBal < -KG && booked > KG) {
        evidence.push({ ...base, type: "over_consumed", kg: Math.min(-minBal, booked), jobs: others.map((o) => o.order),
          text: `SAP consumed ${kg(-minBal)} more of it than it ever had`, where: `booked to ${[oid, ...others.map((o) => o.order)].map((o) => "job " + o).join(", ")}` });
      }
    }
    // the explanation that fits the direction comes first
    const fits = (e) => (T.dir === "short" ? e.type === "not_booked" : T.dir === "over" ? e.type !== "not_booked" : true);
    evidence.sort((a, b) => Number(fits(b)) - Number(fits(a)) || b.kg - a.kg);
    const explained = evidence.filter(fits).reduce((a, e) => a + e.kg, 0);

    // ---------------------------------------------------------------- the other jobs it touched
    const gapH = (a, b) => Math.max(0, Math.max(a.start, b.start) - Math.min(a.end, b.end)) / H;
    const suspects = [];
    for (const J of jobs.values()) {
      if (J.id === oid || !J.m) continue;
      const shared = J.mats.blocks.filter((m) => T.mats.blocks.includes(m));
      const links = evidence.filter((e) => e.jobs.includes(J.id));
      const linkKg = links.reduce((a, e) => a + (e.type === "not_booked" ? (e.went.find((x) => x.job === J.id) || {}).kg || 0 : e.kg), 0);
      const opposite = T.m && J.dir !== "ok" && J.dir !== "unknown" && Math.sign(J.m.v) === -Math.sign(T.m.v) && T.dir !== "ok";
      if (!links.length && !(opposite && shared.length)) continue;
      const sameLine = J.line === T.line || (!!area && J.area === area);
      const gap = gapH(T, J), cancel = T.m ? Math.abs(T.m.v + J.m.v) / Math.max(Math.abs(T.m.v), Math.abs(J.m.v), 1) : 1;
      const strength = links.length && opposite ? "strong" : links.length ? "linked" : sameLine && gap <= 24 && cancel <= 0.5 ? "likely" : "possible";
      const why = [];
      if (links.length) why.push(`${links.length === 1 ? "batch" : "batches"} ${links.map((e) => e.batch).join(", ")} (${kg(linkKg)}) ${links.some((e) => e.type === "not_booked") ? "moved to the line for this job, booked to it" : "moved to the line for it, booked to this job"}`);
      if (shared.length) why.push(`same cheese (${shared.join(", ")})`);
      why.push(sameLine ? `same line, ${gap < 0.05 ? "at the same time" : `${f(gap, 1)} h apart`}` : `${J.line || J.area}, ${f(gap, 1)} h apart`);
      if (opposite) why.push(`off the other way: together ${fs(T.m.v + J.m.v, 1)} kg`);
      const rank = { strong: 4, linked: 3, likely: 2, possible: 1 }[strength];
      suspects.push({ job: J, strength, rank, shared, links, linkKg, sameLine, gap, cancel, opposite, why });
    }
    suspects.sort((a, b) => b.rank - a.rank || a.cancel - b.cancel || a.gap - b.gap);
    // the jobs off the other way that together cancel this one best (up to three)
    let combo = null;
    if (T.m && T.dir !== "ok") {
      const pool = suspects.filter((x) => x.opposite).slice(0, 10);
      const tryIt = (set) => { const net = T.m.v + set.reduce((a, x) => a + x.job.m.v, 0); if (!combo || Math.abs(net) < Math.abs(combo.net) - 1e-9) combo = { set, net }; };
      for (let i = 0; i < pool.length; i++) { tryIt([pool[i]]); for (let j = i + 1; j < pool.length; j++) { tryIt([pool[i], pool[j]]); for (let k = j + 1; k < pool.length; k++) tryIt([pool[i], pool[j], pool[k]]); } }
      if (combo && Math.abs(combo.net) > 0.35 * Math.abs(T.m.v)) combo = null;
    }

    // ---------------------------------------------------------------- the window: do the jobs on this cheese net out?
    const sameCheese = [...jobs.values()].filter((j) => j.m && j.mats.blocks.some((m) => T.mats.blocks.includes(m)));
    const byLine = new Map();
    for (const j of sameCheese) {
      const k = j.line || j.area || "?";
      const g = byLine.get(k) || { line: k, jobs: 0, net: 0, gross: 0, off: 0 };
      g.jobs++; g.net += j.m.v; if (j.dir !== "ok") { g.gross += Math.abs(j.m.v); g.off++; }
      byLine.set(k, g);
    }
    const lines = [...byLine.values()].sort((a, b) => (b.line === T.line) - (a.line === T.line) || b.gross - a.gross);
    const net = sameCheese.reduce((a, j) => a + j.m.v, 0), gross = sameCheese.filter((j) => j.dir !== "ok").reduce((a, j) => a + Math.abs(j.m.v), 0);
    const netTol = Math.max(R.RULES.tolerance_kg * 2, 0.02 * sameCheese.reduce((a, j) => a + (j.s.cheese_consumed_kg || 0), 0));
    const balance = { jobs: sameCheese.length, net, gross, nets: gross > 0 && Math.abs(net) <= Math.max(netTol, 0.25 * gross), lines };

    // ---------------------------------------------------------------- stock SAP still shows on the lines, or went below zero
    const end = range[1], seen = new Set(), phantom = [], negative = [];
    for (const r of ctx.wb.journal) {
      if (!allMats.has(r.material) || !LINE_AREAS.has(r.area) || r.time < from || r.time > to) continue;
      const k = r.material + "|" + r.batch;
      if (seen.has(k)) continue;
      seen.add(k);
      const p = trace(r.material, r.batch);
      if (!p) continue;
      const left = new Map(), last = new Map();
      for (const x of p.rows) if (LINE_AREAS.has(x.area)) { left.set(x.area, (left.get(x.area) || 0) + x.qty); last.set(x.area, x.time); }
      for (const [a, q] of left) if (q > STOCK_KG && end - last.get(a) > 12 * H) phantom.push({ material: r.material, batch: r.batch, area: a, kg: q, since: last.get(a), owner: p.rows.filter((x) => x.area === a && x.qty > 0).map(moveOwner).filter(Boolean).pop() || null });
      const minBal = Math.min(0, ...p.rows.map((x) => x.balance));
      if (minBal < -STOCK_KG) negative.push({ material: r.material, batch: r.batch, kg: -minBal, jobs: p.byOrder.filter((o) => o.used > KG).map((o) => o.order) });
    }
    phantom.sort((a, b) => b.kg - a.kg); negative.sort((a, b) => b.kg - a.kg);

    // ---------------------------------------------------------------- what it adds up to, in words
    const story = [];
    const s = T.s;
    story.push(T.m
      ? `Job ${oid} (${s.fg}${s.fg_text ? ", " + s.fg_text : ""}) on ${T.line || area}, ${dm(T.start)} to ${dm(T.end)}: ${T.dir === "ok" ? `within tolerance (${fs(T.m.v, 1)} kg against ±${f(T.m.tol, 0)} kg)` : describe(T.m) + ` (tolerance ±${f(T.m.tol, 0)} kg)`}.`
        + (s.cheese_needed_kg ? ` Its output needs ${kg(s.cheese_needed_kg)} of cheese; ${kg(s.cheese_consumed_kg || 0)} was booked.` : "")
      : `Job ${oid}: its variance can't be worked out from the loaded files (no recipe or no consumption).`);
    const nb = evidence.filter((e) => e.type === "not_booked"), fe = evidence.filter((e) => e.type === "from_elsewhere"), oc = evidence.filter((e) => e.type === "over_consumed");
    const period = days >= 7 ? "these two weeks" : "this week";
    if (nb.length) story.push(`${nb.length} batch${nb.length > 1 ? "es" : ""} (${kg(nb.reduce((a, e) => a + e.kg, 0))}) moved to ${area} during the run ${nb.length > 1 ? "were" : "was"} not booked to it: ${nb.map((e) => `${e.batch} (${e.where})`).join("; ")}.`);
    if (fe.length) story.push(`${fe.length} batch${fe.length > 1 ? "es" : ""} booked to it ${fe.length > 1 ? "were" : "was"} not moved to its line during the run: ${fe.map((e) => `${e.batch} (${e.where})`).join("; ")}.`);
    if (oc.length) story.push(`SAP consumed more of ${oc.length > 1 ? "these batches" : "batch"} ${oc.map((e) => `${e.batch} than it ever had (${kg(e.kg)} over; ${e.where})`).join("; ")}: more was booked than was moved in or received.`);
    if (T.dir !== "ok" && T.m && explained > KG) story.push(`The batches account for ${kg(Math.min(explained, Math.abs(T.m.v)))} of the ${kg(Math.abs(T.m.v))}.`);
    const top = suspects.find((x) => x.strength === "strong" || x.strength === "linked") || suspects.find((x) => x.strength === "likely");
    const maybe = !top && suspects[0];
    if (maybe) story.push(`Possibly affected: job ${maybe.job.id} (${maybe.job.line || maybe.job.area}, ${describe(maybe.job.m)}): ${maybe.why.join("; ")}. No batch ties the two: check what moved on and off the lines between them.`);
    if (top) story.push(`Most likely affected: job ${top.job.id} (${top.job.line || top.job.area}, ${describe(top.job.m)}): ${top.why.join("; ")}.`);
    if (combo && combo.set.length > 1) story.push(`Together with ${combo.set.map((x) => "job " + x.job.id).join(" and ")} it nets to ${fs(combo.net, 1)} kg.`);
    if (T.dir !== "ok" && balance.gross > 0) story.push(balance.nets
      ? `Over ${period}, the ${balance.jobs} jobs using ${T.mats.blocks.join(", ")} net to ${fs(balance.net, 1)} kg: the cheese was booked to the wrong jobs rather than lost.`
      : `Over ${period}, the ${balance.jobs} jobs using ${T.mats.blocks.join(", ")} don't net out (${fs(balance.net, 1)} kg): ${balance.net > 0 ? "more cheese was booked than the output needs (waste, giveaway, or output not posted)" : "more output than booked cheese explains (cheese used without booking)"}.`);
    if (phantom.length) story.push(`SAP still shows ${kg(phantom.reduce((a, x) => a + x.kg, 0))} of this cheese on the lines (${phantom.length} batch${phantom.length > 1 ? "es" : ""}): if it isn't there, it was used without being booked.`);
    if (T.dir === "short" && !nb.length) story.push("No batch moved to its line during the run was left unbooked: the blocks it used without booking may have gone to the line without a move in SAP (straight from store, or left from an earlier job).");

    return { order: oid, days, from, to, range, clipped: from > centre - days * DAY || to < centre + days * DAY, area, target: T,
      jobs: [...jobs.values()].sort((a, b) => a.start - b.start), evidence, explained, suspects, combo, balance, phantom, negative, story };
  }

  const api = { run, measure };
  root.Investigate = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
