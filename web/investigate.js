// The variance investigator: one production order's variance, what caused it, which batches and which other jobs
// are involved, over a week or two of the confirmation journal (the checker's SAP files; reconcile.js does the
// checking of each job).
//
// Cheese can't appear or vanish. When a job made output with no cheese booked for it (or booked cheese with no
// output), the explanation is one of these, checked in this order:
//   1. it isn't a cheese problem: the job was still running when the journal was exported, or pallets were confirmed
//      on the wrong order (two jobs of the same product on the same line), or pallets were double booked;
//   2. the batches: a pallet moved to its line during the run and never booked (or booked to another job), cheese left
//      on the line by an earlier job and used without a move, a whole pallet booked within minutes of arriving when only
//      part was used, a pallet moved to the line for another job but booked to this one;
//   3. offcut bags: fewer (or more) bags booked than the same product or cheese takes on other jobs;
//   4. the week: jobs on the same cheese off the other way (cheese booked to the wrong job), and whether the jobs on
//      that cheese net out (booked to the wrong jobs) or not (used, or booked, without the other side);
//   5. where it is now: stock SAP still shows on the lines, or as part pallets.
// SAP books a pallet (Identified Stock, about 1,000 kg) while the line takes 20 kg blocks off it; offcut bags weigh
// about 7 to 13 kg. Sign: + is cheese booked with no output for it, − is output with no cheese booked for it.
(function (root) {
  "use strict";
  const R = root.OrderCheck || (typeof require === "function" ? require("./reconcile.js") : null);
  const H = 3600000, DAY = 24 * H, KG = 1, STOCK_KG = 10, BLOCK_KG = 20, BAG = { min: 7, avg: 10, max: 13 };
  const { f, fs, dm } = R.fmt;
  const isOff = (m) => R.RULES.offcut_pattern.test(String(m).toUpperCase());
  const LINE_AREAS = new Set(Object.values(R.RULES.line_areas));
  const kg = (v) => `${f(v, 1)} kg`;
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  const plural = (n, one, many) => `${f(n)} ${n === 1 ? one : many || one + "s"}`;

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
  // what a gap looks like in blocks and bags
  const shape = (v) => {
    const a = Math.abs(v);
    const b = Math.max(1, Math.round(a / BLOCK_KG)), lo = Math.max(1, Math.round(a / BAG.max)), hi = Math.max(1, Math.round(a / BAG.min));
    return `about ${plural(b, "block")} of ${BLOCK_KG} kg, or ${lo === hi ? plural(lo, "offcut bag") : `${f(lo)} to ${f(hi)} offcut bags`}`;
  };

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
      return o.order_id === oid || (!isNaN(t) && t >= from - DAY && t <= to && ctx.active.has(o.order_id));
    }).map((o) => o.order_id);
    const checked = R.check(ctx, inWindow).results;
    const jobs = new Map();
    for (const r of checked) {
      const s = r.summary, w = win(s.order_id), m = measure(s);
      const run0 = !isNaN(s.start) ? s.start : w.first_out, run1 = !isNaN(s.last_regular_output) && s.last_regular_output > run0 ? s.last_regular_output : run0;
      const cons = s.consumption || [], outs = (s.outputs || []).filter((o) => o.qty > 0);
      const lastAct = Math.max(run1, ...cons.map((c) => c.time).filter((t) => !isNaN(t)), ...outs.map((o) => o.time));
      const open = !/finished|closed|cancel/i.test(String(s.status || ""));
      // still running when the journal was exported: posting until the end, and not finished
      const running = open && lastAct >= range[1] - 3 * H;
      // started so soon after the journal's first row that its cheese moves (or receipts) may be missing
      const early = (isNaN(w.begin) ? run0 : w.begin) < range[0] + 2 * H;
      const kgpc = s.mass && s.mass.kg_per_case ? s.mass.kg_per_case : s.cheese_kg_per_case || null;
      jobs.set(s.order_id, { id: s.order_id, s, verdict: r.verdict, findings: r.findings, m, dir: dirOf(m), line: s.line, area: s.area || w.area,
        fg: s.fg, fg_text: s.fg_text, start: run0, end: run1, begin: w.begin, until: w.end, lastAct, running, early, open, kgpc,
        mats: materials(s), cons, outs });
    }
    const T = jobs.get(oid);
    const area = T.area || T.cons.map((c) => c.area).find((a) => LINE_AREAS.has(a)) || null;
    const blockSet = new Set(T.mats.blocks), offSet = new Set(T.mats.offcuts);
    const sameLine = (J) => J.line === T.line || (!!area && J.area === area);
    const trace = (m, b) => { const t = R.traceStock(ctx, m, b); return t.products.find((p) => p.material === m) || null; };
    // a batch whose history in the loaded journal starts with stock leaving: it was received before the journal's dates
    const preJournal = (p) => !!p && p.rows.length > 0 && p.rows[0].qty < 0;
    // a stock row taken off an area with no matching row putting it somewhere else (same confirmation): written off or
    // adjusted (a stock count, scrap), not moved
    const writeOffs = (p, a) => p.rows.filter((r) => !r.is_prod && r.qty < 0 && (!a || r.area === a) && !p.rows.some((x) => x !== r && x.conf === r.conf && x.qty > 0 && Math.abs(x.qty + r.qty) < 0.01));
    const movedOff = (p, a, after) => p.rows.filter((r) => !r.is_prod && r.qty < 0 && r.area === a && r.time > after && p.rows.some((x) => x !== r && x.conf === r.conf && x.qty > 0 && Math.abs(x.qty + r.qty) < 0.01));

    // Which job a move to a line was for: the job on that area whose run it falls in, counting the lead before a start
    // (cheese is moved up before a job starts) and not past its last output (a move after that is for the next job).
    const LEAD = R.RULES.lead_hours * H;
    const jobAt = (a, t, mat) => {
      const c = [...jobs.values()].filter((j) => j.area === a && t >= j.start - LEAD && t <= j.end + 0.25 * H);
      const fit = mat ? c.filter((j) => j.mats.blocks.includes(mat) || j.mats.offcuts.includes(mat)) : [];
      const pool = fit.length ? fit : c;
      return pool.length ? pool.sort((x, y) => Math.abs(x.start - t) - Math.abs(y.start - t))[0].id : null;
    };

    const checks = [];      // the non-cheese causes, checked first
    const causes = [];      // explanations: { key, conf: strong|medium|weak, kg, title, text, jobs, batches }
    const gap = T.m ? T.m.v : 0;
    const off = T.m && T.dir !== "ok";

    // ---------------------------------------------------------------- 1. not a cheese problem?
    if (T.running) checks.push({ kind: "running", decisive: true, title: "Still running when the journal was exported",
      text: `The job's last posting is ${dm(T.lastAct)} and the journal ends ${dm(range[1])}, and SAP shows it as ${T.s.status || "not finished"}. Cheese is booked as it goes in, output as pallets are confirmed, so a running job always looks off. Investigate it once it has finished.` });
    if (T.early) checks.push({ kind: "early", title: "The journal starts during this job",
      text: `The journal you loaded starts ${dm(range[0])}, around this job's start, so cheese moved to the line before then is missing from it. Load a journal that starts a day or more before the job.` });

    // pallets confirmed on the wrong order: two jobs of the same product on the same line, one with pallets confirmed
    // after its own cheese stopped while the other was running
    const lastCheese = (J) => Math.max(...J.cons.filter((c) => c.consumed > 0).map((c) => c.time), -Infinity);
    const firstCheese = (J) => Math.min(...J.cons.filter((c) => c.consumed > 0).map((c) => c.time), Infinity);
    const strays = (A, B) => {    // A's pallets confirmed while B was using cheese, after A's own cheese stopped
      const stop = lastCheese(A);
      if (!isFinite(stop)) return [];
      const bFrom = firstCheese(B), bTo = lastCheese(B);
      return A.outs.filter((o) => o.time > stop + 0.5 * H && o.time >= bFrom - 0.5 * H && o.time <= Math.max(bTo, B.end) + 0.5 * H);
    };
    if (off && T.m && T.kgpc) {
      for (const J of jobs.values()) {
        if (J.id === oid || J.fg !== T.fg || !sameLine(J) || !J.m || !J.kgpc) continue;
        if (Math.max(0, Math.max(T.start, J.start) - Math.min(T.end, J.end)) > 12 * H) continue;
        // short job with too many pallets: some of them are the other job's; over job: the other has some of its pallets
        const [A, B] = gap < 0 ? [T, J] : [J, T];
        const cand = strays(A, B).sort((x, y) => y.time - x.time);
        if (!cand.length) continue;
        // the latest pallets that bring the short job closest to balance
        const need = Math.abs(gap) / T.kgpc;
        let best = null, acc = 0, picked = [];
        for (const o of cand) { acc += o.qty; picked = [...picked, o]; const d = Math.abs(acc - need); if (!best || d < best.d) best = { d, cases: acc, pallets: picked }; }
        const moveKg = best.cases * T.kgpc;
        const tAfter = gap < 0 ? gap + moveKg : gap - moveKg, jAfter = gap < 0 ? J.m.v - moveKg : J.m.v + moveKg;
        const fits = Math.abs(tAfter) <= Math.max(T.m.tol, 0.35 * Math.abs(gap)) && Math.abs(jAfter) <= Math.max(J.m.tol, Math.abs(J.m.v));
        if (!fits) continue;
        const plan = (X) => `${f(X.s.order_out)} of ${f(X.s.planned_out)} planned`;
        const ps = best.pallets.slice().sort((x, y) => x.time - y.time);
        causes.push({ key: "wrong_order", conf: "strong", kg: Math.min(moveKg, Math.abs(gap)), jobs: [J.id], batches: ps.map((o) => o.batch),
          title: `Pallets confirmed on the wrong order (${A.id} instead of ${B.id})`,
          text: `${A.id}'s cheese stopped at ${dm(lastCheese(A))}, but ${plural(Math.round(best.cases), "case")} (${ps.length} pallet${ps.length > 1 ? "s" : ""}, ${dm(ps[0].time)} to ${dm(ps[ps.length - 1].time)}) were still confirmed on ${A.id} while ${B.id} was running on the same line. ${A.id} made ${plan(A)}, ${B.id} made ${plan(B)}. Moving those pallets to ${B.id} leaves this job at ${fs(tAfter, 1)} kg and ${J.id} at ${fs(jAfter, 1)} kg.${A.open ? ` ${A.id} is still ${A.s.status}, so it could still be picked when confirming pallets.` : ""}` });
        checks.push({ kind: "wrong_order", title: "Pallets confirmed on the wrong order", text: `See below: job ${J.id}.`, partner: J.id });
        if (A === T) { T.until = Math.min(T.until, lastCheese(T) + 0.5 * H); T.end = Math.min(T.end, lastCheese(T) + 0.5 * H); }
        break;
      }
    }
    if ((T.s.double_booked_pallets || []).length) checks.push({ kind: "double", title: "Pallets double booked",
      text: `Pallet${T.s.double_booked_pallets.length > 1 ? "s" : ""} ${T.s.double_booked_pallets.join(", ")} ${T.s.double_booked_pallets.length > 1 ? "were" : "was"} confirmed more than once: the output is overstated by those pallets.` });
    if (T.s.variance && /recipe/i.test(T.s.variance.case_weight_from || "")) checks.push({ kind: "recipe", title: "Case weight from the recipe",
      text: "The pack size isn't in the product text, so the case weight comes from the recipe (BOM): if the recipe is wrong, so is the variance." });

    // ---------------------------------------------------------------- 2. the batches of this job's cheese
    const evidence = [];
    const usedBy = (p) => p.byOrder.filter((o) => o.used > KG);
    const partner = (checks.find((c) => c.kind === "wrong_order") || {}).partner || null;
    // pallets of its cheese moved to its line during the run (or the lead before it) and what became of them
    const moved = new Map();
    for (const r of ctx.wb.journal) {
      if (r.is_prod || r.qty <= 0 || !area || r.area !== area || r.time < T.begin || r.time > T.until || !blockSet.has(r.material)) continue;
      const k = r.material + "|" + r.batch, owner = jobAt(r.area, r.time, r.material);
      // a pallet booked to another job within half an hour of arriving was moved up for that job
      const p0 = trace(r.material, r.batch);
      if (p0 && p0.rows.some((x) => x.is_prod && x.qty < 0 && x.order && x.order !== oid && x.time >= r.time && x.time - r.time <= 0.5 * H)) continue;
      if (owner && owner !== oid && !(r.time >= T.start - 0.25 * H && r.time <= T.end)) continue;
      if (!moved.has(k)) moved.set(k, { material: r.material, batch: r.batch, kg: 0, at: r.time });
      moved.get(k).kg += r.qty;
    }
    for (const x of moved.values()) {
      const p = trace(x.material, x.batch);
      if (!p) continue;
      const mine = -sum(p.rows.filter((r) => r.order === oid && r.qty < 0 && r.is_prod).map((r) => r.qty));
      const after = p.rows.filter((r) => r.time >= x.at);
      // booked later by a job that has cheese with no output for it: this job's cheese ended up there (a job that
      // balances needed it: a normal hand-over of what was left of the pallet)
      const others = usedBy(p).filter((o) => o.order !== oid && o.order !== partner && o.last >= x.at && (jobs.get(o.order) || {}).dir === "over");
      const back = movedOff(p, area, x.at);
      const onLine = sum(p.rows.filter((r) => r.area === area).map((r) => r.qty));
      const wo = writeOffs(p, area).filter((r) => r.time > x.at);
      const rest = x.kg - mine - sum(usedBy(p).filter((o) => o.order !== oid && o.last >= x.at && (jobs.get(o.order) || {}).dir !== "over").map((o) => o.used));
      if (rest <= STOCK_KG) continue;
      // other jobs on the same area and cheese, also short, running when it arrived: the pallet went to one of them
      const alsoShort = [...jobs.values()].filter((J) => J.id !== oid && J.area === area && J.dir === "short" && J.mats.blocks.includes(x.material) && x.at >= J.start - LEAD && x.at <= J.end).map((J) => J.id);
      const shareNote = alsoShort.length ? ` Job${alsoShort.length > 1 ? "s" : ""} ${alsoShort.join(", ")} (also short, same cheese) ${alsoShort.length > 1 ? "were" : "was"} running on ${area} too: it went to one of them.` : "";
      if (others.length) {
        const o = others[0], J = jobs.get(o.order);
        evidence.push({ type: "booked_elsewhere", material: x.material, batch: x.batch, kg: Math.min(rest, sum(others.map((y) => y.used))), jobs: others.map((y) => y.order),
          text: `${kg(x.kg)} moved to ${area} ${dm(x.at)} during this run; ${mine > KG ? kg(mine) + " booked to this job, the rest" : "none booked to this job, but"} booked to ${others.map((y) => `job ${y.order} (${kg(y.used)}, ${dm(y.first)})`).join(", ")}${J && J.dir === "over" ? `, which has cheese with no output` : ""}.` });
      } else if (onLine > STOCK_KG && -sum(back.map((r) => r.qty)) < rest - STOCK_KG) {
        evidence.push({ type: "never_booked", material: x.material, batch: x.batch, kg: Math.min(rest, onLine), jobs: alsoShort, shared: alsoShort,
          text: `${kg(x.kg)} moved to ${area} ${dm(x.at)} during this run and never booked to any job: SAP still shows ${kg(onLine)} of it on ${area}.${shareNote}` });
      } else if (wo.length && -sum(wo.map((r) => r.qty)) >= rest - STOCK_KG) {
        evidence.push({ type: "never_booked", material: x.material, batch: x.batch, kg: rest, jobs: alsoShort, shared: alsoShort, written_off: wo.map((r) => ({ time: r.time, kg: -r.qty, doc: r.doc, conf: r.conf })),
          text: `${kg(x.kg)} moved to ${area} ${dm(x.at)} during this run and never booked to any job; then taken off ${area} ${wo.map((r) => `${dm(r.time)} (${kg(-r.qty)}, ${r.doc} ${r.conf}, with no destination: written off or adjusted)`).join(", ")}.${shareNote}` });
      }
    }
    // cheese left on the line by an earlier job (moved in before this run, never booked), there for this job to use
    if (area) {
      const seen = new Set(moved.keys());
      for (const r of ctx.wb.journal) {
        if (r.is_prod || r.qty <= 0 || r.area !== area || !blockSet.has(r.material) || r.time >= T.begin || r.time < T.begin - 3 * DAY) continue;
        const k = r.material + "|" + r.batch;
        if (seen.has(k)) continue;
        seen.add(k);
        const p = trace(r.material, r.batch);
        if (!p) continue;
        const atStart = sum(p.rows.filter((x) => x.area === area && x.time <= T.start).map((x) => x.qty));
        const laterUse = sum(p.rows.filter((x) => x.time > T.start && x.is_prod && x.qty < 0).map((x) => -x.qty));
        const laterAway = -sum(movedOff(p, area, T.start).map((x) => x.qty));
        const left = atStart - laterUse - laterAway;
        if (atStart > STOCK_KG && left > STOCK_KG) {
          const owner = jobAt(area, r.time, r.material);
          evidence.push({ type: "left_on_line", material: r.material, batch: r.batch, kg: left, jobs: owner ? [owner] : [],
            text: `${kg(atStart)} moved to ${area} ${dm(r.time)}${owner ? ` for job ${owner}` : ""}, before this run, and never booked or moved off: SAP still shows ${kg(left)} of it on the line, there for this job to use without a booking.` });
        }
      }
    }
    // booked to this job: whole pallets booked within minutes of arriving, pallets moved for another job, over-consumed
    const byBatch = new Map();
    for (const c of T.cons) if (c.batch !== null && c.batch !== undefined && !isOff(c.material)) {
      const k = c.material + "|" + c.batch;
      if (!byBatch.has(k)) byBatch.set(k, { material: c.material, batch: c.batch, kg: 0, first: c.time });
      const b = byBatch.get(k); b.kg += c.consumed; b.first = Math.min(b.first, c.time);
    }
    // the pallets booked after the job already had (about) the cheese its output needs: the excess
    const need0 = T.s.cheese_est_needed_kg || T.s.cheese_needed_kg || 0;
    let cum = 0;
    const excess = new Map();    // material|batch -> cheese already booked to the job when it was booked
    for (const b of [...byBatch.values()].sort((a, c) => a.first - c.first)) { if (need0 && cum >= need0 - (T.m ? T.m.tol : 0)) excess.set(b.material + "|" + b.batch, cum); cum += b.kg; }
    const wrongOrder = causes.some((c) => c.key === "wrong_order");
    for (const b of byBatch.values()) {
      if (b.kg <= KG) continue;
      const p = trace(b.material, b.batch);
      if (!p) continue;
      const arrive = p.rows.filter((r) => !r.is_prod && r.qty > 0 && r.time <= b.first + 0.25 * H && LINE_AREAS.has(r.area)).pop();
      // a whole pallet (or what was left of it) booked within 15 minutes of arriving, on a job with cheese and no output
      if (T.dir === "over" && !wrongOrder && excess.has(b.material + "|" + b.batch) && arrive && b.first - arrive.time <= 0.25 * H && b.kg >= 0.95 * arrive.qty && arrive.qty >= 100) {
        const later = p.rows.filter((r) => r.time > b.first && !r.is_prod && r.qty < 0 && r.area === arrive.area);
        evidence.push({ type: "booked_whole", material: b.material, batch: b.batch, kg: b.kg, jobs: [],
          text: `${kg(arrive.qty)} moved to ${arrive.area} ${dm(arrive.time)} and booked to this job in full ${f(Math.max(0, Math.round((b.first - arrive.time) / 60000)))} minutes later, when the job had already been booked ${kg(excess.get(b.material + "|" + b.batch))} (its output needs ${kg(need0)})${later.length ? `; afterwards only ${kg(-sum(later.map((r) => r.qty)))} was moved off the line` : ""}. If only part was used, the rest went back without a move in SAP.` });
      }
      // moved to a line for another job, booked to this one
      if (T.dir === "over" && !preJournal(p)) {
        const mv = p.rows.filter((r) => !r.is_prod && r.qty > 0 && LINE_AREAS.has(r.area));
        const forOther = mv.map((r) => ({ r, owner: jobAt(r.area, r.time, r.material) })).filter((x) => x.owner && x.owner !== oid);
        if (forOther.length && !mv.some((r) => jobAt(r.area, r.time, r.material) === oid)) {
          evidence.push({ type: "moved_for_other", material: b.material, batch: b.batch, kg: b.kg, jobs: [...new Set(forOther.map((x) => x.owner))],
            text: `${kg(b.kg)} booked to this job ${dm(b.first)}, but moved to ${forOther.map((x) => `${x.r.area} for job ${x.owner} (${dm(x.r.time)})`).join(", ")}.` });
        }
      }
      // SAP consumed more of it than it had (only when its receipt is in the journal, so the count is complete)
      const minBal = Math.min(0, ...p.rows.map((r) => r.balance));
      if (!preJournal(p) && minBal < -STOCK_KG) evidence.push({ type: "over_consumed", material: b.material, batch: b.batch, kg: Math.min(-minBal, b.kg), jobs: usedBy(p).map((o) => o.order).filter((o) => o !== oid),
        text: `SAP booked ${kg(-minBal)} more of it than it ever had (booked to ${usedBy(p).map((o) => "job " + o.order).join(", ")}): the same blocks booked twice.` });
    }

    // ---------------------------------------------------------------- 3. offcut bags: booked against what the same product takes
    let bags = null;
    if (T.mats.offcuts.length || T.s.cheese_planned_offcuts_kg) {
      const offKg = (J) => sum(J.cons.filter((c) => isOff(c.material)).map((c) => c.consumed));
      const allKg = (J) => sum(J.cons.map((c) => c.consumed));
      const peers = [...jobs.values()].filter((J) => J.id !== oid && !J.running && J.dir === "ok" && allKg(J) > 100 && (J.fg === T.fg || J.mats.blocks.some((m) => blockSet.has(m))) && J.mats.offcuts.some((m) => offSet.has(m) || !offSet.size));
      const same = peers.filter((J) => J.fg === T.fg), pool = same.length >= 3 ? same : peers.length >= 3 ? peers : [];
      const share = pool.length ? sum(pool.map(offKg)) / sum(pool.map(allKg)) : null;
      const planned = T.s.cheese_planned_offcuts_kg || 0, need = T.s.cheese_est_needed_kg || T.s.cheese_needed_kg || 0;
      const booked = offKg(T), nBags = T.cons.filter((c) => isOff(c.material) && c.consumed > 0).length;
      const expect = share !== null ? share * need : planned && T.s.cheese_planned_kg ? (planned / T.s.cheese_planned_kg) * need : null;
      const recipeShare = planned && T.s.cheese_planned_kg ? planned / T.s.cheese_planned_kg : null;
      bags = { booked, n: nBags, expect, share, recipeShare, planned, need, blocks: sum(T.cons.filter((c) => !isOff(c.material)).map((c) => c.consumed)), peers: pool.length,
        basis: share !== null ? (same.length >= 3 ? `${pool.length} other jobs of ${T.fg}` : `${pool.length} other jobs on the same cheese`) : `the recipe (${f(Math.round((recipeShare || 0) * 100))}% offcuts)` };
      if (expect !== null && T.dir === "short" && expect - booked > Math.max(BAG.max * 3, 0.1 * expect)) {
        const missing = Math.min(expect - booked, Math.abs(gap));
        causes.push({ key: "bags", conf: "medium", kg: missing, jobs: [], batches: [],
          title: "Offcut bags used without scanning",
          text: `${plural(nBags, "offcut bag")} (${kg(booked)}) were booked to this job; going by ${bags.basis}, its output takes about ${kg(expect)} of offcuts${recipeShare ? ` (the recipe: ${kg(recipeShare * need)} of offcuts and ${kg((1 - recipeShare) * need)} of blocks; ${kg(bags.blocks)} of blocks was booked)` : ""}. The ${kg(expect - booked)} difference is about ${f(Math.round((expect - booked) / BAG.max))} to ${f(Math.round((expect - booked) / BAG.min))} bags put in without being scanned.` });
      }
    }

    // ---------------------------------------------------------------- 4. the other jobs, and the week on this cheese
    const gapH = (a, b) => Math.max(0, Math.max(a.start, b.start) - Math.min(a.end, b.end)) / H;
    const suspects = [];
    for (const J of jobs.values()) {
      if (J.id === oid || !J.m || J.running) continue;
      const shared = J.mats.blocks.filter((m) => blockSet.has(m));
      const links = evidence.filter((e) => e.jobs.includes(J.id)) .concat(causes.filter((c) => (c.jobs || []).includes(J.id)).map((c) => ({ batch: c.title, kg: c.kg })));
      const opposite = off && J.dir !== "ok" && J.dir !== "unknown" && Math.sign(J.m.v) === -Math.sign(gap);
      if (!links.length && !(opposite && shared.length)) continue;
      if (!shared.length && !causes.some((c) => (c.jobs || []).includes(J.id))) continue;   // a job on another cheese isn't tied by a batch
      const line = sameLine(J), g = gapH(T, J), cancel = off ? Math.abs(gap + J.m.v) / Math.max(Math.abs(gap), Math.abs(J.m.v), 1) : 1;
      const strength = links.length && opposite ? "strong" : links.length ? "linked" : line && g <= 24 && cancel <= 0.5 ? "likely" : "possible";
      const why = [];
      if (links.length) why.push(`tied by ${links.map((e) => e.batch).join(", ")}`);
      if (shared.length) why.push(`same cheese (${shared.join(", ")})`);
      why.push(line ? `same line, ${g < 0.05 ? "at the same time" : `${f(g, 1)} h apart`}` : `${J.line || J.area}, ${f(g, 1)} h apart`);
      if (opposite) why.push(`off the other way: together ${fs(gap + J.m.v, 1)} kg`);
      suspects.push({ job: J, strength, rank: { strong: 4, linked: 3, likely: 2, possible: 1 }[strength], shared, links, sameLine: line, gap: g, cancel, opposite, why });
    }
    suspects.sort((a, b) => b.rank - a.rank || a.cancel - b.cancel || a.gap - b.gap);
    // the jobs off the other way that together cancel this one best (up to three)
    let combo = null;
    if (off) {
      const pool = suspects.filter((x) => x.opposite).slice(0, 10);
      const tryIt = (set) => { const net = gap + sum(set.map((x) => x.job.m.v)); if (!combo || Math.abs(net) < Math.abs(combo.net) - 1e-9) combo = { set, net }; };
      for (let i = 0; i < pool.length; i++) { tryIt([pool[i]]); for (let j = i + 1; j < pool.length; j++) { tryIt([pool[i], pool[j]]); for (let k = j + 1; k < pool.length; k++) tryIt([pool[i], pool[j], pool[k]]); } }
      if (combo && Math.abs(combo.net) > 0.35 * Math.abs(gap)) combo = null;
    }
    // the week on this cheese: running jobs left out (they're off until they finish)
    const sameCheese = [...jobs.values()].filter((j) => j.m && !j.running && j.start >= from && j.mats.blocks.some((m) => blockSet.has(m)));
    const byLine = new Map();
    for (const j of sameCheese) {
      const k = j.line || j.area || "?";
      const g = byLine.get(k) || { line: k, jobs: 0, net: 0, gross: 0, off: 0 };
      g.jobs++; g.net += j.m.v; if (j.dir !== "ok") { g.gross += Math.abs(j.m.v); g.off++; }
      byLine.set(k, g);
    }
    const lines = [...byLine.values()].sort((a, b) => (b.line === T.line) - (a.line === T.line) || b.gross - a.gross);
    const net = sum(sameCheese.map((j) => j.m.v)), gross = sum(sameCheese.filter((j) => j.dir !== "ok").map((j) => Math.abs(j.m.v)));
    const netTol = Math.max(R.RULES.tolerance_kg * 2, 0.02 * sum(sameCheese.map((j) => j.s.cheese_consumed_kg || 0)));
    const balance = { jobs: sameCheese.length, net, gross, nets: gross > 0 && Math.abs(net) <= Math.max(netTol, 0.25 * gross), lines };

    // ---------------------------------------------------------------- 5. where the cheese is now: stock SAP shows on the lines, part pallets
    const end = range[1], seen = new Set(), phantom = [], negative = [];
    for (const r of ctx.wb.journal) {
      if (!blockSet.has(r.material) && !offSet.has(r.material)) continue;
      if (!LINE_AREAS.has(r.area) || r.time < from || r.time > to) continue;
      const k = r.material + "|" + r.batch;
      if (seen.has(k)) continue;
      seen.add(k);
      const p = trace(r.material, r.batch);
      if (!p) continue;
      const left = new Map(), last = new Map();
      for (const x of p.rows) if (LINE_AREAS.has(x.area)) { left.set(x.area, (left.get(x.area) || 0) + x.qty); last.set(x.area, x.time); }
      for (const [a, q] of left) if (q > STOCK_KG && end - last.get(a) > 12 * H) phantom.push({ material: r.material, batch: r.batch, area: a, kg: q, since: last.get(a), owner: p.rows.filter((x) => x.area === a && x.qty > 0).map((x) => jobAt(x.area, x.time, x.material)).filter(Boolean).pop() || null });
      const minBal = Math.min(0, ...p.rows.map((x) => x.balance));
      if (!preJournal(p) && minBal < -STOCK_KG && usedBy(p).length) negative.push({ material: r.material, batch: r.batch, kg: -minBal, jobs: usedBy(p).map((o) => o.order) });
    }
    phantom.sort((a, b) => b.kg - a.kg); negative.sort((a, b) => b.kg - a.kg);
    // part pallets of this cheese in the stock overview: blocks have been taken off them
    const full = new Map();
    for (const s of ctx.wb.stock || []) if (blockSet.has(s.material) && !isNaN(s.qty)) full.set(s.material, Math.max(full.get(s.material) || 0, s.qty));
    const partial = (ctx.wb.stock || []).filter((s) => blockSet.has(s.material) && !isNaN(s.qty) && s.qty > 0 && full.get(s.material) >= 500 && s.qty < 0.9 * full.get(s.material))
      .map((s) => ({ material: s.material, batch: s.batch, area: s.area, kg: s.qty, full: full.get(s.material), restricted: s.restricted }))
      .sort((a, b) => (LINE_AREAS.has(b.area) - LINE_AREAS.has(a.area)) || a.kg - b.kg).slice(0, 30);

    // ---------------------------------------------------------------- the explanations, ranked, never more than the gap
    const add = (key, conf, items, title, text) => { const k = sum(items.map((e) => e.kg)); if (k > KG) causes.push({ key, conf, kg: k, jobs: [...new Set(items.flatMap((e) => e.jobs))], batches: items.map((e) => e.batch), title, text, items }); };
    const E = (t) => evidence.filter((e) => e.type === t);
    if (T.dir === "short") {
      add("never_booked", "strong", E("never_booked").filter((e) => !(e.shared || []).length), "Pallets moved to the line during the run and never booked", "Moved to the line while this job ran and never booked to any job: the blocks it used without a booking.");
      add("never_booked_shared", "medium", E("never_booked").filter((e) => (e.shared || []).length), "Pallets moved to the line and never booked, shared with another short job", "Moved to the line while this job and another short job on the same cheese ran there, never booked to either: it went to one of them.");
      add("left_on_line", "strong", E("left_on_line"), "Cheese left on the line by an earlier job", "Moved to the line before this run and never booked or moved off: blocks there for this job to use without a booking.");
      add("booked_elsewhere", "medium", E("booked_elsewhere"), "Moved to the line for this job, booked to another", "Moved to the line during this run, but booked to another job: if this job used it, the other job's booking is this job's cheese.");
    } else if (T.dir === "over") {
      add("booked_whole", "strong", E("booked_whole"), "A whole pallet booked within minutes of arriving", "Booked in full straight away: if only part was used, the rest went back to store without a move in SAP and is now off the books.");
      add("moved_for_other", "medium", E("moved_for_other"), "Booked to this job, moved to the line for another", "Booked here, but moved to a line for another job: that job used it, so this job is booked another job's cheese.");
    }
    add("over_consumed", "medium", E("over_consumed"), "Booked more than SAP ever had", "The same blocks booked twice.");
    if (off && combo && !causes.some((c) => c.key === "wrong_order")) {
      const s0 = combo.set;
      causes.push({ key: "pair", conf: s0.some((x) => x.strength === "strong") ? "strong" : s0.some((x) => x.sameLine && x.gap <= 24) ? "medium" : "weak",
        kg: Math.min(Math.abs(gap), Math.abs(sum(s0.map((x) => x.job.m.v)))), jobs: s0.map((x) => x.job.id), batches: [],
        title: `Booked to the wrong job: ${s0.map((x) => x.job.id).join(" and ")}`,
        text: `${s0.map((x) => `Job ${x.job.id} (${x.job.line || x.job.area}, ${dm(x.job.start)}) is ${describe(x.job.m)}`).join("; ")}; together with this job ${fs(combo.net, 1)} kg, on the same cheese: the cheese one job used was booked to the other.` });
    }
    if (checks.some((c) => c.decisive)) causes.length = 0;
    const order = { strong: 0, medium: 1, weak: 2 };
    causes.sort((a, b) => order[a.conf] - order[b.conf] || b.kg - a.kg);
    // how much the explanations cover, counting each kilogram once, never more than the gap
    let explained = 0;
    if (off) { let left = Math.abs(gap); for (const c of causes) { if (c.conf === "weak") continue; const k = Math.min(c.kg, left); c.counted = k; explained += k; left -= k; if (left <= KG) break; } }
    const unexplained = off ? Math.max(0, Math.abs(gap) - explained) : 0;

    // ---------------------------------------------------------------- what it adds up to, in words
    const story = [], s = T.s;
    const decisive = checks.find((c) => c.decisive);
    story.push(T.m
      ? `Job ${oid} (${s.fg}${s.fg_text ? ", " + s.fg_text : ""}) on ${T.line || area}, ${dm(T.start)} to ${dm(T.end)}: ${T.dir === "ok" ? `within tolerance (${fs(gap, 1)} kg against ±${f(T.m.tol, 0)} kg)` : describe(T.m) + ` (tolerance ±${f(T.m.tol, 0)} kg), ${shape(gap)}`}.`
        + (s.cheese_est_needed_kg ? ` Its output needs ${kg(s.cheese_est_needed_kg)} of cheese; ${kg(s.cheese_consumed_kg || 0)} was booked.` : "")
      : `Job ${oid}: its variance can't be worked out from the loaded files (no recipe or no consumption).`);
    if (decisive) story.push(`${decisive.title}: ${decisive.text}`);
    else if (off) {
      for (const c of causes.filter((c) => c.conf !== "weak").slice(0, 4)) story.push(`${c.title} (${c.conf}, ${kg(c.counted ?? c.kg)}): ${c.items ? c.items.map((e) => `${e.batch} ${e.material}: ${e.text}`).join(" ") : c.text}`);
      if (!causes.length) story.push(T.dir === "short"
        ? "No pallet of its cheese was moved to its line and left unbooked, nothing was left on the line by an earlier job, no other job is off the other way, and the offcut bags booked look normal: the cheese most likely went in without any record (blocks or bags taken without a move or a scan)."
        : "No pallet was booked in full straight away and no other job is off the other way: the cheese was most likely really used (waste, giveaway) or output wasn't posted.");
      const sharedWith = [...new Set(causes.filter((c) => c.key === "never_booked_shared").flatMap((c) => c.jobs))];
      if (explained > KG) story.push(`Together these explain ${kg(explained)} of the ${kg(Math.abs(gap))}${sharedWith.length ? ` (counting pallets that went either to this job or to job ${sharedWith.join(" or ")})` : ""}${unexplained > KG ? `; ${kg(unexplained)} (${shape(unexplained)}) is left without a trace in the journal` : ""}.`);
      if (balance.gross > 0) story.push(balance.nets
        ? `Over ${days >= 7 ? "these two weeks" : "this week"}, the ${balance.jobs} finished jobs on ${T.mats.blocks.join(", ")} net to ${fs(balance.net, 1)} kg: the cheese was booked to the wrong jobs rather than lost.`
        : `Over ${days >= 7 ? "these two weeks" : "this week"}, the ${balance.jobs} finished jobs on ${T.mats.blocks.join(", ")} don't net out (${fs(balance.net, 1)} kg): ${balance.net > 0 ? "more cheese was booked than the output needs" : "more output than the booked cheese explains: cheese used without booking"}.`);
      const look = phantom.filter((x) => blockSet.has(x.material)).slice(0, 3);
      if (look.length && T.dir === "short") story.push(`Check on the floor: SAP still shows ${look.map((x) => `${x.batch} (${kg(x.kg)} on ${x.area})`).join(", ")}. If it isn't there, it was used without being booked.`);
    }
    for (const c of checks.filter((c) => c.kind === "early" || c.kind === "double")) story.push(`${c.title}: ${c.text}`);

    return { order: oid, days, from, to, range, clipped: from > centre - days * DAY || to < centre + days * DAY, area, target: T, gap, shape: off ? shape(gap) : null,
      jobs: [...jobs.values()].filter((j) => j.id === oid || j.start >= from).sort((a, b) => a.start - b.start), checks, causes, explained, unexplained, unexplainedShape: unexplained > KG ? shape(unexplained) : null, evidence, bags,
      suspects, combo, balance, phantom, negative, partial, story };
  }

  const api = { run, measure, BLOCK_KG, BAG };
  root.Investigate = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
