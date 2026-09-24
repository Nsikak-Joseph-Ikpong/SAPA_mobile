// Browser port of sap_variance (loader.py, products.py, analysis.py).
// Same rules, thresholds and messages as the Python package; keep them in step.
(function (root) {
  "use strict";

  const DEFAULT_ALIASES = {
    order_id: ["production order id", "production order", "prod order id", "prod order", "order id", "order", "job number", "job no", "job"],
    date: ["required on (date)", "required on", "posting date", "confirmation date", "confirmed on", "date", "created on", "finished on", "completed on"],
    material_id: ["material id", "material", "product id", "product", "material number", "item id"],
    material_desc: ["material description", "material text", "description", "product description", "material name", "item description"],
    status: ["production order status", "order status", "status"],
    planned_qty: ["planned quantity", "planned qty", "planned output"],
    fulfilled_qty: ["fulfilled quantity", "fulfilled qty", "fulfilled", "actual output"],
    open_qty: ["open quantity", "open qty", "remaining quantity"],
    output_kg: ["nominal weight of output", "nominal output kg", "output kg"],
    issued_kg: ["actual cheese issued", "cheese issued", "issued kg", "actual issued"],
    quantity: ["confirmed quantity", "effective qty", "effective quantity", "quantity", "qty", "actual quantity", "confirmed qty"],
    uom: ["unit of measure", "uom", "unit", "quantity unit"],
    batch: ["identified stock (identified stock id)", "identified stock", "identified stock id", "batch", "batch id", "batch number", "batch no", "lot", "lot number"],
    direction: ["input/output", "input output", "direction", "material role", "confirmation type", "movement type", "type"],
    reversal: ["reversed", "reversal", "cancelled", "canceled", "cancellation", "is reversal"],
    line: ["resource", "resource id", "production line", "line", "work centre", "work center"],
    user: ["created by", "confirmed by", "posted by", "user", "operator"],
    confirmation_id: ["conf.id", "conf id", "confirmation id", "confirmation", "confirmation number"],
    doc_type: ["conf.document type", "conf document type", "confirmation document type", "document type"],
    location: ["logistics area (logistics area id)", "logistics area", "logistics area id", "storage location", "location", "bin"],
    site: ["site", "site id"],
    pack_kg: ["pack kg", "kg per case", "case weight kg", "case kg", "nominal pack weight", "pack weight"],
    starch_pct: ["starch pct", "starch %", "starch percent", "anti caking pct"],
    blend_ratio: ["blend ratio", "blend", "blend composition"],
    component_type: ["component type", "material type", "category"],
  };

  function defaultSettings() {
    return {
      column_aliases: JSON.parse(JSON.stringify(DEFAULT_ALIASES)),
      header_scan_rows: 30,
      offcut_keywords: ["offcut", "off-cut", "off cut", "trim", "rework", "end piece"],
      starch_keywords: ["starch", "anti-caking", "anticaking", "anti caking"],
      packaging_keywords: ["box", "carton", "case", "label", "film", "basefilm", "topfilm", "pillow", "bag", "tray", "lid", "sleeve", "pallet", "wrap", "tape", "packaging"],
      starch_id_prefixes: ["RMPS"],
      packaging_id_prefixes: ["BO", "LA", "BASEFILM", "TOPFILM", "PILLOW", "OPA"],
      cheese_id_prefixes: ["RM"],
      box_id_prefixes: ["BO"],
      boxes_per_case: 1,
      pack_overrides: {},
      cheese_keywords: ["cheese", "cheddar", "mozzarella", "mozz", "leicester", "gouda", "edam", "emmental"],
      grated_starch_pct: 0.015,
      grated_markers: ["grated", "GR"],
      tolerance_pct: 0.05,
      tolerance_kg: 50,
      high_severity_multiple: 3,
      high_severity_kg: 500,
      no_issue_ratio: 0.1,
      closed_short_ratio: 0.9,
      over_produced_ratio: 1.1,
      blend_share_tolerance: 0.08,
      offcut_max_ratio: 0.15,
      implied_output_tolerance: 0.05,
      closed_statuses: ["closed", "completed", "finished", "technically completed"],
      production_doc_keywords: ["production"],
      unmatched_window_minutes: 60,
      swap_window_days: 7,
      swap_max_residual: 0.35,
    };
  }

  const NUMERIC = new Set(["planned_qty", "fulfilled_qty", "open_qty", "output_kg", "issued_kg", "quantity", "pack_kg", "starch_pct"]);
  const SEVERITY_ORDER = { HIGH: 0, MEDIUM: 1, LOW: 2, INFO: 3 };

  // ------------------------------------------------------------ value parsing
  const aliasKey = (t) => String(t).toLowerCase().replace(/[^a-z0-9%]/g, "");
  const isBlank = (v) => v === null || v === undefined || (typeof v === "number" && isNaN(v)) || (typeof v === "string" && v.trim() === "");

  function toNumber(v) {
    if (isBlank(v)) return NaN;
    if (typeof v === "number") return v;
    if (typeof v === "boolean") return v ? 1 : 0;
    let s = String(v).trim().replace(/[  ]/g, "");
    let neg = false;
    if (s.startsWith("(") && s.endsWith(")")) { neg = true; s = s.slice(1, -1); }
    if (s.endsWith("-")) { neg = true; s = s.slice(0, -1); }
    s = s.replace(/[^0-9,.\-]/g, "");
    if (s.startsWith("-")) { neg = !neg; s = s.slice(1); }
    if (!s) return NaN;
    if (s.includes(",") && s.includes(".")) {
      s = s.lastIndexOf(",") > s.lastIndexOf(".") ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
    } else if (s.includes(",")) {
      s = /^\d{1,3}(,\d{3})+$/.test(s) ? s.replace(/,/g, "") : s.replace(",", ".");
    }
    const n = Number(s);
    if (isNaN(n)) return NaN;
    return neg ? -n : n;
  }

  function toDate(v) {
    if (isBlank(v)) return null;
    if (v instanceof Date) return isNaN(v) ? null : v;
    const s = String(v).trim();
    let m = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})(?:[ T]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
    if (m) {
      const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
      return new Date(Date.UTC(y, +m[2] - 1, +m[1], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)));
    }
    m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    const d = new Date(s);
    return isNaN(d) ? null : d;
  }

  function toId(v) {
    if (isBlank(v)) return null;
    let s = typeof v === "number" && Number.isInteger(v) ? String(v) : String(v).trim();
    s = s.replace(/\.0$/, "").toUpperCase();
    return s || null;
  }

  function toFlag(v) {
    if (isBlank(v)) return false;
    if (typeof v === "boolean" || typeof v === "number") return !!v;
    return ["x", "yes", "y", "true", "1", "reversed", "cancelled", "canceled", "reversal"].includes(String(v).trim().toLowerCase());
  }

  // ------------------------------------------------------------ table detection
  function aliasLookup(settings) {
    const lookup = {};
    for (const [fld, aliases] of Object.entries(settings.column_aliases)) {
      for (const a of aliases) { const k = aliasKey(a); if (!(k in lookup)) lookup[k] = fld; }
    }
    return lookup;
  }

  function classify(fields) {
    const has = (f) => fields.has(f);
    if (has("order_id") && has("material_id") && has("quantity")) return "journal";
    if (has("order_id") && ["planned_qty", "fulfilled_qty", "output_kg", "issued_kg"].some(has)) return "orders";
    if (has("material_id") && has("quantity") && ["doc_type", "batch", "confirmation_id"].some(has)) return "journal";
    if (has("material_id") && !has("order_id") && ["pack_kg", "starch_pct", "blend_ratio", "component_type"].some(has)) return "products";
    return "unknown";
  }

  function parseSheet(rows, source, sheet, settings) {
    const lookup = aliasLookup(settings);
    const label = sheet ? `${source} [${sheet}]` : source;
    // drop blank rows (remember sheet positions) and blank columns
    const kept = [];
    rows.forEach((r, i) => { if (r && r.some((v) => !isBlank(v))) kept.push({ i, r }); });
    const width = Math.max(0, ...kept.map((k) => k.r.length));
    const cols = [];
    for (let c = 0; c < width; c++) if (kept.some((k) => !isBlank(k.r[c]))) cols.push(c);
    const grid = kept.map((k) => cols.map((c) => k.r[c]));

    let best = -1, bestHits = 0;
    for (let i = 0; i < Math.min(grid.length, settings.header_scan_rows); i++) {
      const f = new Set(grid[i].filter((v) => !isBlank(v)).map((v) => lookup[aliasKey(v)]).filter(Boolean));
      if (f.size > bestHits) { best = i; bestHits = f.size; }
    }
    const empty = { source, sheet, label, kind: "unknown", header_row: 0, mapping: {}, rows: [] };
    if (best < 0 || bestHits < 2) return empty;

    const headers = grid[best];
    const columns = {}, mapping = {};
    headers.forEach((h, pos) => {
      if (isBlank(h)) return;
      const fld = lookup[aliasKey(h)];
      if (fld && !(fld in columns)) { columns[fld] = pos; mapping[fld] = String(h).trim(); }
    });
    if (!("material_desc" in columns) && "material_id" in columns) {
      const nxt = columns.material_id + 1;
      if (nxt < headers.length && isBlank(headers[nxt])) {
        columns.material_desc = nxt;
        mapping.material_desc = "(untitled column after material ID)";
      }
    }
    const kind = classify(new Set(Object.keys(columns)));
    // ByDesign writes the unit into the quantity cell: "-1,002.11 kg", "98.00 case"
    let unitCol = null;
    if ("quantity" in columns && !("uom" in columns)) {
      unitCol = grid.slice(best + 1).map((r) => { const m = typeof r[columns.quantity] === "string" && r[columns.quantity].match(/([A-Za-z]+)\s*$/); return m ? m[1].toLowerCase() : null; });
      if (unitCol.some(Boolean)) mapping.uom = `(unit written after ${mapping.quantity})`;
      else unitCol = null;
    }
    let out = grid.slice(best + 1).map((r, idx) => {
      const rec = { _source: label };
      if (unitCol) rec.uom = unitCol[idx];
      for (const [fld, pos] of Object.entries(columns)) {
        const v = r[pos];
        if (NUMERIC.has(fld)) rec[fld] = toNumber(v);
        else if (fld === "date") rec[fld] = toDate(v);
        else if (["order_id", "material_id", "batch", "confirmation_id"].includes(fld)) rec[fld] = toId(v);
        else if (fld === "reversal") rec[fld] = toFlag(v);
        else rec[fld] = isBlank(v) ? null : String(v).trim();
      }
      return rec;
    });
    if (kind === "journal" && !("order_id" in columns)) for (const rec of out) rec.order_id = null;
    if (kind === "journal" && "order_id" in columns) {
      let last = null;
      for (const rec of out) { if (rec.order_id) last = rec.order_id; else rec.order_id = last; }
    }
    const keyField = "order_id" in columns ? "order_id" : "material_id";
    if (keyField in columns) {
      const hk = aliasKey(mapping[keyField]);
      out = out.filter((rec) => {
        const k = rec[keyField];
        return k && aliasKey(k) !== hk && !["total", "result", "overallresult", "sum"].includes(aliasKey(k));
      });
    }
    if (kind === "journal") out = out.filter((rec) => rec.material_id);
    const order_source = kind === "journal" && "order_id" in columns ? "column" : "";
    return { source, sheet, label, kind, header_row: kept[best].i + 1, mapping, rows: out, order_source };
  }

  // ------------------------------------------------------------ products
  function parsePackKg(desc) {
    if (!desc) return null;
    const t = desc.toLowerCase();
    let m = t.match(/(\d+)\s*[x×]\s*(\d+(?:[.,]\d+)?)\s*(kg|g)?\b/);
    if (m) {
      const size = parseFloat(m[2].replace(",", "."));
      return +m[1] * ((m[3] || "kg") === "g" ? size / 1000 : size);
    }
    m = t.match(/(\d+(?:[.,]\d+)?)\s*kg\b/);
    return m ? parseFloat(m[1].replace(",", ".")) : null;
  }

  function parseBlend(...texts) {
    for (const t of texts) {
      if (!t) continue;
      const m = String(t).match(/\b(\d{1,2})\s*\/\s*(\d{1,2})(?:\s*\/\s*(\d{1,2}))?\b/);
      if (m) {
        const parts = m.slice(1).filter(Boolean).map(Number);
        if (parts.reduce((a, b) => a + b, 0) === 100) return parts.map((p) => p / 100).sort((a, b) => b - a);
      }
    }
    for (const t of texts) {
      if (!t) continue;
      const m = String(t).trim().match(/(\d{2})(\d{2})$/);
      if (m && +m[1] + +m[2] === 100 && +m[2] > 0) return [+m[1] / 100, +m[2] / 100].sort((a, b) => b - a);
    }
    return null;
  }

  function isGrated(mid, desc, s) {
    if (desc && desc.toLowerCase().includes("grated")) return true;
    if (desc && desc.toLowerCase().includes("sliced")) return false;
    return s.grated_markers.some((mk) => mk.length === 2 && mid.length > 3 && mid.slice(2, 4) === mk.toUpperCase());
  }

  class Catalog {
    constructor(products, descriptions, settings) {
      this.s = settings; this.descriptions = descriptions; this.master = {}; this.cache = {};
      for (const row of products) {
        if (!row.material_id) continue;
        const e = (this.master[row.material_id] ||= {});
        for (const [k, v] of Object.entries(row)) if (!isBlank(v) && !(k in e)) e[k] = v;
      }
    }
    description(mid) { return mid ? (this.master[mid]?.material_desc || this.descriptions[mid] || null) : null; }
    componentType(mid) { const v = mid && this.master[mid]?.component_type; return v ? String(v).trim().toLowerCase() : null; }
    get(mid) {
      if (this.cache[mid]) return this.cache[mid];
      const e = this.master[mid] || {};
      const desc = this.description(mid);
      const ov = this.s.pack_overrides[mid];
      const masterPack = ov ? +ov : typeof e.pack_kg === "number" && !isNaN(e.pack_kg) ? e.pack_kg : null;
      const parsedPack = parsePackKg(desc);
      let pack = null, packSource = "unknown";
      if (masterPack) { pack = masterPack; packSource = "product master"; }
      else if (parsedPack) { pack = parsedPack; packSource = "description"; }
      let starch, starchSource;
      if (typeof e.starch_pct === "number" && !isNaN(e.starch_pct)) {
        starch = e.starch_pct > 1 ? e.starch_pct / 100 : e.starch_pct; starchSource = "product master";
      } else if (isGrated(mid, desc, this.s)) { starch = this.s.grated_starch_pct; starchSource = "default for grated"; }
      else { starch = 0; starchSource = "default (not grated)"; }
      const info = {
        material_id: mid, description: desc, pack_kg: pack, pack_source: packSource,
        starch_pct: starch, starch_source: starchSource, blend: parseBlend(e.blend_ratio, desc, mid),
        component_type: this.componentType(mid), master_pack_kg: masterPack, parsed_pack_kg: parsedPack,
      };
      return (this.cache[mid] = info);
    }
  }

  // ------------------------------------------------------------ formatting
  const nf = (d) => new Intl.NumberFormat("en-GB", { minimumFractionDigits: d, maximumFractionDigits: d });
  const nf0 = nf(0), nf1 = nf(1), nf2 = nf(2);
  const num = (v) => (isBlank(v) ? null : Number(v));
  function fmtKg(v, signed = false) {
    if (v === null || v === undefined || isNaN(v)) return "n/a";
    const s = nf1.format(Math.abs(v)) + " kg";
    return signed ? (v < 0 ? "-" : "+") + s : (v < 0 ? "-" : "") + s;
  }
  const fmtQty = (v) => (v === null || v === undefined ? "n/a" : Number.isInteger(v) ? nf0.format(v) : nf2.format(v));
  const pct = (v, d = 1, signed = false) => (signed && v >= 0 ? "+" : "") + (v * 100).toFixed(d) + "%";
  const g = (v) => String(+v.toFixed(6));
  const sum = (a) => a.reduce((x, y) => x + y, 0);

  // ------------------------------------------------------------ headers
  const HEADER_FIELDS = ["date", "material_id", "material_desc", "status", "planned_qty", "fulfilled_qty", "open_qty", "output_kg", "issued_kg", "line"];
  const CONFLICT_FIELDS = ["material_id", "planned_qty", "fulfilled_qty", "open_qty", "status"];

  function mergeHeaders(orders) {
    const groups = new Map();
    for (const r of orders) { if (!groups.has(r.order_id)) groups.set(r.order_id, []); groups.get(r.order_id).push(r); }
    const headers = {}, conflicts = {};
    for (const [oid, rows] of groups) {
      const merged = { sources: [...new Set(rows.map((r) => r._source))].sort() };
      for (const f of HEADER_FIELDS) {
        const vals = rows.map((r) => r[f]).filter((v) => !isBlank(v));
        merged[f] = vals.length ? vals[0] : null;
        if (CONFLICT_FIELDS.includes(f)) {
          const distinct = new Map();
          for (const r of rows) {
            const v = r[f];
            if (isBlank(v)) continue;
            const key = typeof v === "number" ? v.toFixed(3) : String(v).trim().toLowerCase();
            if (!distinct.has(key)) distinct.set(key, [v, r._source]);
          }
          if (distinct.size > 1) {
            const shown = [...distinct.values()].map(([v, src]) => `${typeof v === "number" ? fmtQty(v) : v} in ${src}`).join("; ");
            (conflicts[oid] ||= []).push(`${f}: ${shown}`);
          }
        }
      }
      headers[oid] = merged;
    }
    return { headers, conflicts };
  }

  // ------------------------------------------------------------ journal
  function direction(v) {
    if (isBlank(v)) return null;
    const t = String(v).toLowerCase();
    if (["output", "receipt", "produc", "yield", "by-product", "byproduct"].some((w) => t.includes(w))) return "out";
    if (["input", "consum", "issue", "component"].some((w) => t.includes(w))) return "in";
    return null;
  }

  function classifyMaterial(mid, desc, fg, catalog, s) {
    const ov = catalog.componentType(mid);
    if (ov) {
      for (const k of ["cheese", "offcut", "starch", "packaging", "fg"]) if (ov.includes(k)) return k;
      return ov.includes("finished") ? "fg" : "other";
    }
    if (fg && mid === fg) return "fg";
    const text = `${mid} ${desc || ""}`.toLowerCase();
    if (s.offcut_keywords.some((k) => text.includes(k))) return "offcut";
    if (s.starch_keywords.some((k) => text.includes(k)) || s.starch_id_prefixes.some((p) => mid.toUpperCase().startsWith(p.toUpperCase()))) return "starch";
    if (s.packaging_id_prefixes.some((p) => mid.toUpperCase().startsWith(p.toUpperCase()))) return "packaging";
    const words = new Set(text.match(/[a-z]+/g) || []);
    if (s.packaging_keywords.some((k) => words.has(k) || words.has(k + "s") || (k.length >= 6 && text.includes(k)))) return "packaging";
    if (s.cheese_id_prefixes.some((p) => mid.toUpperCase().startsWith(p.toUpperCase()))) return "cheese";
    if (desc && s.cheese_keywords.some((k) => desc.toLowerCase().includes(k))) return "cheese";
    return "other";
  }

  // Journals exported from ByDesign: signed Effective Qty per logistics area (see journal.py)
  const isSigned = (rows) => rows.some((r) => !isBlank(r.doc_type));
  const when = (d) => (d ? `${String(d.getUTCDate()).padStart(2, "0")}.${String(d.getUTCMonth() + 1).padStart(2, "0")} ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}` : "?");
  const f2 = (v) => nf2.format(Math.abs(v) < 0.005 ? 0 : v);

  function prepareJournal(journal, headers, catalog, s) {
    const signed = isSigned(journal);
    const isProd = (r) => !signed || isBlank(r.doc_type) || s.production_doc_keywords.some((k) => String(r.doc_type).toLowerCase().includes(k));
    const net = {};
    if (signed) for (const r of journal) if (isProd(r)) { const k = `${r.order_id}|${r.material_id}`; net[k] = (net[k] || 0) + (isNaN(r.quantity) ? 0 : r.quantity); }
    return journal.map((r) => {
      const q0 = isNaN(r.quantity) ? 0 : r.quantity;
      const prod = isProd(r);
      let q, dir, isRev;
      if (signed) {
        dir = prod ? ((net[`${r.order_id}|${r.material_id}`] || 0) < 0 ? "in" : "out") : null;
        q = dir === "in" ? -q0 : q0;
        isRev = (dir === "in" && q0 > 0) || (dir === "out" && q0 < 0);
      } else {
        q = r.reversal && q0 > 0 ? -q0 : q0;
        const u = (r.uom || "").trim().toLowerCase();
        if (["g", "gram", "grams"].includes(u)) q /= 1000;
        if (["t", "to", "ton", "tonne", "tonnes"].includes(u)) q *= 1000;
        dir = direction(r.direction);
        isRev = !!r.reversal || q0 < 0;
      }
      const base = { ...r, batch: r.batch ?? null, location: r.location ?? null, confirmation_id: r.confirmation_id ?? null, date: r.date ?? null, quantity: q0, qty: q, is_reversal: isRev, dir, is_prod: prod };
      if (!prod) return { ...base, kind: "movement" };
      const fg = headers[r.order_id]?.material_id;
      let kind = classifyMaterial(r.material_id, r.material_desc || catalog.description(r.material_id), fg, catalog, s);
      if (kind === "cheese" && dir === "out") kind = "offcut";
      else if (kind === "offcut" && dir === "in") kind = "cheese";
      else if (kind === "other" && dir === "out") kind = fg ? "other_output" : "fg";
      return { ...base, kind };
    });
  }

  function groupBy(rows, key) {
    const m = new Map();
    for (const r of rows) { const k = typeof key === "function" ? key(r) : r[key]; if (!m.has(k)) m.set(k, []); m.get(k).push(r); }
    return m;
  }
  const minDate = (rows) => rows.reduce((m, r) => (r.date && (!m || r.date < m) ? r.date : m), null);
  const maxDate = (rows) => rows.reduce((m, r) => (r.date && (!m || r.date > m) ? r.date : m), null);
  const uniq = (a) => [...new Set(a.filter((x) => x !== null && x !== undefined && x !== ""))].sort();
  const confLabel = (rows) => { const locs = uniq(rows.map((r) => r.location)).join(", "); return `${rows[0].confirmation_id} (${when(minDate(rows))}${locs ? ", " + locs : ""})`; };

  // Confirmations reversed in full by a later one (every line posted again with the opposite sign), and the reversals
  function cancelledConfirmations(lines) {
    const sig = new Map();
    for (const [conf, rows] of groupBy(lines.filter((l) => l.kind !== "movement" && l.confirmation_id), "confirmation_id")) {
      sig.set(conf, rows.map((r) => `${r.material_id}|${r.batch ?? ""}|${(Math.round(r.quantity * 1000) / 1000).toFixed(3)}`).sort());
    }
    const key = (arr) => arr.join("#");
    const bySig = new Map();
    for (const [conf, arr] of sig) { const k = key(arr); if (!bySig.has(k)) bySig.set(k, []); bySig.get(k).push(conf); }
    const out = new Set();
    for (const [conf, arr] of sig) {
      if (out.has(conf)) continue;
      const neg = key(arr.map((x) => { const i = x.lastIndexOf("|"); const q = -parseFloat(x.slice(i + 1)); return x.slice(0, i + 1) + (Object.is(q, -0) ? 0 : q).toFixed(3); }).sort());
      const partner = (bySig.get(neg) || []).find((c) => !out.has(c) && c !== conf);
      if (partner !== undefined) { out.add(conf); out.add(partner); }
    }
    return out;
  }

  function selectJob(lines, fg, s) {
    const info = { other_outputs: {}, no_output_confs: [], fg_found: true };
    const prod = lines.filter((l) => l.kind !== "movement");
    if (!prod.length || prod.every((l) => !l.confirmation_id)) return { lines, info };
    const others = prod.filter((l) => l.kind === "other_output");
    const fgConfs = new Set(prod.filter((l) => l.kind === "fg" && l.confirmation_id).map((l) => l.confirmation_id));
    let keep = prod;
    if (fg && !fgConfs.size && others.length) info.fg_found = false;
    if (fgConfs.size && others.length) {
      const fgRows = prod.filter((l) => fgConfs.has(l.confirmation_id));
      const jobLocs = new Set(fgRows.filter((l) => l.dir === "in" && l.location).map((l) => l.location));
      const w = s.unmatched_window_minutes * 60000;
      const t0 = minDate(fgRows), t1 = maxDate(fgRows);
      const keepConfs = new Set(fgConfs);
      for (const [conf, rows] of groupBy(prod, "confirmation_id")) {
        if (keepConfs.has(conf) || rows.some((r) => r.dir === "out")) continue;
        const sameLine = jobLocs.size ? rows.some((r) => jobLocs.has(r.location)) : true;
        const t = minDate(rows);
        const inWindow = !t || !t0 || (t.getTime() >= t0.getTime() - w && t.getTime() <= t1.getTime() + w);
        if (sameLine && inWindow) keepConfs.add(conf);
      }
      keep = prod.filter((l) => keepConfs.has(l.confirmation_id));
      const dropped = prod.filter((l) => !keepConfs.has(l.confirmation_id) && l.dir === "out");
      for (const [mat, rows] of groupBy(dropped, "material_id")) {
        info.other_outputs[mat] = [sum(rows.map((r) => r.qty)), new Set(rows.map((r) => r.confirmation_id)).size, uniq(rows.map((r) => r.location)).join(", ")];
      }
    }
    const confs = [...groupBy(keep, "confirmation_id")].sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    const cancelled = cancelledConfirmations(keep);
    for (const [conf, rows] of confs) {
      if (cancelled.has(conf)) continue;
      // Cheese/starch issued to the line on their own is normal; anything else with no output is not
      const rawOnly = rows.every((r) => ["cheese", "starch", "offcut"].includes(r.kind));
      if (!rows.some((r) => r.dir === "out") && rows.some((r) => r.dir === "in") && !rawOnly) info.no_output_confs.push(confLabel(rows));
    }
    const mats = new Set(keep.map((l) => l.material_id));
    return { lines: [...keep, ...lines.filter((l) => l.kind === "movement" && mats.has(l.material_id))], info };
  }

  function movementChecks(job, fileLines) {
    const out = [];
    if (!fileLines.some((l) => l.location)) return out;
    const jobIn = job.filter((l) => l.kind !== "movement" && l.dir === "in");
    const batches = new Map();
    for (const l of jobIn) if (l.batch && !batches.has(`${l.material_id}|${l.batch}`)) batches.set(`${l.material_id}|${l.batch}`, l.kind);
    const prodLocs = new Set(fileLines.filter((l) => l.kind !== "movement" && l.location).map((l) => l.location));
    for (const key of [...batches.keys()].sort()) {
      const [mat, batch] = key.split("|");
      const cheese = batches.get(key) === "cheese";
      const rows = fileLines.filter((l) => l.material_id === mat && l.batch === batch);
      const what = `batch ${batch} of ${mat}` + (cheese ? " (cheese)" : "");

      const used = rows.filter((l) => l.kind !== "movement" && l.quantity < 0 && l.location);
      const spans = {};
      for (const [loc, g] of groupBy(used, "location")) spans[loc] = [minDate(g), maxDate(g), -sum(g.map((r) => r.quantity))];
      const locs = Object.keys(spans).sort((a, b) => spans[a][0] - spans[b][0]);
      if (locs.length > 1) {
        let overlap = false;
        for (let i = 0; i < locs.length; i++) for (let k = i + 1; k < locs.length; k++) if (spans[locs[i]][0] <= spans[locs[k]][1] && spans[locs[k]][0] <= spans[locs[i]][1]) overlap = true;
        if (overlap) {
          const detail = locs.map((l) => `${l}: ${f2(spans[l][2])} from ${when(spans[l][0])} to ${when(spans[l][1])}`).join("; ");
          out.push([cheese ? "HIGH" : "LOW", "BATCH_ON_TWO_LINES", `${what} was consumed on ${locs.length} lines at the same time (${detail}). One pallet/roll can only be on one line - postings were probably made against the batch SAP showed rather than the one physically used.`, null]);
        }
      }
      const atLines = [...groupBy(rows.filter((l) => prodLocs.has(l.location)), "location")].sort((a, b) => a[0].localeCompare(b[0]));
      for (const [loc, g0] of atLines) {
        const g = g0.slice().sort((a, b) => (a.date - b.date) || (b.quantity - a.quantity));
        const moves = g.filter((l) => l.kind === "movement");
        let bal = 0, firstShort = null;
        for (const l of g) { bal += l.quantity; if (bal < -0.5 && !firstShort && l.kind !== "movement") firstShort = l.date; }
        if (firstShort) {
          const later = moves.filter((l) => l.quantity > 0 && l.date > firstShort);
          if (later.length) out.push([cheese ? "MEDIUM" : "LOW", "USED_BEFORE_ARRIVAL", `${what} was consumed on ${loc} from ${when(firstShort)} but was only moved to ${loc} at ${when(later[0].date)} (${f2(later[0].quantity)}). Check which batch was physically on the line.`, null]);
        }
        const movedIn = sum(moves.filter((l) => l.quantity > 0).map((l) => l.quantity));
        const movedOut = Math.abs(sum(moves.filter((l) => l.quantity < 0).map((l) => l.quantity)));
        const consumed = -sum(g.filter((l) => l.kind !== "movement").map((l) => l.quantity));
        const left = movedIn - consumed - movedOut;
        if (movedIn > 0 && left > Math.max(1, 0.01 * movedIn)) {
          out.push([cheese ? "HIGH" : "LOW", cheese ? "LEFTOVER_NOT_RETURNED" : "LEFT_ON_LINE", `${what}: ${f2(movedIn)} moved to ${loc}, ${f2(consumed)} consumed, ${f2(movedOut)} returned - ${f2(left)} still on ${loc} in SAP at the end of this journal.`, cheese ? left : null]);
        }
      }
    }
    return out;
  }

  // ------------------------------------------------------------ per-order rules
  function linesUsed(lines) {
    for (const col of ["line", "location"]) {
      const used = uniq(lines.filter((l) => l.dir !== "out").map((l) => l[col]));
      if (used.length) return used.join(", ");
    }
    return null;
  }
  function analyseOrder(oid, header, lines, conflicts, catalog, s, journalLoaded) {
    const flags = [];
    const flag = (severity, code, message, kg = null, related = "") => flags.push({ order_id: oid, severity, code, message, kg, related_orders: related });

    let fg = header.material_id || null;
    const pending = [];
    if (!fg && lines.length) {
      const outs = uniq(lines.filter((l) => l.kind === "fg").map((l) => l.material_id));
      if (outs.length === 1) fg = outs[0];
      else if (outs.length > 1) {
        lines = lines.map((l) => (l.kind === "fg" ? { ...l, kind: "other_output" } : l));
        pending.push(["MEDIUM", "UNKNOWN_PRODUCT", `The journal outputs ${outs.length} products (${outs.join(", ")}) and no order list says which is this order's. Load the order list (or a product master) so the right confirmations can be picked out.`, null]);
      }
    }
    const info = fg ? catalog.get(fg) : null;

    const fileLines = lines;
    if (lines.length && isSigned(lines) && lines.some((l) => l.confirmation_id)) {
      const sel = selectJob(lines, fg, s);
      lines = sel.lines;
      const job = sel.info;
      if (!job.fg_found) pending.push(["HIGH", "FG_NOT_IN_JOURNAL", `This order makes ${fg}, but the journal has no output of ${fg}. Either the wrong journal was loaded for this order or the export is incomplete.`, null]);
      const oo = Object.keys(job.other_outputs).sort();
      if (oo.length) {
        const parts = oo.map((m) => { const [q, n, loc] = job.other_outputs[m]; return `${m} (${nf2.format(q)} on ${n} confirmation(s)${loc ? ", " + loc : ""})`; });
        pending.push(["MEDIUM", "OTHER_PRODUCTS_IN_JOURNAL", `The journal also records output of ${parts.join("; ")}. It looks like it covers more than one job; only confirmations for ${fg} (and unmatched ones on the same line) were used for this order.`, null]);
      }
      if (job.no_output_confs.length) {
        pending.push(["MEDIUM", "CONFIRMATION_WITHOUT_OUTPUT", `${job.no_output_confs.length} production confirmation(s) consumed materials but record no output: ${job.no_output_confs.join("; ")}. The output may be missing from the export, or materials were booked without output.`, null]);
      }
      pending.push(...movementChecks(lines, fileLines));
    }
    lines = lines.filter((l) => l.kind !== "movement");
    const planned = num(header.planned_qty), openQty = num(header.open_qty), status = header.status || null;
    let fulfilled = num(header.fulfilled_qty);

    const cheese = lines.filter((l) => l.kind === "cheese");
    const offcuts = lines.filter((l) => l.kind === "offcut");
    const fgLines = lines.filter((l) => l.kind === "fg");
    const fgJournal = fgLines.length ? sum(fgLines.map((l) => l.qty)) : null;
    if (fulfilled === null && fgJournal !== null) fulfilled = fgJournal;

    const pack = info ? info.pack_kg : null;
    const outputKg = fulfilled !== null && pack ? fulfilled * pack : num(header.output_kg);
    const starch = info ? info.starch_pct : 0;
    const expected = outputKg !== null ? outputKg * (1 - starch) : null;
    const planExpected = planned && pack ? planned * pack * (1 - starch) : null;

    let issued;
    if (cheese.length) issued = sum(cheese.map((l) => l.qty));
    else { issued = num(header.issued_kg); if (issued === null && lines.length) issued = 0; }
    const offcutKg = offcuts.length ? sum(offcuts.map((l) => l.qty)) : 0;
    const variance = issued !== null && expected !== null ? issued - expected - offcutKg : null;
    const tolerance = expected !== null ? Math.max(s.tolerance_pct * expected, s.tolerance_kg) : null;
    const variancePct = variance !== null && expected ? variance / expected : null;

    const byMaterial = {};
    for (const l of cheese) byMaterial[l.material_id] = (byMaterial[l.material_id] || 0) + l.qty;
    const cheeseMaterials = Object.entries(byMaterial).map(([m, q]) => `${m} ${nf1.format(q)}kg`).join(", ");

    // Balance against the output the journal itself confirms, when that differs from the order list
    const journalExpected = fgJournal && pack ? fgJournal * pack * (1 - starch) : null;
    const varianceJournal = issued !== null && journalExpected !== null ? issued - journalExpected - offcutKg : null;
    // What each input says the output was, in cases
    const boxes = lines.filter((l) => l.kind === "packaging" && s.box_id_prefixes.some((p) => String(l.material_id).toUpperCase().startsWith(p.toUpperCase())));
    const starchLines = lines.filter((l) => l.kind === "starch");
    const implied = {};
    if (issued && pack) implied["cheese"] = (issued - offcutKg) / (pack * (1 - starch));
    if (boxes.length) implied["boxes"] = sum(boxes.map((l) => l.qty)) / s.boxes_per_case;
    if (starchLines.length && pack && starch) implied["starch"] = sum(starchLines.map((l) => l.qty)) / (pack * starch);
    if (fgJournal !== null) implied["journal output"] = fgJournal;
    if (num(header.fulfilled_qty) !== null) implied["order list"] = num(header.fulfilled_qty);

    const dates = lines.map((l) => l.date).filter(Boolean);
    const metrics = {
      order_id: oid,
      date: header.date || (dates.length ? new Date(Math.max(...dates)) : null),
      fg_material: fg, fg_description: info ? info.description : header.material_desc || null,
      status, line: header.line || linesUsed(lines),
      planned_qty: planned, fulfilled_qty: fulfilled, open_qty: openQty, fg_in_journal: fgJournal,
      pack_kg: pack, pack_source: info ? info.pack_source : "unknown", starch_pct: starch,
      blend: info && info.blend ? info.blend.map((p) => (p * 100).toFixed(0)).join("/") : null,
      output_kg: outputKg, expected_cheese_kg: expected, expected_for_planned_kg: planExpected,
      cheese_issued_kg: issued, offcuts_kg: offcutKg, variance_kg: variance, variance_pct: variancePct,
      tolerance_kg: tolerance, cheese_materials: cheeseMaterials, journal_lines: lines.length,
      variance_vs_journal_output_kg: varianceJournal, cases_from_cheese: implied["cheese"] ?? null,
      cases_from_boxes: implied["boxes"] ?? null, cases_from_starch: implied["starch"] ?? null, implied,
      sources: [...new Set([...(header.sources || []), ...lines.map((l) => l._source)])].sort().join(", "),
    };

    // components: kind / material / batch
    const comp = new Map();
    for (const l of lines) {
      const key = `${l.kind}|${l.material_id}|${l.batch || "(no batch)"}`;
      if (!comp.has(key)) comp.set(key, { kind: l.kind, material_id: l.material_id, batch: l.batch || "(no batch)", net_qty: 0, lines: 0, reversals: 0, description: l.material_desc });
      const c = comp.get(key); c.net_qty += l.qty; c.lines += 1; c.reversals += l.is_reversal ? 1 : 0;
    }
    const components = [...comp.values()].sort((a, b) => (a.kind + a.material_id + a.batch).localeCompare(b.kind + b.material_id + b.batch));

    for (const [sev, code, msg, kg] of pending) flag(sev, code, msg, kg);
    if (lines.length && !cheese.length) {
      flag("MEDIUM", "NO_CHEESE_IN_JOURNAL", `No cheese found among this job's journal lines (cheese is recognised by material IDs starting ${s.cheese_id_prefixes.join(", ")}, a cheese word in the description, or Component Type = cheese in the product master). Either none was issued, the export is cut off, or the cheese codes need adding to the product master.`);
    }
    // data completeness / cross-file
    for (const c of conflicts) flag("HIGH", "SOURCE_CONFLICT", `Files disagree on this order - ${c}`);
    const hasHeader = Object.keys(header).length > 0;
    if (!hasHeader) flag("LOW", "NO_ORDER_HEADER", "Journal lines found but no order header (planned/fulfilled) in any loaded file.");
    if (journalLoaded && !lines.length && hasHeader) flag("MEDIUM", "NO_JOURNAL_LINES", "Order header found but no confirmation journal lines in any loaded file.");
    if (fg && !pack && outputKg === null) flag("MEDIUM", "NO_PACK_WEIGHT", `Cannot work out kg per case for ${fg} - add it to the product master (pack_kg).`);
    if (info && info.master_pack_kg && info.parsed_pack_kg && Math.abs(info.master_pack_kg - info.parsed_pack_kg) > 0.01) {
      flag("LOW", "PACK_WEIGHT_CONFLICT", `Product master says ${g(info.master_pack_kg)} kg/case but the description '${info.description}' implies ${g(info.parsed_pack_kg)} kg/case.`);
    }

    // header quantities
    if (planned && fulfilled !== null) {
      if (openQty !== null && openQty === 0 && fulfilled < planned * s.closed_short_ratio) {
        flag("MEDIUM", "CLOSED_SHORT", `Only ${fmtQty(fulfilled)} of ${fmtQty(planned)} planned were confirmed (${pct(fulfilled / planned, 0)}) but open quantity is 0 - the rest was closed off. Check whether more was produced than confirmed.`);
      }
      if (fulfilled > planned * s.over_produced_ratio) {
        flag("LOW", "OVER_PRODUCED", `Fulfilled ${fmtQty(fulfilled)} vs planned ${fmtQty(planned)} (${pct(fulfilled / planned - 1, 0, true)}).`);
      }
    }
    if (openQty === 0 && fulfilled && status && !s.closed_statuses.some((c) => status.toLowerCase().includes(c))) {
      flag("INFO", "NOT_CLOSED", `Nothing left open but status is still '${status}' - order has not been closed.`);
    }
    if (fgJournal !== null && fulfilled !== null && num(header.fulfilled_qty) !== null && fgJournal > 0
        && Math.abs(fgJournal - fulfilled) > Math.max(1, 0.01 * fulfilled)
        && !(pack && Math.abs(fgJournal - fulfilled * pack) <= Math.max(1, 0.01 * fulfilled * pack))) {
      flag("MEDIUM", "OUTPUT_MISMATCH", `Header says ${fmtQty(fulfilled)} fulfilled but the journal confirms ${fmtQty(fgJournal)} of ${fg}.`);
    }

    // inputs that disagree about how much was made
    const iv = Object.values(implied);
    // Cheese alone against output is the cheese balance below; this needs boxes or starch as a second witness
    if (iv.length >= 2 && ("boxes" in implied || "starch" in implied)) {
      const lo = Math.min(...iv), hi = Math.max(...iv);
      if (hi - lo > Math.max(2, s.implied_output_tolerance * hi)) {
        const shown = Object.entries(implied).map(([k, v]) => `${k} ${nf0.format(v)}`).join("; ");
        flag(hi - lo > 0.1 * hi ? "HIGH" : "MEDIUM", "INPUTS_DISAGREE", `Inputs and output tell different stories about how many cases were made: ${shown}. Whichever is right, the others were booked wrongly.`);
      }
    }
    // output confirmed without boxes
    if (boxes.length && lines.some((l) => l.confirmation_id)) {
      const cancelled = isSigned(lines) ? cancelledConfirmations(lines) : new Set();
      const boxSet = new Set(boxes);
      const noBox = [];
      for (const [conf, rows] of [...groupBy(lines.filter((l) => l.confirmation_id), "confirmation_id")].sort((a, b) => String(a[0]).localeCompare(String(b[0])))) {
        if (cancelled.has(conf)) continue;
        const cases = sum(rows.filter((r) => r.kind === "fg").map((r) => r.qty));
        const boxed = sum(rows.filter((r) => boxSet.has(r)).map((r) => r.qty)) / s.boxes_per_case;
        if (cases > 0 && cases - boxed > Math.max(1, 0.02 * cases)) noBox.push([conf, minDate(rows), cases - boxed]);
      }
      if (noBox.length) {
        const total = sum(noBox.map((x) => x[2]));
        const listed = noBox.map(([c, d, n]) => `${c} (${when(d)}, ${fmtQty(n)} cases)`).join("; ");
        flag(total > 0.1 * Math.max(fgJournal || 0, 1) ? "HIGH" : "MEDIUM", "OUTPUT_WITHOUT_BOXES", `${fmtQty(total)} cases were confirmed as output without boxes booked: ${listed}. Either those cases were never made, or their packaging (and possibly starch) was never confirmed.`);
      }
    }

    // cheese balance
    const matchesJournal = variance !== null && varianceJournal !== null && fgJournal !== fulfilled
      && Math.abs(variance) > tolerance && Math.abs(varianceJournal) <= Math.max(s.tolerance_pct * journalExpected, s.tolerance_kg);
    if (matchesJournal) {
      flag("HIGH", "CHEESE_MATCHES_JOURNAL_NOT_ORDER", `Cheese issued (${fmtKg(issued)}) matches the ${fmtQty(fgJournal)} cases the journal confirms (${fmtKg(journalExpected)} expected, ${fmtKg(varianceJournal, true)}), not the ${fmtQty(fulfilled)} in the order list (${fmtKg(variance, true)}). The cheese is probably not missing: check whether ${fmtQty(fgJournal)} cases physically exist and why the order shows ${fmtQty(fulfilled)}.`, variance);
    } else if (variance !== null && expected) {
      let detail = pack
        ? `Issued ${fmtKg(issued)} vs expected ${fmtKg(expected)} (${fmtQty(fulfilled)} x ${g(pack)} kg`
        : `Issued ${fmtKg(issued)} vs expected ${fmtKg(expected)} (`;
      detail += `, less ${pct(starch)} starch)` + (offcutKg ? ` + offcuts ${fmtKg(offcutKg)}` : "");
      const big = Math.abs(variance) > Math.max(s.high_severity_multiple * tolerance, s.high_severity_kg);
      const sev = big ? "HIGH" : "MEDIUM";
      if (issued <= s.no_issue_ratio * expected) {
        flag("HIGH", "NO_CHEESE_ISSUED", `Output completed with almost no cheese issued. ${detail}. About ${fmtKg(expected - issued)} of cheese is missing from the books.`, variance);
      } else if (variance < -tolerance) {
        flag(sev, "CHEESE_UNDER_ISSUED", `${fmtKg(-variance)} less cheese issued than the output needs (${pct(variancePct, 1, true)}). ${detail}. Likely a missed issue or cheese confirmed against another order.`, variance);
      } else if (variance > tolerance) {
        const msg = `${fmtKg(variance)} more cheese issued than the output explains (${pct(variancePct, 1, true)}). ${detail}.`;
        if (planExpected && fulfilled !== null && planned && fulfilled < planned * s.closed_short_ratio
            && Math.abs(issued - planExpected) <= Math.max(s.tolerance_pct * planExpected, s.tolerance_kg)) {
          flag("HIGH", "ISSUED_TO_PLAN", `Cheese issued (${fmtKg(issued)}) matches the PLANNED quantity (${fmtQty(planned)} cases = ${fmtKg(planExpected)}), not the ${fmtQty(fulfilled)} actually confirmed. Either output was under-confirmed, or about ${fmtKg(variance)} of leftover cheese was never returned to stores.`, variance);
        } else {
          flag(sev, "CHEESE_OVER_ISSUED", msg + " Possible leftover not returned, unrecorded offcuts, or another order's cheese confirmed here.", variance);
        }
      }
    }

    // blend
    if (info && info.blend && issued && issued > 0 && expected) {
      const present = Object.entries(byMaterial).filter(([, q]) => q > 1);
      const ratio = info.blend.map((p) => (p * 100).toFixed(0)).join("/");
      if (present.length < info.blend.length) {
        flag("HIGH", "HALF_ISSUED_BLEND", `${ratio} blend but only ${present.length} cheese material(s) issued (${present.map(([m]) => m).join(", ") || "none"}). The other component (~${fmtKg(Math.max(expected - issued, 0))}) looks to be missing.`, variance);
      } else {
        const shares = present.map(([, q]) => q / issued).sort((a, b) => b - a).slice(0, info.blend.length);
        const worst = Math.max(...shares.map((x, i) => Math.abs(x - info.blend[i])));
        if (worst > s.blend_share_tolerance) {
          flag("MEDIUM", "BLEND_RATIO_OFF", `Cheese issued in a ${shares.map((x) => (x * 100).toFixed(0)).join("/")} split, recipe is ${ratio}. (${cheeseMaterials})`);
        }
      }
    }

    // batches
    if (cheese.length) {
      const byBatch = new Map();
      for (const l of cheese) { const k = `${l.material_id}|${l.batch ?? ""}`; byBatch.set(k, (byBatch.get(k) || 0) + l.qty); }
      for (const [k, q] of byBatch) {
        const [mid, batch] = k.split("|");
        if (q < -0.5) flag("MEDIUM", "NEGATIVE_BATCH", `Batch ${batch || "(none)"} of ${mid} nets to ${fmtKg(q)} on this order - more was reversed than issued.`, q);
      }
      const rev = cheese.filter((l) => l.is_reversal);
      if (rev.length) {
        const revBatches = [...new Set(rev.map((l) => l.batch).filter(Boolean))].sort();
        const perBatch = {};
        for (const l of cheese) if (l.batch) perBatch[l.batch] = (perBatch[l.batch] || 0) + l.qty;
        const finals = Object.keys(perBatch).filter((b) => perBatch[b] > 0.5).sort();
        flag("INFO", "REVERSALS", `${rev.length} cheese confirmation(s) reversed (${fmtKg(sum(rev.map((l) => l.qty)))}) on batch(es) ${revBatches.join(", ") || "(none)"}; final batches: ${finals.join(", ") || "(none)"}.`);
      }
    }
    if (offcutKg && issued && offcutKg > s.offcut_max_ratio * issued) {
      flag("LOW", "HIGH_OFFCUTS", `Offcuts ${fmtKg(offcutKg)} are ${pct(offcutKg / issued, 0)} of cheese issued.`);
    }
    if (!journalLoaded && issued === null) flag("INFO", "NO_CONSUMPTION_DATA", "No journal loaded, so cheese consumption could not be checked for this order.");

    return { order_id: oid, metrics, components, flags };
  }

  // ------------------------------------------------------------ cross-order
  function matchSwaps(results, journal, s) {
    const cands = [];
    for (const [oid, r] of Object.entries(results)) {
      const m = r.metrics;
      if (m.variance_kg === null || m.tolerance_kg === null || Math.abs(m.variance_kg) <= m.tolerance_kg) continue;
      const ol = journal.filter((l) => l.order_id === oid && l.kind === "cheese");
      cands.push({ oid, v: m.variance_kg, date: m.date, mats: new Set(ol.map((l) => l.material_id)), batches: new Set(ol.map((l) => l.batch).filter(Boolean)), fg: m.fg_material });
    }
    const pos = cands.filter((c) => c.v > 0), neg = cands.filter((c) => c.v < 0);
    const options = [];
    for (const a of pos) for (const b of neg) {
      const shared = [...a.mats].filter((x) => b.mats.has(x));
      if (!shared.length && !(a.fg && a.fg === b.fg)) continue;
      let days = null;
      if (a.date && b.date) { days = Math.round(Math.abs(a.date - b.date) / 86400000); if (days > s.swap_window_days) continue; }
      const residual = Math.abs(a.v + b.v) / Math.max(Math.abs(a.v), Math.abs(b.v));
      if (residual > s.swap_max_residual) continue;
      const sharedBatches = [...a.batches].filter((x) => b.batches.has(x)).sort();
      options.push({ a, b, days, shared, sharedBatches, residual, cost: residual + 0.02 * (days || 0) - (sharedBatches.length ? 0.1 : 0) });
    }
    // Greedy lowest-cost pairing (the Python version uses the Hungarian algorithm)
    options.sort((x, y) => x.cost - y.cost);
    const used = new Set(), out = [];
    for (const o of options) {
      if (used.has(o.a.oid) || used.has(o.b.oid)) continue;
      used.add(o.a.oid); used.add(o.b.oid);
      out.push({
        order_a: o.a.oid, order_b: o.b.oid, variance_a_kg: o.a.v, variance_b_kg: o.b.v, net_kg: o.a.v + o.b.v,
        residual: o.residual, days_apart: o.days, shared_materials: o.shared.sort().join(", ") || `same product ${o.a.fg}`,
        shared_batches: o.sharedBatches.join(", "),
      });
    }
    return out.sort((x, y) => x.residual - y.residual);
  }

  function batchUsage(journal) {
    const map = new Map();
    for (const l of journal) {
      if (l.kind !== "cheese" || !l.batch) continue;
      const k = `${l.material_id}|${l.batch}`;
      if (!map.has(k)) map.set(k, { material_id: l.material_id, batch: l.batch, orders: new Set(), net_kg: 0, reversals: 0 });
      const b = map.get(k); b.orders.add(l.order_id); b.net_kg += l.qty; b.reversals += l.is_reversal ? 1 : 0;
    }
    return [...map.values()].map((b) => ({ ...b, order_count: b.orders.size, orders: [...b.orders].sort().join(", ") }))
      .sort((x, y) => y.order_count - x.order_count || y.net_kg - x.net_kg);
  }

  // ------------------------------------------------------------ entry points
  function loadSheets(sheets, settings) {
    return sheets.map((sh) => parseSheet(sh.rows, sh.file, sh.sheet, settings));
  }

  function allOrderIds(tables) {
    const ids = [];
    for (const kind of ["orders", "journal"]) for (const t of tables) if (t.kind === kind) for (const r of t.rows) if (r.order_id && !ids.includes(r.order_id)) ids.push(r.order_id);
    return ids;
  }

  function analyse(tables, settings, orderIds) {
    const rowsOf = (kind) => tables.filter((t) => t.kind === kind).flatMap((t) => t.rows);
    const orders = rowsOf("orders"), products = rowsOf("products");
    const { headers, conflicts } = mergeHeaders(orders);
    const descriptions = {};
    for (const r of [...products, ...orders, ...rowsOf("journal")]) if (r.material_id && r.material_desc && !(r.material_id in descriptions)) descriptions[r.material_id] = r.material_desc;
    const catalog = new Catalog(products, descriptions, settings);
    const journal = prepareJournal(rowsOf("journal").filter((r) => r.order_id), headers, catalog, settings);
    const journalLoaded = journal.length > 0;

    const every = allOrderIds(tables);
    const results = {};
    for (const oid of every) {
      results[oid] = analyseOrder(oid, headers[oid] || {}, journal.filter((l) => l.order_id === oid), conflicts[oid] || [], catalog, settings, journalLoaded);
    }
    const swaps = matchSwaps(results, journal, settings);
    for (const w of swaps) {
      for (const [me, other, mine, theirs] of [[w.order_a, w.order_b, w.variance_a_kg, w.variance_b_kg], [w.order_b, w.order_a, w.variance_b_kg, w.variance_a_kg]]) {
        const when = w.days_apart !== null ? `, ${w.days_apart} day(s) apart` : "";
        const batches = w.shared_batches ? `, shared batch(es) ${w.shared_batches}` : "";
        results[me].flags.push({ order_id: me, severity: "HIGH", code: "CROSS_ORDER_SWAP", kg: mine, related_orders: other,
          message: `This order is ${fmtKg(mine, true)} and order ${other} is ${fmtKg(theirs, true)} on ${w.shared_materials}${when}${batches}. They nearly cancel (net ${fmtKg(w.net_kg, true)}) - cheese was probably confirmed against the wrong order.` });
      }
    }
    const batches = batchUsage(journal);
    for (const b of batches) {
      if (b.net_kg < -0.5 && b.order_count > 1) {
        for (const oid of b.orders.split(", ")) results[oid].flags.push({ order_id: oid, severity: "MEDIUM", code: "BATCH_NEGATIVE_OVERALL", kg: null, related_orders: b.orders,
          message: `Across all loaded orders, batch ${b.batch} of ${b.material_id} nets to ${fmtKg(b.net_kg)} (orders ${b.orders}).` });
      }
    }
    const requestedRaw = orderIds && orderIds.length ? orderIds.map((o) => String(o).trim().toUpperCase()) : every;
    const requested = requestedRaw.filter((o) => o in results);
    const missing = requestedRaw.filter((o) => !(o in results));
    for (const r of Object.values(results)) r.flags.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
    return { results, requested, missing, swaps, batches, every };
  }

  function assignOrder(table, orderId, how = "given") {
    const id = toId(orderId);
    for (const r of table.rows) r.order_id = id;
    table.order_source = id ? how : "";
  }
  function orderFromFilename(name) {
    const stem = String(name).replace(/\.[^.]+$/, "");
    const nums = stem.match(/(?<![A-Za-z\d])\d{3,7}(?![A-Za-z\d])/g) || [];
    return nums.length === 1 ? nums[0] : null;
  }

  const api = { defaultSettings, parseSheet, assignOrder, orderFromFilename, loadSheets, analyse, allOrderIds, toNumber, parsePackKg, parseBlend, fmtKg, fmtQty, SEVERITY_ORDER };
  root.VarianceEngine = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
