// Shared by scanner.html (phone) and inputs.html (laptop): reading bag labels and the browser-to-browser link.
// The phone sends each scan (QR text + photo) straight to the laptop's browser over WebRTC (PeerJS). Nothing is
// stored on a server: PeerJS's free cloud server only introduces the two browsers to each other.
(function (root) {
  "use strict";
  const PREFIX = "sapa-";

  // The two QR codes on the plant's SAP labels:
  //   big (goods movement):  "(90)RMMA20BF(10)43282"          90 = product, 10 = batch (97 = label ID when present)
  //   small (scanning in):   "RMMA20BF,43282,1007.71,KGM"     product, batch, quantity, unit
  // Units are UN/ECE codes: KGM = kg, XCS = case, MTR = m. Raw GS1 (fields ended by the GS character) and a bare batch
  // number are read too.
  const UNITS = { KGM: "kg", XCS: "case", MTR: "m", EA: "each", C62: "each", H87: "piece", LTR: "l", GRM: "g" };
  function parseCode(text) {
    const t = String(text || "").trim();
    const sm = t.match(/^([A-Z0-9][A-Z0-9._-]{1,39}),([A-Z0-9._-]{1,30}),(-?\d+(?:\.\d+)?),([A-Z0-9]{1,4})$/i);
    if (sm) return { kind: "small", product: sm[1].toUpperCase(), batch: sm[2], qty: parseFloat(sm[3]), unit: UNITS[sm[4].toUpperCase()] || sm[4].toLowerCase(), unitCode: sm[4].toUpperCase() };
    const ai = {};
    for (const m of t.matchAll(/\((\d{2,4})\)([^()\u001d]*)/g)) ai[m[1]] = m[2].trim();
    if (!Object.keys(ai).length && /\u001d/.test(t)) {
      for (const part of t.replace(/^\]Q\d/, "").split("\u001d")) { const m = part.match(/^(90|10|97|21|01)(.+)$/); if (m) ai[m[1]] = m[2].trim(); }
    }
    if (ai["10"] || ai["90"]) return { kind: "big", product: (ai["90"] || "").toUpperCase(), batch: ai["10"] || "", label: ai["97"] || "" };
    return { kind: "other" };
  }
  // one label's codes together: product and batch from either, quantity and unit from the small one
  function parseLabel(text) {
    const c = parseCode(text);
    if (c.kind === "big" || c.kind === "small") return { product: c.product, batch: c.batch, label: c.label || "", qty: c.qty ?? null, unit: c.unit || "" };
    const t = String(text || "").trim();
    return /^[\w.-]{2,40}$/.test(t) ? { product: "", batch: t, label: "", qty: null, unit: "" } : null;
  }
  function mergeCodes(codes) {
    const big = codes.find((c) => c.kind === "big"), small = codes.find((c) => c.kind === "small" && (!big || (c.batch === big.batch && c.product === big.product)));
    const any = big || small;
    if (!any) return null;
    return { product: any.product, batch: any.batch, label: (big && big.label) || "", qty: small ? small.qty : null, unit: small ? small.unit : "",
      big: big ? big.text : "", small: small ? small.text : "",
      // the big and small codes of different bags in one picture
      clash: !!(big && codes.some((c) => c.kind === "small" && (c.batch !== big.batch || c.product !== big.product)) && !small) };
  }

  // ?signal=host:port points both pages at a self-hosted PeerJS server (used for testing); the pairing link carries it
  const signal = new URLSearchParams(location.search).get("signal");
  function peerOptions() {
    if (!signal) return { debug: 1 };
    const [host, port] = signal.split(":");
    const local = /^(localhost|127\.|10\.|192\.168\.)/.test(host);
    return { debug: 1, host, port: Number(port) || 9000, path: "/", secure: !local };
  }
  const signalQuery = () => (signal ? "&signal=" + encodeURIComponent(signal) : "");

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const p2 = (n) => String(n).padStart(2, "0");
  const hms = (t) => { const d = new Date(t); return `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`; };
  const uid = () => (root.crypto && crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode: not remembered */ } },
  };

  root.BagScan = { PREFIX, UNITS, parseCode, parseLabel, mergeCodes, peerOptions, signalQuery, esc, hms, uid, store };
})(typeof window !== "undefined" ? window : globalThis);
