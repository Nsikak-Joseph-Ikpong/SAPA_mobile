// Reading the plant's SAP labels (phone and laptop).
//
// Each label has two QR codes: the big one (goods movement) "(90)<product>(10)<batch>", and the small one (scanning in)
// "<product>,<batch>,<quantity>,<unit>" (KGM = kg, XCS = case, MTR = m). The QR codes are read on the phone (zxing,
// several per picture, any angle). The big QR also fixes the label's position: measured on real labels, the small
// QR's centre sits about 3.9 big-QR widths to the right of the big one's, the printed "Batch:" and "Quantity:" about
// 2 widths right and 1.5 to 2 up, and the big quantity 3 to 5 right, level with it. So the label is cut out upright
// around the big QR, and each field is read on its own at a set magnification (Tesseract). What is read is set
// against the QR codes, and both against SAP, on the laptop.
//
// Positions are in "label units": one big-QR width, origin at the big QR's centre, x to the right of the label as
// printed, y down.
(function (root) {
  "use strict";
  const B = root.BagScan;

  // ------------------------------------------------------------ QR codes
  // all the QR codes in a picture (ImageData), with their corners in the picture's pixels, in the code's own
  // orientation (tl is the code's top-left whichever way up the label is)
  let zx = null;
  function zxing() {
    if (!zx) {
      root.ZXingWASM.prepareZXingModule({
        overrides: { locateFile: (path, prefix) => (path.endsWith(".wasm") ? new URL("vendor/zxing/zxing_reader.wasm", location.href).href : prefix + path) },
      });
      zx = root.ZXingWASM;
    }
    return zx;
  }
  async function readCodes(imageData, opts = {}) {
    const res = await zxing().readBarcodes(imageData, { formats: ["QRCode"], maxNumberOfSymbols: 6, tryHarder: true, tryRotate: true, tryInvert: false, tryDownscale: true, ...opts });
    return res.filter((r) => r.isValid && r.text).map((r) => {
      const p = r.position, k = (q) => ({ x: q.x, y: q.y });
      return { text: r.text, tl: k(p.topLeft), tr: k(p.topRight), br: k(p.bottomRight), bl: k(p.bottomLeft), ...B.parseCode(r.text) };
    });
  }
  // the codes in a canvas or image, read on a copy reduced to at most `max` pixels and scaled back
  async function codesIn(src, w, h, max = 1600) {
    const sc = Math.min(1, max / Math.max(w, h)), c = document.createElement("canvas");
    c.width = Math.round(w * sc); c.height = Math.round(h * sc);
    const x = c.getContext("2d", { willReadFrequently: true });
    x.drawImage(src, 0, 0, c.width, c.height);
    const codes = await readCodes(x.getImageData(0, 0, c.width, c.height));
    const up = (q) => ({ x: q.x / sc, y: q.y / sc });
    return codes.map((c2) => ({ ...c2, tl: up(c2.tl), tr: up(c2.tr), br: up(c2.br), bl: up(c2.bl) }));
  }

  // ------------------------------------------------------------ where the label is
  const centre = (q) => ({ x: (q.tl.x + q.tr.x + q.br.x + q.bl.x) / 4, y: (q.tl.y + q.tr.y + q.br.y + q.bl.y) / 4 });
  const SMALL_AT = 3.9, SMALL_SIZE = 0.65;   // the small QR, in big-QR widths (measured on the plant's labels)
  // The label frame from the codes: origin at the big QR's centre, ux / uy one big-QR width along the label's x / y.
  // With only the small QR, the big one's place is worked out from it.
  function frameOf(codes) {
    const big = codes.find((c) => c.kind === "big"), small = codes.find((c) => c.kind === "small" && (!big || c.batch === big.batch));
    const q = big || small;
    if (!q) return null;
    let ux = { x: q.tr.x - q.tl.x, y: q.tr.y - q.tl.y }, uy = { x: q.bl.x - q.tl.x, y: q.bl.y - q.tl.y };
    let o = centre(q);
    if (!big) {
      const k = 1 / SMALL_SIZE;
      ux = { x: ux.x * k, y: ux.y * k }; uy = { x: uy.x * k, y: uy.y * k };
      o = { x: o.x - SMALL_AT * ux.x, y: o.y - SMALL_AT * ux.y };
    }
    return { o, ux, uy, from: big ? "big QR" : "small QR" };
  }
  // Cut a box of the label (in label units) out of the picture, upright, at `px` pixels per label unit
  function cut(img, f, box, px) {
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round((box.x1 - box.x0) * px)); c.height = Math.max(1, Math.round((box.y1 - box.y0) * px));
    const x = c.getContext("2d", { willReadFrequently: true });
    x.fillStyle = "#fff"; x.fillRect(0, 0, c.width, c.height);
    // label units -> picture: p = o + X*ux + Y*uy; the canvas maps (X - x0) * px -> output; invert that affine map
    const a = f.ux.x, b = f.ux.y, cc = f.uy.x, d = f.uy.y, det = a * d - b * cc;
    if (!det) return c;
    const ia = d / det, ib = -b / det, ic = -cc / det, id = a / det;
    x.setTransform(px * ia, px * ib, px * ic, px * id, 0, 0);
    x.translate(-f.o.x - (box.x0 * a + box.y0 * cc), -f.o.y - (box.x0 * b + box.y0 * d));
    x.imageSmoothingQuality = "high";
    x.drawImage(img, 0, 0);
    x.setTransform(1, 0, 0, 1, 0, 0);
    return c;
  }
  // the whole label, with room to spare (measured: the label runs from about 1.3 left to 5.4 right, 3.3 up to 1.2 down)
  const LABEL = { x0: -1.7, x1: 5.8, y0: -3.7, y1: 1.5 };
  // the fields, read one by one
  const FIELDS = {
    small: { x0: 1.55, x1: 3.6, y0: -2.3, y1: -1.38 },     // "Batch: 43282 / Quantity: 1007.71 kg"
    big: { x0: 2.3, x1: 5.7, y0: -0.8, y1: 0.12 },         // "Quantity: 1007.71 kg" in large print
    ids: { x0: 2.9, x1: 5.75, y0: -1.8, y1: -0.82 },       // "SAP Internal Label ID: [(97)57996]", "Expiry Date: 2026-12-04"
  };

  // grey, then stretch the contrast between the 2nd and 98th percentile (glare, shadows, the plastic behind)
  function enhance(c) {
    const x = c.getContext("2d", { willReadFrequently: true }), d = x.getImageData(0, 0, c.width, c.height), p = d.data;
    const hist = new Uint32Array(256), n = p.length / 4;
    for (let i = 0; i < p.length; i += 4) { const g = (p[i] * 299 + p[i + 1] * 587 + p[i + 2] * 114) / 1000 | 0; p[i] = g; hist[g]++; }
    let lo = 0, hi = 255, acc = 0;
    for (; lo < 255; lo++) { acc += hist[lo]; if (acc > n * 0.02) break; }
    acc = 0;
    for (; hi > 0; hi--) { acc += hist[hi]; if (acc > n * 0.02) break; }
    const span = Math.max(1, hi - lo);
    for (let i = 0; i < p.length; i += 4) { const v = Math.max(0, Math.min(255, ((p[i] - lo) * 255) / span)); p[i] = p[i + 1] = p[i + 2] = v; }
    x.putImageData(d, 0, 0);
    return c;
  }
  // white out the QR codes (in label units) so Tesseract doesn't read them as text
  function blankCodes(c, box, px, codesLU) {
    const x = c.getContext("2d");
    x.fillStyle = "#fff";
    for (const q of codesLU) {
      const xs = [q.tl.x, q.tr.x, q.br.x, q.bl.x], ys = [q.tl.y, q.tr.y, q.br.y, q.bl.y], m = 0.08;
      x.fillRect((Math.min(...xs) - m - box.x0) * px, (Math.min(...ys) - m - box.y0) * px, (Math.max(...xs) - Math.min(...xs) + 2 * m) * px, (Math.max(...ys) - Math.min(...ys) + 2 * m) * px);
    }
    return c;
  }

  // ------------------------------------------------------------ the label cut out (phone side)
  // The label upright at the camera's full resolution (capped), and its frame in the cut-out's pixels, so the laptop
  // reads the fields without finding the label again.
  function labelCut(img, f, maxPx = 2600) {
    const s = Math.hypot(f.ux.x, f.ux.y), w = LABEL.x1 - LABEL.x0;
    const px = Math.min(s, maxPx / w);
    const canvas = cut(img, f, LABEL, px);
    return { canvas, frame: { o: { x: -LABEL.x0 * px, y: -LABEL.y0 * px }, ux: { x: px, y: 0 }, uy: { x: 0, y: px } } };
  }
  // a point in the picture, in label units
  function toLU(f, p) {
    const a = f.ux.x, b = f.ux.y, cc = f.uy.x, d = f.uy.y, det = a * d - b * cc, dx = p.x - f.o.x, dy = p.y - f.o.y;
    return { x: (d * dx - cc * dy) / det, y: (-b * dx + a * dy) / det };
  }
  // a point in label units, in the picture
  const fromLU = (f, p) => ({ x: f.o.x + p.x * f.ux.x + p.y * f.uy.x, y: f.o.y + p.x * f.ux.y + p.y * f.uy.y });

  // ------------------------------------------------------------ the other QR code, where it should be
  // A small QR is often too small to read in a whole frame scaled down for speed, though a phone's own scanner reads it.
  // So once one code of a label is found, the other is looked for where it should be (measured on real labels: the
  // small one 3.7 to 4.3 big-QR widths right of the big one, up to 1 width up or down), cut out upright from the
  // picture at its full resolution, enlarged, and read on its own (then with the contrast stretched).
  const PARTNER = { small: { x0: 2.9, x1: 5.0, y0: -1.4, y1: 1.4 }, big: { x0: -1.0, x1: 1.0, y0: -1.0, y1: 1.0 } };
  async function findPartner(src, codes) {
    const f = frameOf(codes);
    if (!f) return codes;
    const have = codes.find((c) => c.kind === (f.from === "big QR" ? "big" : "small"));
    const want = f.from === "big QR" ? "small" : "big", box = PARTNER[want];
    const same = (c) => c.kind === want && (!have || (c.batch === have.batch && c.product === have.product));
    if (codes.some(same)) return codes;
    for (const [px, stretch] of [[300, false], [300, true], [420, true]]) {
      const c = cut(src, f, box, px);
      if (stretch) enhance(c);
      let found = [];
      try { found = await readCodes(c.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, c.width, c.height)); } catch { return codes; }
      const hit = found.find(same) || found.find((q) => q.kind === want);
      if (hit) {
        const back = (p) => fromLU(f, { x: box.x0 + p.x / px, y: box.y0 + p.y / px });
        return [...codes, { ...hit, tl: back(hit.tl), tr: back(hit.tr), br: back(hit.br), bl: back(hit.bl), found: "where it should be" }];
      }
    }
    return codes;
  }

  // ------------------------------------------------------------ reading the fields (laptop side)
  const PX = 330;   // pixels per label unit for reading: the small print comes out about 30 px high
  const digits = (t) => String(t || "").replace(/[Oo]/g, "0").replace(/[Il|]/g, "1").replace(/[Ss](?=\d)|(?<=\d)[Ss]/g, "5");
  // The quantity as printed: always with a decimal point ("1007.71 kg", "0.833333 case", "1000.0 m", "87.0 case"), which
  // keeps pack sizes and titles ("20kg", "152 mm", "6x1kg") out. Common misreadings are put right: "kq" / "ka" for kg,
  // "cas e", a decimal point read as a space ("973 39 kg"). Read after the word "Quantity" when it is there.
  const unitOf = (u) => { u = u.toLowerCase().replace(/\s/g, ""); return /^k/.test(u) ? "kg" : /^c/.test(u) ? "case" : /^m/.test(u) ? "m" : "each"; };
  function qtyIn(text) { return qtysIn(text)[0] || null; }
  function qtysIn(text) {
    let t = String(text || "").replace(/(\d),(\d)/g, "$1.$2");
    t = t.replace(/(\d{1,5}) (\d{1,6})(?=\s*(?:k[gq9a]|cas|m[mn]?\b))/gi, "$1.$2");
    const re = /([0-9OoIlS|]{1,6}\.[0-9OoIlS|]{1,6})\s*(k[gq9a]s?|c\s?a\s?s\s?e\s?s?|m[mn]?|ea(?:ch)?)(?![a-z])/gi;
    const at = t.search(/Qu?an/i), out = [];
    for (const part of at >= 0 ? [t.slice(at), t.slice(0, at)] : [t]) {
      for (const x of part.matchAll(re)) {
        const raw = digits(x[1]);
        if (/^\d+\.\d+$/.test(raw)) out.push({ qty: parseFloat(raw), unit: unitOf(x[2]) });
      }
    }
    return out;
  }
  // The batch: the number under "Batch:" (4 to 12 digits; noise and a stray space inside are dropped). Without the
  // word, the first such number in the box that isn't a date or the quantity.
  function batchIn(text) {
    const lines = String(text || "").replace(/[[(]?\s*\(?\s*[95]\s*7\s*\)\s*[0-9OoIlS|]{2,10}\s*[\])]?/g, " ").split(/\n/);
    // numbers in a line, word by word: a word counts when it's all digits or look-alikes (O, I, l, S); words one space
    // apart join up ("4731 9"); the line of a date or a quantity doesn't count
    const num = (l) => {
      if (/\d{4}\s*[-–.]\s*\d\d\s*[-–.]\s*\d\d/.test(l) || qtyIn(l)) return null;
      const found = [];
      let cur = "";
      for (const t of l.split(/( +)/)) {
        if (/^ +$/.test(t)) { if (t.length > 1 && cur) { found.push(cur); cur = ""; } continue; }
        const c = t.replace(/[^0-9A-Za-z|]/g, "");
        if (c && /\d/.test(c) && /^[0-9OoIlS|]+$/.test(c)) cur += digits(c);
        else { if (cur) found.push(cur); cur = ""; }
      }
      if (cur) found.push(cur);
      return found.find((d) => d.length >= 4 && d.length <= 12) || null;
    };
    const k = lines.findIndex((l) => /\bB[a-z]{1,2}[ct]?ch\b|\bBatch|\bBalch|\bBaten/i.test(l) && !/Produc/i.test(l));
    const q = lines.findIndex((l) => /Qu?an/i.test(l));
    if (k >= 0) {
      const same = num(lines[k].replace(/^.*?B[a-z]{1,4}h?\s*[:.;]?/i, ""));
      if (same) return same;
      for (let i = k + 1; i < lines.length && i <= k + 3; i++) { const n = num(lines[i]); if (n) return n; }
    }
    for (let i = 0; i < (q >= 0 ? q : lines.length); i++) { const n = num(lines[i]); if (n) return n; }
    return null;
  }
  function labelIdIn(text) {
    const m = String(text || "").match(/\(\s*9\s*7\s*\)\s*([0-9OoIlS|]{3,10})/) || String(text || "").match(/Label\s*ID\s*[:.]?\s*\[?\s*\(?97\)?\s*([0-9OoIlS|]{3,10})/i);
    return m ? digits(m[1]) : null;
  }
  const expiryIn = (text) => { const m = String(text || "").match(/(20\d\d)\s*[-–.]\s*(\d\d)\s*[-–.]\s*(\d\d)/); return m ? `${m[1]}-${m[2]}-${m[3]}` : null; };

  async function ocr(worker, canvas, psm) {
    await worker.setParameters({ tessedit_pageseg_mode: psm, preserve_interword_spaces: "1" });
    const { data } = await worker.recognize(canvas);
    return data.text || "";
  }

  // Read the label: `img` is the label cut-out from the phone (or a whole photo), `frame` its label frame if known,
  // `codes` the QR codes read on the phone (blanked out before reading), `expect` what the QR codes say (product,
  // batch, qty, unit). The printed batch and quantity are each checked against the QR codes:
  //   "match"   some reading of the print agrees with the QR code
  //   "differs" the print was read, and says something else (worth a look at the photo)
  //   "read"    no QR value to check against: the print is all there is
  //   "unread"  the print couldn't be read
  // The fields are read one by one first; the whole label is read too when something is missing or doesn't match.
  async function readLabel(worker, img, frame, codes = [], expect = {}) {
    let f = frame;
    if (!f) { const found = await codesIn(img, img.width, img.height); f = frameOf(found); codes = found; }
    const out = { labelId: null, expiry: null, texts: [], anchored: !!f };
    const reads = { batch: [], qty: [] };
    const codesLU = f ? codes.filter((q) => q.tl).map((q) => ({ tl: toLU(f, q.tl), tr: toLU(f, q.tr), br: toLU(f, q.br), bl: toLU(f, q.bl) })) : [];
    const read = async (name, c, psm) => { const t = await ocr(worker, c, psm); out.texts.push(`[${name}]\n${t.trim()}`); return t; };
    const field = (name, box, psm) => read(name, blankCodes(enhance(cut(img, f, box, PX)), box, PX, codesLU), psm);
    const note = (t, from) => {
      const b = batchIn(t); if (b) reads.batch.push({ value: b, from });
      for (const q of qtysIn(t)) reads.qty.push({ value: q.qty, unit: q.unit, from });
      out.labelId = out.labelId || labelIdIn(t); out.expiry = out.expiry || expiryIn(t);
    };
    const sameQty = (r) => expect.qty !== null && expect.qty !== undefined && Math.abs(r.value - expect.qty) < 1e-6 && (!expect.unit || r.unit === expect.unit);
    const done = () => (expect.batch ? reads.batch.some((r) => r.value === expect.batch) : reads.batch.length > 0)
      && (expect.qty !== null && expect.qty !== undefined ? reads.qty.some(sameQty) : reads.qty.length > 0);
    if (f) {
      note(await field("Batch and Quantity", FIELDS.small, "6"), "small print");
      const big = await field("Quantity (large print)", FIELDS.big, "7");
      for (const q of qtysIn(big)) reads.qty.push({ value: q.qty, unit: q.unit, from: "large print" });
      note(await field("Label ID and expiry", FIELDS.ids, "6"), "ids");
    }
    if (!done()) {
      const px = Math.min(PX, 3000 / (LABEL.x1 - LABEL.x0));
      const c = f ? blankCodes(enhance(cut(img, f, LABEL, px)), LABEL, px, codesLU) : enhance(whole(img, 2400));
      note(await read(f ? "whole label" : "whole photo (no QR code found)", c, "11"), "whole label");
    }
    out.text = out.texts.join("\n\n");
    // the QR's batch printed anywhere in what was read (spaces and look-alike letters allowed) also counts
    const flat = digits(out.text).replace(/[^0-9]/g, "");
    // "differs" only when two separate readings agree on the other value; one misreading on its own is "unclear"
    const pick = (list, expected, same, seen) => {
      if (expected !== null && expected !== undefined && expected !== "") {
        if (list.some(same) || seen) return { check: "match", value: expected };
        const n = new Map();
        for (const r of list) { const k = r.value + "|" + (r.unit || ""); n.set(k, (n.get(k) || new Set()).add(r.from)); }
        const agreed = list.find((r) => n.get(r.value + "|" + (r.unit || "")).size >= 2);
        if (agreed) return { check: "differs", value: agreed.value, unit: agreed.unit };
        return list.length ? { check: "unclear", value: list[0].value, unit: list[0].unit } : { check: "unread", value: null };
      }
      return list.length ? { check: "read", value: list[0].value, unit: list[0].unit } : { check: "unread", value: null };
    };
    const b = pick(reads.batch, expect.batch, (r) => r.value === expect.batch, !!expect.batch && expect.batch.length >= 5 && flat.includes(expect.batch));
    const q = pick(reads.qty, expect.qty, sameQty, false);
    out.batch = b.value; out.batchCheck = b.check;
    out.qty = q.value; out.unit = q.check === "match" ? expect.unit || (reads.qty.find(sameQty) || {}).unit || null : q.unit || null; out.qtyCheck = q.check;
    out.reads = reads;
    return out;
  }
  function whole(img, max) {
    const sc = Math.min(1, max / Math.max(img.width, img.height)), c = document.createElement("canvas");
    c.width = Math.round(img.width * sc); c.height = Math.round(img.height * sc);
    c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
    return c;
  }

  root.BagOCR = { readCodes, codesIn, findPartner, frameOf, cut, labelCut, readLabel, enhance, LABEL, FIELDS, toLU, fromLU, qtyIn, qtysIn, batchIn, labelIdIn };
})(typeof window !== "undefined" ? window : globalThis);
