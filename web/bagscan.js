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
    const config = { iceServers: iceServers() };
    if (!signal) return { debug: 1, config };
    const [host, port] = signal.split(":");
    const local = /^(localhost|127\.|10\.|192\.168\.)/.test(host);
    return { debug: 1, host, port: Number(port) || 9000, path: "/", secure: !local, config };
  }
  const signalQuery = () => (signal ? "&signal=" + encodeURIComponent(signal) : "");

  // ------------------------------------------------------------ the link's routes (ICE servers)
  // The phone links straight to the laptop where the networks allow it (found with Google's STUN server); PeerJS's
  // free relay (TURN, port 3478) carries it where they don't. Office networks often block both, and allow only web
  // traffic on port 443: a relay of your own on port 443, set up once on the laptop (Input products, Connection),
  // gets through. The phones get it with the pairing code.
  const DEFAULT_ICE = [{ urls: "stun:stun.l.google.com:19302" },
    { urls: ["turn:eu-0.turn.peerjs.com:3478", "turn:us-0.turn.peerjs.com:3478"], username: "peerjs", credential: "peerjsp" }];
  const RELAY_KEY = "sapa-relay";
  const iceServers = () => [...DEFAULT_ICE, ...(relay.get() || [])];
  const relay = {
    get() { try { const v = JSON.parse(store.get(RELAY_KEY) || "null"); return Array.isArray(v) && v.length ? v : null; } catch { return null; } },
    set(list) { if (list && list.length) store.set(RELAY_KEY, JSON.stringify(list)); else store.del(RELAY_KEY); },
    // What a relay service shows for its servers: the iceServers list as JSON or as JavaScript (urls, username,
    // credential in each entry). Its STUN entries are left out (Google's does that job); the TURN ones are kept,
    // those with the same login put together.
    parse(text) {
      const out = [];
      const q = (k) => new RegExp(`["']?${k}["']?\\s*:\\s*(\\[[^\\]]*\\]|"[^"]*"|'[^']*'|\`[^\`]*\`)`);
      for (const obj of String(text || "").match(/\{[^{}]*\}/g) || []) {
        const u = obj.match(q("urls")) || obj.match(q("url"));
        if (!u) continue;
        const urls = (u[1].match(/["'`][^"'`]+["'`]/g) || []).map((x) => x.slice(1, -1).trim()).filter((x) => /^turns?:/i.test(x));
        if (!urls.length) continue;
        const str = (k) => { const m = obj.match(q(k)); return m ? m[1].slice(1, -1) : ""; };
        const username = str("username"), credential = str("credential");
        const same = out.find((x) => x.username === username && x.credential === credential);
        if (same) same.urls.push(...urls.filter((x) => !same.urls.includes(x))); else out.push({ urls, username, credential });
      }
      return out;
    },
    // in the pairing link (after #, so it isn't sent to any server): base64url of the list
    pack(list) { return btoa(unescape(encodeURIComponent(JSON.stringify(list.map((x) => [x.urls, x.username, x.credential]))))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); },
    unpack(s) {
      try {
        const v = JSON.parse(decodeURIComponent(escape(atob(String(s).replace(/-/g, "+").replace(/_/g, "/")))));
        return Array.isArray(v) ? v.filter((x) => Array.isArray(x) && Array.isArray(x[0])).map(([urls, username, credential]) => ({ urls: urls.map(String), username: String(username || ""), credential: String(credential || "") })) : null;
      } catch { return null; }
    },
    // a pairing link (or this page's address) carrying a relay: kept on this phone; true when there was one
    fromLink(link) {
      const m = String(link || "").match(/#(?:.*&)?relay=([A-Za-z0-9_-]+)/);
      const list = m && relay.unpack(m[1]);
      if (list && list.length) { relay.set(list); return true; }
      return false;
    },
  };

  // Which routes this network and browser allow: candidates gathered with no servers (WebRTC itself), with Google's
  // STUN (direct links to the internet, over UDP), with PeerJS's relay (port 3478) and with the relay set up here.
  async function gather(servers, ms = 7000) {
    const pc = new RTCPeerConnection({ iceServers: servers });
    const found = [];
    pc.onicecandidate = (e) => {
      const c = e.candidate;
      if (!c || !c.candidate) return;
      const typ = (c.candidate.match(/ typ (\w+)/) || [])[1] || c.type;
      found.push({ type: typ, protocol: (c.protocol || (c.candidate.match(/ (udp|tcp) /i) || [])[1] || "").toLowerCase(), relayProtocol: c.relayProtocol || "", url: c.url || "" });
    };
    pc.createDataChannel("check");
    await pc.setLocalDescription(await pc.createOffer());
    await new Promise((done) => {
      const t = setTimeout(done, ms);
      pc.onicegatheringstatechange = () => { if (pc.iceGatheringState === "complete") { clearTimeout(t); done(); } };
    });
    pc.close();
    return found;
  }
  async function netCheck() {
    if (typeof RTCPeerConnection === "undefined") return { webrtc: false, host: false, stun: false, peerjs: false, own: null };
    const own = relay.get();
    const [h, st, pj, ow] = await Promise.all([gather([], 3000), gather([DEFAULT_ICE[0]]), gather([DEFAULT_ICE[1]]), own ? gather(own) : Promise.resolve(null)]);
    const relayOf = (list) => list.filter((c) => c.type === "relay");
    return {
      webrtc: true,
      host: h.some((c) => c.type === "host"),
      stun: st.some((c) => c.type === "srflx"),
      peerjs: relayOf(pj).length > 0,
      own: ow === null ? null : relayOf(ow).length > 0,
      ownHow: ow ? [...new Set(relayOf(ow).map((c) => c.relayProtocol || "").filter(Boolean))] : [],
    };
  }

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const p2 = (n) => String(n).padStart(2, "0");
  const hms = (t) => { const d = new Date(t); return `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`; };
  const uid = () => (root.crypto && crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode: not remembered */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* nothing kept */ } },
  };

  root.BagScan = { PREFIX, UNITS, parseCode, parseLabel, mergeCodes, peerOptions, signalQuery, relay, netCheck, esc, hms, uid, store };
})(typeof window !== "undefined" ? window : globalThis);
