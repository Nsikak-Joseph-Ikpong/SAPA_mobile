// Shared by scanner.html (phone) and inputs.html (laptop): reading bag labels and the browser-to-browser link.
// The phone sends each scan (QR text + photo) straight to the laptop's browser over WebRTC (PeerJS). Nothing is
// stored on a server: PeerJS's free cloud server only introduces the two browsers to each other.
(function (root) {
  "use strict";
  const PREFIX = "sapa-";

  // GS1 text on the plant's labels, e.g. "(90)RCSL2061WF1856(10)50085(97)L0001": 90 = product, 10 = batch,
  // 97 = label ID. Raw GS1 (fields ended by the GS character) and a bare batch number are read too.
  function parseLabel(text) {
    const t = String(text || "").trim(), ai = {};
    for (const m of t.matchAll(/\((\d{2,4})\)([^()\u001d]*)/g)) ai[m[1]] = m[2].trim();
    if (!Object.keys(ai).length && /\u001d/.test(t)) {
      for (const part of t.replace(/^\]Q\d/, "").split("\u001d")) { const m = part.match(/^(90|10|97|21|01)(.+)$/); if (m) ai[m[1]] = m[2].trim(); }
    }
    if (ai["10"] || ai["90"]) return { product: ai["90"] || "", batch: ai["10"] || "", label: ai["97"] || "" };
    return /^[\w.-]{2,40}$/.test(t) ? { product: "", batch: t, label: "" } : null;
  }

  // The weight printed on the bag, from the OCR text: "Net weight 12.46 kg", "NET WT: 12,46", "12.46KG".
  // A pack size such as "6x1kg" is not a weight.
  function parseWeight(text) {
    const t = String(text || "").replace(/(\d)\s*,\s*(\d)/g, "$1.$2");
    const ok = (v) => v >= 0.05 && v <= 2000;
    const net = t.match(/(?:net+\s*(?:wt|weight|wgt|mass)?|weight|wgt)\s*[:.=\-]?\s*(\d{1,4}(?:\.\d{1,3})?)\s*(kgs?|k9)?/i);
    if (net && ok(+net[1])) return { kg: +net[1], how: "net weight" };
    for (const m of t.matchAll(/(^|[^x×*\d.])(\d{1,4}(?:\.\d{1,3})?)\s*(?:kgs?|k9|kilos?)(?![a-z])/gim)) {
      if (ok(+m[2])) return { kg: +m[2], how: "number + kg" };
    }
    return null;
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

  root.BagScan = { PREFIX, parseLabel, parseWeight, peerOptions, signalQuery, esc, hms, uid, store };
})(typeof window !== "undefined" ? window : globalThis);
