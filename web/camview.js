// The camera across the whole screen, as the stock trace (the checker) and Scan and check here use it: the picture in
// a rounded frame with a margin round it, a message on it, round buttons under it (close, the light where the phone
// has one, and any the page adds), and a zoom slider for labels out of reach (a high rack). The zoom is the camera's own
// where the phone has one; else the middle of the picture is enlarged, and that part is what the page reads. The page is handed each frame to read and closes the camera when it has what it
// needs (cam.finish), so there's nothing to tap once a label is read.
(function (root) {
  "use strict";
  const CSS = `
  .camview[hidden] { display: none; }
  .camview { position: fixed; inset: 0; z-index: 55; background: #0c0f0e; display: grid; grid-template-rows: minmax(0, 1fr) auto; gap: 14px;
    padding: calc(env(safe-area-inset-top, 0px) + 12px) calc(env(safe-area-inset-right, 0px) + 12px) calc(env(safe-area-inset-bottom, 0px) + 16px) calc(env(safe-area-inset-left, 0px) + 12px); }
  .camview .cv-view { position: relative; display: grid; min-height: 0; width: 100%; max-width: 900px; justify-self: center; border-radius: 22px; overflow: hidden; background: #000; }
  .camview .cv-view > * { grid-area: 1 / 1; position: relative; z-index: 1; }
  .camview .cv-view > video { z-index: 0; width: 100%; height: 100%; object-fit: cover; }   /* video paints over its siblings otherwise */
  .camview .cv-aim { place-self: center; width: min(72%, 360px); aspect-ratio: 1.5; border: 3px solid rgba(255, 255, 255, 0.9); border-radius: 16px; box-shadow: 0 0 0 100vmax rgba(0, 0, 0, 0.3); pointer-events: none; transition: border-color 0.15s; }
  .camview .cv-aim.cv-hit { border-color: #4ade80; border-width: 4px; }
  .camview .cv-msg { align-self: start; justify-self: center; margin: 14px 14px 0; padding: 8px 14px; max-width: calc(100% - 28px); background: rgba(0, 0, 0, 0.6); color: #fff; border-radius: 999px; font: 600 14px/1.35 var(--sans, system-ui, sans-serif); text-align: center; }
  .camview .cv-bar { display: flex; flex-wrap: wrap; justify-content: center; align-items: center; gap: 14px 22px; }
  .camview .cv-bar button { cursor: pointer; border: 0; -webkit-appearance: none; appearance: none; color: #fff; background: rgba(255, 255, 255, 0.16); }
  .camview .cv-round { width: 58px; height: 58px; border-radius: 50%; padding: 0; line-height: 0; }
  .camview .cv-round svg { display: block; margin: 0 auto; }
  .camview .cv-round.cv-close { background: #fff; color: #111; }
  .camview .cv-round.cv-on { background: #ffd54a; color: #111; }
  .camview .cv-pill { height: 46px; padding: 0 18px; border-radius: 999px; font: 600 14px var(--sans, system-ui, sans-serif); }
  .camview .cv-zoom { flex: 1 0 100%; display: flex; align-items: center; justify-content: center; gap: 12px; color: #fff; font: 600 14px var(--sans, system-ui, sans-serif); }
  .camview .cv-zoom input { width: min(420px, 70vw); accent-color: #fff; height: 28px; }
  .camview .cv-zoom output { min-width: 3.2em; font-variant-numeric: tabular-nums; }
  html.camview-on, html.camview-on body { overflow: hidden; }`;
  const ICONS = {
    light: `<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round" d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3z"/></svg>`,
    close: `<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" d="M6 6l12 12M18 6L6 18"/></svg>`,
  };
  let ui = null, cur = null;

  function build() {
    if (ui) return ui;
    const style = document.createElement("style"); style.textContent = CSS; document.head.appendChild(style);
    const wrap = document.createElement("div");
    wrap.className = "camview"; wrap.hidden = true;
    wrap.setAttribute("role", "dialog"); wrap.setAttribute("aria-modal", "true"); wrap.setAttribute("aria-label", "Camera");
    wrap.innerHTML = `<div class="cv-view"><video playsinline muted autoplay></video><div class="cv-aim"></div><div class="cv-msg" aria-live="polite"></div></div>`
      + `<div class="cv-bar"><label class="cv-zoom" hidden><span aria-hidden="true">Zoom</span><input type="range" min="1" max="4" step="0.1" value="1" aria-label="Zoom"><output>1×</output></label><span class="cv-extra" style="display:contents"></span><button type="button" class="cv-round cv-light" hidden aria-label="Light" title="Light">${ICONS.light}</button>`
      + `<button type="button" class="cv-round cv-close" aria-label="Close camera" title="Close camera">${ICONS.close}</button></div>`;
    document.body.appendChild(wrap);
    const q = (s) => wrap.querySelector(s);
    ui = { wrap, video: q("video"), aim: q(".cv-aim"), msg: q(".cv-msg"), extra: q(".cv-extra"), light: q(".cv-light"), close: q(".cv-close"),
      zoom: q(".cv-zoom"), zoomIn: q(".cv-zoom input"), zoomOut: q(".cv-zoom output") };
    ui.zoomIn.oninput = () => setZoom(Number(ui.zoomIn.value));
    ui.close.onclick = () => stop();
    ui.light.onclick = async () => {
      const track = cur && cur.stream && cur.stream.getVideoTracks()[0];
      if (!track) return;
      const on = !ui.light.classList.contains("cv-on");
      try { await track.applyConstraints({ advanced: [{ torch: on }] }); ui.light.classList.toggle("cv-on", on); } catch { ui.msg.textContent = "The light can't be switched from here"; }
    };
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && cur) stop(); });
    document.addEventListener("visibilitychange", () => { if (document.hidden) stop(); });
    window.addEventListener("pagehide", () => stop());
    return ui;
  }

  // Zoom: the camera's own (track constraint) where it has one, else digital: the picture is enlarged on screen and
  // the page is handed the enlarged middle of each frame, at the camera's full resolution (a canvas standing in for
  // the video, with its videoWidth / videoHeight), so a small QR code high up is read as well as one held close.
  let lastZoom = 1;
  function setZoom(z) {
    const me = cur;
    if (!me) return;
    lastZoom = z; ui.zoomOut.textContent = `${(Math.round(z * 10) / 10).toString()}×`;
    if (me.hwZoom) {
      me.dz = 1;
      const track = me.stream && me.stream.getVideoTracks()[0];
      if (track) track.applyConstraints({ advanced: [{ zoom: z }] }).catch(() => {});
    } else {
      me.dz = z; ui.video.style.transform = z > 1 ? `scale(${z})` : "";
    }
  }
  function cropped(me, v) {
    const z = me.dz, w = Math.round(v.videoWidth / z), h = Math.round(v.videoHeight / z);
    const c = me.crop || (me.crop = document.createElement("canvas"));
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    c.getContext("2d").drawImage(v, (v.videoWidth - w) / 2, (v.videoHeight - h) / 2, w, h, 0, 0, w, h);
    c.videoWidth = w; c.videoHeight = h; c.readyState = 4;
    return c;
  }

  // opts: read(video, cam): one frame to read (called again and again while the camera is open); msg: what it
  // says first; buttons: [{ text, title, onClick(cam) }]; idleMs / idleMsg: closes after that long without
  // cam.alive(); onClose(reason): reason is idleMsg when it closed for lack of a label, else undefined.
  // Resolves when the picture shows; rejects (and closes) when there's no camera.
  function start(opts) {
    const u = build();
    if (cur) stop();
    // the camera is asked for first thing, in the tap itself: phones are strict about the camera outside a tap
    const ask = navigator.mediaDevices && navigator.mediaDevices.getUserMedia
      ? navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: "environment" }, width: { ideal: opts.width || 1920 }, height: { ideal: opts.height || 1080 } } })
      : Promise.reject(Object.assign(new Error("This browser can't show the camera here"), { name: "NotSupportedError" }));
    const me = cur = { opts, stream: null, timer: null, busy: false, done: false, idleAt: Date.now(), dz: 1, hwZoom: null };
    u.zoom.hidden = true; u.video.style.transform = "";
    u.msg.textContent = opts.msg || "Point at a label's QR code";
    u.aim.classList.remove("cv-hit"); u.light.hidden = true; u.light.classList.remove("cv-on");
    u.extra.textContent = "";
    for (const b of opts.buttons || []) {
      const el = document.createElement("button");
      el.type = "button"; el.className = "cv-pill"; el.textContent = b.text; if (b.title) el.title = b.title;
      el.onclick = () => { if (cur === me) b.onClick(api); };
      u.extra.appendChild(el);
    }
    u.wrap.hidden = false; document.documentElement.classList.add("camview-on");
    return ask.then(async (stream) => {
      if (cur !== me) { stream.getTracks().forEach((t) => t.stop()); return false; }
      me.stream = stream; u.video.srcObject = stream;
      await u.video.play().catch(() => {});
      const track = stream.getVideoTracks()[0], caps = track.getCapabilities ? track.getCapabilities() : {};
      u.light.hidden = !caps.torch;
      // zoom: the camera's own range, else digital up to 4×; the last zoom used comes back
      const hz = caps.zoom && caps.zoom.max > (caps.zoom.min || 1) ? caps.zoom : null;
      me.hwZoom = hz;
      const lo = hz ? hz.min || 1 : 1, hi = hz ? Math.min(hz.max, 10) : 4;
      u.zoomIn.min = lo; u.zoomIn.max = hi; u.zoomIn.step = hz && hz.step ? Math.max(hz.step, 0.1) : 0.1;
      u.zoomIn.value = Math.min(hi, Math.max(lo, lastZoom));
      u.zoom.hidden = false;
      setZoom(Number(u.zoomIn.value));
      if (caps.focusMode && caps.focusMode.includes("continuous")) track.applyConstraints({ advanced: [{ focusMode: "continuous" }] }).catch(() => {});
      tick(me);
      return true;
    }, (e) => { if (cur === me) stop(); throw e; });
  }
  async function tick(me) {
    if (cur !== me || me.done) return;
    const v = ui.video;
    if (!me.busy && v.readyState >= 2 && v.videoWidth) {
      me.busy = true;
      try { await me.opts.read(me.dz > 1 ? cropped(me, v) : v, api); } catch { /* this frame: the next one */ }
      me.busy = false;
    }
    if (cur !== me || me.done) return;
    if (me.opts.idleMs && Date.now() - me.idleAt > me.opts.idleMs) { stop(me.opts.idleMsg); return; }
    me.timer = setTimeout(() => tick(me), 110);
  }
  function stop(reason) {
    const me = cur;
    if (!me) return;
    cur = null; clearTimeout(me.timer);
    if (me.stream) me.stream.getTracks().forEach((t) => t.stop());
    ui.video.srcObject = null; ui.wrap.hidden = true; document.documentElement.classList.remove("camview-on");
    ui.aim.classList.remove("cv-hit"); ui.light.classList.remove("cv-on"); ui.video.style.transform = ""; ui.zoom.hidden = true;
    if (me.opts.onClose) me.opts.onClose(reason);
  }
  // what the page's reader can do with the camera
  const api = {
    msg(text) { if (cur) ui.msg.textContent = text; },
    // a code was seen: not idle
    alive() { if (cur) cur.idleAt = Date.now(); },
    // a code was taken and the camera stays open for the next: the frame goes green for a moment
    flash(ms = 500) {
      const me = cur;
      if (!me) return;
      ui.aim.classList.add("cv-hit"); clearTimeout(me.flashT);
      me.flashT = setTimeout(() => { if (cur === me && !me.done) ui.aim.classList.remove("cv-hit"); }, ms);
    },
    // got it: the frame goes green, then the camera closes and fn runs
    finish(fn, ms = 300) {
      const me = cur;
      if (!me || me.done) return;
      me.done = true; ui.aim.classList.add("cv-hit");
      setTimeout(() => { if (cur === me) stop(); fn(); }, ms);
    },
    stop,
  };
  root.CamView = { start, stop, get open() { return !!cur; } };
})(window);
