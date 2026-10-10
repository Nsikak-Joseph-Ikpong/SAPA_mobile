// Reading the weight off a bag photo (laptop side). The QR code is found in the photo first: it says where the
// label is, how big it is and which way up. The label is cut out around it, turned upright, enlarged and its
// contrast stretched before Tesseract reads it. The whole photo is only read when that finds no weight.
(function (root) {
  "use strict";
  const B = root.BagScan;

  // the QR code's corners in the photo (jsQR on a reduced copy, scaled back)
  function locateQR(img) {
    const W = img.width, H = img.height;
    for (const max of [1200, 1800, 800]) {
      const sc = Math.min(1, max / Math.max(W, H)), c = document.createElement("canvas");
      c.width = Math.round(W * sc); c.height = Math.round(H * sc);
      const x = c.getContext("2d", { willReadFrequently: true });
      x.drawImage(img, 0, 0, c.width, c.height);
      const r = root.jsQR(x.getImageData(0, 0, c.width, c.height).data, c.width, c.height, { inversionAttempts: "attemptBoth" });
      if (r) {
        const p = (q) => ({ x: q.x / sc, y: q.y / sc }), L = r.location;
        return { data: r.data, tl: p(L.topLeftCorner), tr: p(L.topRightCorner), bl: p(L.bottomLeftCorner), br: p(L.bottomRightCorner) };
      }
    }
    return null;
  }

  // Cut out a box around the QR code, in the label's own orientation (QR upright), sized in QR widths:
  // left/right/up/down are how many QR widths to take on each side of the QR's centre. Enlarged so the QR is
  // about `qrPx` pixels wide.
  function cutAround(img, q, box, qrPx) {
    const ux = { x: q.tr.x - q.tl.x, y: q.tr.y - q.tl.y };
    const s = Math.hypot(ux.x, ux.y), angle = Math.atan2(ux.y, ux.x);
    const cx = (q.tl.x + q.tr.x + q.bl.x + q.br.x) / 4, cy = (q.tl.y + q.tr.y + q.bl.y + q.br.y) / 4;
    const k = Math.min(qrPx / s, 3);
    const w = Math.round((box.left + box.right) * s * k), h = Math.round((box.up + box.down) * s * k);
    const lim = 3000 / Math.max(w, h), kk = lim < 1 ? k * lim : k;
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round((box.left + box.right) * s * kk)); c.height = Math.max(1, Math.round((box.up + box.down) * s * kk));
    const x = c.getContext("2d", { willReadFrequently: true });
    x.fillStyle = "#fff"; x.fillRect(0, 0, c.width, c.height);
    x.translate(box.left * s * kk, box.up * s * kk);
    x.scale(kk, kk); x.rotate(-angle); x.translate(-cx, -cy);
    x.imageSmoothingQuality = "high";
    x.drawImage(img, 0, 0);
    return c;
  }

  // The label cut out on the phone at full camera resolution (QR upright, nothing enlarged), and where the QR
  // code sits in that cut-out, so the laptop doesn't have to find it again
  const LABEL_BOX = { left: 7, right: 7, up: 5, down: 6 };
  function labelCrop(img, q) {
    const s = Math.hypot(q.tr.x - q.tl.x, q.tr.y - q.tl.y);
    const c = cutAround(img, q, LABEL_BOX, s);
    const k = c.width / ((LABEL_BOX.left + LABEL_BOX.right) * s), cx = LABEL_BOX.left * s * k, cy = LABEL_BOX.up * s * k, h = (s * k) / 2;
    return { canvas: c, qr: { tl: { x: cx - h, y: cy - h }, tr: { x: cx + h, y: cy - h }, bl: { x: cx - h, y: cy + h }, br: { x: cx + h, y: cy + h } } };
  }

  // the whole photo turned upright (QR angle), reduced to at most `max` pixels
  function wholeUpright(img, q, max) {
    const angle = q ? Math.atan2(q.tr.y - q.tl.y, q.tr.x - q.tl.x) : 0;
    const sc = Math.min(1, max / Math.max(img.width, img.height));
    const w = img.width * sc, h = img.height * sc, cos = Math.abs(Math.cos(angle)), sin = Math.abs(Math.sin(angle));
    const c = document.createElement("canvas");
    c.width = Math.round(w * cos + h * sin); c.height = Math.round(w * sin + h * cos);
    const x = c.getContext("2d", { willReadFrequently: true });
    x.fillStyle = "#fff"; x.fillRect(0, 0, c.width, c.height);
    x.translate(c.width / 2, c.height / 2); x.rotate(-angle); x.scale(sc, sc); x.translate(-img.width / 2, -img.height / 2);
    x.drawImage(img, 0, 0);
    return c;
  }

  // grey, then stretch the contrast between the 2nd and 98th percentile (glare, shadows, grey plastic behind)
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

  // the same corners a quarter turn on: for when the reader found the code but not which way up it is
  const turn = (q) => ({ tl: q.bl, tr: q.tl, br: q.tr, bl: q.br });

  // Tried in order until one gives a weight (a "net weight" reading stops the search; a bare "number kg" is kept
  // in case something better turns up). Tesseract's layout 11 (scattered text) suits a label. Tested on blurred,
  // tilted, unevenly lit photos: with the QR position known, the label around it at ~140 px per QR width read
  // every weight, in under a second each; reading the whole photo got about one in five.
  async function readWeight(worker, blob, opts = {}) {
    const img = await createImageBitmap(blob);
    // where the phone saw the QR code (same picture, same pixels); else look for it here
    const q = opts.qr && opts.qr.tl ? opts.qr : locateQR(img);
    const tries = [];
    if (q) {
      const near = { left: 4.5, right: 4.5, up: 3, down: 3.5 };
      tries.push(["label around the QR code", () => cutAround(img, q, near, 140)]);
      let r = q;
      for (const deg of [90, 180, 270]) { const rq = (r = turn(r)); tries.push([`label around the QR code, turned ${deg}°`, () => cutAround(img, rq, near, 140)]); }
      tries.push(["wider area around the QR code", () => cutAround(img, q, { left: 7, right: 7, up: 5, down: 6 }, 160)]);
    }
    let photo = null;
    if (opts.photo) photo = await createImageBitmap(opts.photo);
    const whole = photo || img, wq = photo ? locateQR(photo) : q;
    tries.push(["whole photo", () => wholeUpright(whole, wq, 2000)]);
    await worker.setParameters({ tessedit_pageseg_mode: "11" });
    let best = null;
    const texts = [];
    for (const [what, make] of tries) {
      const { data } = await worker.recognize(enhance(make()));
      texts.push(`[${what}]\n${(data.text || "").trim()}`);
      const got = B.parseWeight(data.text);
      if (got && (!best || (got.how === "net weight" && best.how !== "net weight"))) best = { ...got, from: what };
      if (best && best.how === "net weight") break;
    }
    if (img.close) img.close();
    if (photo && photo.close) photo.close();
    return { weight: best, text: texts.join("\n\n") };
  }

  root.BagOCR = { readWeight, locateQR, cutAround, labelCrop, wholeUpright, enhance };
})(typeof window !== "undefined" ? window : globalThis);
