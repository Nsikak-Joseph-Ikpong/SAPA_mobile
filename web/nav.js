// The page switcher: each page's title opens a menu of the three pages (the cheese variance check, Input products,
// the bag scanner). Each page keeps a tab of its own, and the menu brings that tab forward when it's already open
// rather than loading the page again: Input products holds its scans and the phone link only while its tab stays
// open, so switching must never reload it.
(function () {
  "use strict";
  const PAGES = [
    { id: "checker", href: "./", title: "Cheese variance check", sub: "Production orders, the cheese balance, stock trace" },
    { id: "inputs", href: "inputs.html", title: "Input products", sub: "Bags scanned on the line, checked against SAP" },
    { id: "scanner", href: "scanner.html", title: "Bag scanner", sub: "For the phone: pair it from Input products" },
  ];
  const CSS = `
  .navsw { position: relative; display: inline-block; max-width: 100%; }
  .navsw > button { font: inherit; color: inherit; letter-spacing: inherit; background: none; border: 0; cursor: pointer; text-align: left;
    display: inline-flex; align-items: center; gap: 6px; padding: 2px 6px; margin: -2px -6px; border-radius: 6px; max-width: calc(100% + 12px); }
  .navsw > button:hover, .navsw > button[aria-expanded="true"] { background: var(--sunken); }
  .navsw > button:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  .navsw > button svg { flex: none; color: var(--muted); transition: transform .15s; }
  .navsw > button[aria-expanded="true"] svg { transform: rotate(180deg); }
  .navmenu { position: absolute; z-index: 60; top: calc(100% + 6px); left: -6px; width: 300px; max-width: calc(100vw - 24px);
    background: var(--surface); border: 1px solid var(--line); border-radius: 10px; padding: 6px; box-shadow: 0 8px 24px rgba(0, 0, 0, .14);
    font: 14px/1.4 var(--sans, system-ui, sans-serif); letter-spacing: normal; text-transform: none; }
  .navmenu a { display: block; padding: 8px 10px; border-radius: 7px; color: var(--ink); text-decoration: none; }
  .navmenu a:hover, .navmenu a:focus-visible { background: var(--sunken); outline: none; }
  .navmenu a b { font-weight: 600; }
  .navmenu a span { display: block; font-size: 12.5px; color: var(--muted); }
  .navmenu a[aria-current="page"] { background: var(--accent-soft); }
  .navmenu a em { font-style: normal; color: var(--muted); font-size: 12.5px; }
  .navmenu .navnote { padding: 6px 10px 2px; font-size: 12px; color: var(--muted); border-top: 1px solid var(--line); margin-top: 4px; }
  [hidden] { display: none !important; }`;

  // the inputs page answers "inputs?" on this channel, so another page knows it's open somewhere in this browser
  const askInputs = () => new Promise((resolve) => {
    let bc;
    try { bc = new BroadcastChannel("sapa-inputs"); } catch { resolve(false); return; }
    const done = (v) => { clearTimeout(t); bc.close(); resolve(v); };
    const t = setTimeout(() => done(false), 250);
    bc.onmessage = (e) => { if (e.data === "inputs" || e.data === "here") done(true); };
    bc.postMessage("inputs?");
  });

  function mount(h1) {
    const here = h1.dataset.nav;
    window.name = "sapa-" + here;   // so the other pages can find this tab
    const style = document.createElement("style"); style.textContent = CSS; document.head.appendChild(style);
    const wrap = document.createElement("span"); wrap.className = "navsw";
    const btn = document.createElement("button");
    btn.type = "button"; btn.setAttribute("aria-expanded", "false"); btn.setAttribute("aria-haspopup", "true"); btn.title = "Switch page";
    btn.innerHTML = `<span></span><svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M3.5 6l4.5 4.5L12.5 6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    btn.firstChild.textContent = h1.textContent;
    const menu = document.createElement("nav"); menu.className = "navmenu"; menu.hidden = true; menu.setAttribute("aria-label", "Pages");
    menu.innerHTML = PAGES.map((p) => `<a href="${p.href}" target="sapa-${p.id}" data-page="${p.id}"${p.id === here ? ' aria-current="page"' : ""}><b>${p.title}</b>${p.id === here ? "<em> \u00b7 this page</em>" : ""}<span>${p.sub}</span></a>`).join("")
      + `<div class="navnote">Each page opens in its own tab; an open one is brought forward, not reloaded.</div>`;
    h1.textContent = ""; wrap.append(btn, menu); h1.appendChild(wrap);

    const show = (on) => { menu.hidden = !on; btn.setAttribute("aria-expanded", String(on)); };
    btn.addEventListener("click", () => { show(menu.hidden); if (!menu.hidden) (menu.querySelector("a:not([aria-current])") || menu.querySelector("a")).focus(); });
    document.addEventListener("click", (e) => { if (!wrap.contains(e.target)) show(false); });
    wrap.addEventListener("focusout", (e) => { if (!wrap.contains(e.relatedTarget)) show(false); });
    wrap.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !menu.hidden) { show(false); btn.focus(); }
      if ((e.key === "ArrowDown" || e.key === "ArrowUp") && !menu.hidden) {
        const items = [...menu.querySelectorAll("a")], i = items.indexOf(document.activeElement);
        items[(i + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length].focus(); e.preventDefault();
      }
    });
    menu.addEventListener("click", async (e) => {
      const a = e.target.closest("a[data-page]");
      if (!a || e.ctrlKey || e.metaKey || e.shiftKey || e.button) return;   // a new tab asked for: the browser's way
      e.preventDefault(); show(false);
      if (a.dataset.page === here) return;
      const url = new URL(a.getAttribute("href"), location.href).href, name = "sapa-" + a.dataset.page;
      // Input products open in a tab this one can't reach (opened separately): a second copy would give phones a
      // second pairing code, so it says where the open one is instead
      const elsewhere = a.dataset.page === "inputs" ? await askInputs() : false;
      let w = null;
      try { w = window.open("", name); } catch { w = null; }
      if (!w) { tell(`The browser blocked the new tab: allow pop-ups for this site, or open ${a.querySelector("b").textContent} from its address.`); return; }
      let blank;
      try { blank = w.location.href === "about:blank"; } catch { blank = false; }
      if (blank && elsewhere) { w.close(); tell("Input products is already open in another tab or window of this browser: switch to it there (a second copy would give phones a second pairing code)."); return; }
      if (blank) w.location.replace(url);
      try { w.focus(); } catch { /* the browser decides */ }
    });
  }
  function tell(msg) {
    const t = document.getElementById("toast");
    if (!t) { alert(msg); return; }
    t.textContent = msg; t.hidden = false; clearTimeout(tell.t); tell.t = setTimeout(() => (t.hidden = true), 6000);
  }
  const start = () => { const h1 = document.querySelector("h1[data-nav]"); if (h1) mount(h1); };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
})();
