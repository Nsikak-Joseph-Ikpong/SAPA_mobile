// The page switcher: each page's title opens a menu of the pages (the cheese variance check, Scan and check here,
// and the linked Input products and bag scanner). A page opens in the same tab, like any web page: the scans on
// Scan and check here and Input products are kept for the tab and come back when you return (inputs.html). Only a
// page with a live link (Input products with phones connected, the bag scanner linked to a laptop) opens the other
// page in a new tab instead, so the link stays up.
(function () {
  "use strict";
  const PAGES = [
    { id: "checker", href: "./", title: "Cheese variance check", sub: "Production orders, the cheese balance, stock trace" },
    { id: "investigate", href: "investigate.html", title: "Variance investigator", sub: "Type a job: its variance, where it came from and the other jobs it touched, over 1 or 2 weeks" },
    { id: "stocktake", href: "stocktake.html", title: "Stock take", sub: "Search a product, scan its labels as you walk the racks, and set each label's quantity against SAP" },
    { id: "here", href: "inputs.html?here", title: "Scan and check here", sub: "Book the job, scan bags and check them against SAP, all on this phone or laptop" },
    { id: "inputs", href: "inputs.html", title: "Input products (linked)", sub: "The laptop dashboard a phone sends its scans to" },
    { id: "scanner", href: "scanner.html", title: "Bag scanner (linked)", sub: "For the phone: pair it from Input products" },
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
    window.name = "sapa-" + here;   // links that name this page's tab (target="sapa-checker") reuse it
    const style = document.createElement("style"); style.textContent = CSS; document.head.appendChild(style);
    const wrap = document.createElement("span"); wrap.className = "navsw";
    const btn = document.createElement("button");
    btn.type = "button"; btn.setAttribute("aria-expanded", "false"); btn.setAttribute("aria-haspopup", "true"); btn.title = "Switch page";
    btn.innerHTML = `<span></span><svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M3.5 6l4.5 4.5L12.5 6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    btn.firstChild.textContent = h1.textContent;
    const menu = document.createElement("nav"); menu.className = "navmenu"; menu.hidden = true; menu.setAttribute("aria-label", "Pages");
    menu.innerHTML = PAGES.map((p) => `<a href="${p.href}" data-page="${p.id}"${p.id === here ? ' aria-current="page"' : ""}><b>${p.title}</b>${p.id === here ? "<em> \u00b7 this page</em>" : ""}<span>${p.sub}</span></a>`).join("");
    h1.textContent = ""; wrap.append(btn, menu); h1.appendChild(wrap);

    const show = (on) => { menu.hidden = !on; btn.setAttribute("aria-expanded", String(on)); };
    // opened from the keyboard (a click with no pointer): focus goes into the menu
    btn.addEventListener("click", (e) => { show(menu.hidden); if (!menu.hidden && e.detail === 0) (menu.querySelector("a:not([aria-current])") || menu.querySelector("a")).focus(); });
    document.addEventListener("click", (e) => { if (!wrap.contains(e.target)) show(false); });
    // A tap on a phone doesn't give the link focus, so focus leaving the menu with nowhere to go (a tap) must not
    // close it: the menu would be gone before the tap's click reached the link. Focus moving to something else
    // (the keyboard) does.
    wrap.addEventListener("focusout", (e) => { if (e.relatedTarget && !wrap.contains(e.relatedTarget)) show(false); });
    wrap.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !menu.hidden) { show(false); btn.focus(); }
      if ((e.key === "ArrowDown" || e.key === "ArrowUp") && !menu.hidden) {
        const items = [...menu.querySelectorAll("a")], i = items.indexOf(document.activeElement);
        items[(i + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length].focus(); e.preventDefault();
      }
    });
    menu.addEventListener("click", (e) => {
      const a = e.target.closest("a[data-page]");
      if (!a || e.ctrlKey || e.metaKey || e.shiftKey || e.button) return;   // a new tab asked for: the browser's way
      e.preventDefault(); show(false);
      const page = a.dataset.page;
      if (page === here) return;
      const url = new URL(a.getAttribute("href"), location.href).href;
      // this page has a live link that leaving would cut: the other page in a new tab (opened right in the tap,
      // which phones require)
      if (typeof window.sapaLive === "function" && window.sapaLive()) {
        if (!window.open(url, "_blank")) tell(`Leaving this page would cut its link, and the browser blocked a new tab. Allow pop-ups for this site, or open ${a.querySelector("b").textContent} from its address in another tab.`);
        return;
      }
      // the linked Input products already open in another tab: a second copy would give phones a second pairing
      // code, so it says where the open one is instead
      if (page === "inputs") {
        askInputs().then((open) => (open ? tell("Input products (linked) is already open in another tab or window of this browser: switch to it there (a second copy would give phones a second pairing code).") : location.assign(url)));
        return;
      }
      location.assign(url);
    });
  }
  function tell(msg) {
    const t = document.getElementById("toast");
    if (!t) { alert(msg); return; }
    t.textContent = msg; t.hidden = false; clearTimeout(tell.t); tell.t = setTimeout(() => (t.hidden = true), 6000);
  }
  const start = () => { const h1 = document.querySelector("h1[data-nav]"); if (h1 && window.top === window) mount(h1); };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
})();
