// Injected into every page of the review browser before the app's own scripts run.
// Reports what the reviewer points at, clicks, selects, types and scrolls through, and shows a
// small floating toolbar. Everything goes to the recorder through the __piReview CDP binding;
// times are epoch ms so events from every tab share one clock with the microphone.
(() => {
  // A new tab first loads about:blank and then reuses that same window for the real page, so
  // running there would mark the window as done before the page we care about arrives.
  if (window.top !== window || window.__piReviewLoaded || location.href === "about:blank") return;
  window.__piReviewLoaded = true;

  const post = (msg) => {
    try { window.__piReview(JSON.stringify(msg)); } catch {}
  };
  const ev = (type, data = {}) => post({ kind: "ev", at: Date.now(), type, ...data });
  // Toolbar shortcuts use Cmd on macOS and Alt elsewhere.
  const MAC = /mac|iphone|ipad/i.test(navigator.userAgentData?.platform || navigator.platform);
  const MOD = MAC ? "Cmd" : "Alt";
  const modHeld = (e) => (MAC ? e.metaKey : e.altKey);
  const modOnly = (e) => modHeld(e) && !e.ctrlKey && !(MAC ? e.altKey : e.metaKey);
  const throttle = (fn, ms) => {
    let last = 0, timer;
    return (...a) => {
      const wait = last + ms - Date.now();
      clearTimeout(timer);
      if (wait <= 0) { last = Date.now(); fn(...a); }
      else timer = setTimeout(() => { last = Date.now(); fn(...a); }, wait);
    };
  };
  const debounce = (fn, ms) => {
    let timer;
    return (...a) => { clearTimeout(timer); timer = setTimeout(() => fn(...a), ms); };
  };

  // ---------- Describing an element: tag, visible text, React components, source file ----------

  const MEANINGFUL = "a,button,input,select,textarea,label,summary,[role],[data-testid],[aria-label],h1,h2,h3,h4,h5,h6,th,td,li,img,svg,canvas";
  const SKIP_COMP = /^(Provider|Consumer|Context|Fragment|Suspense|StrictMode|Profiler|Anonymous|ForwardRef|Memo|Fn|_c\d*)$/;

  const fiberOf = (el) => {
    for (let n = el; n; n = n.parentElement) {
      const key = Object.keys(n).find((k) => k.startsWith("__reactFiber$"));
      if (key) return n[key];
    }
  };
  const compName = (f) => {
    const t = f.type;
    if (!t || typeof t === "string") return;
    return t.displayName || t.name || t.render?.displayName || t.render?.name || t.type?.displayName || t.type?.name;
  };
  const shortPath = (p) => {
    const i = p.indexOf("/src/");
    return (i >= 0 ? p.slice(i + 1) : p.replace(/^\//, "")).replace(/\?.*$/, "");
  };
  const LIB_PATH = /node_modules|\/\.vite\/|\/@/;
  // Where the JSX for this fiber was written, if that is app code. React 18 dev builds keep
  // _debugSource; React 19 keeps the JSX call stack in _debugStack.
  const appSource = (f) => {
    const s = f._debugSource;
    if (s?.fileName) {
      if (LIB_PATH.test(s.fileName)) return;
      return { file: shortPath(s.fileName) + (s.lineNumber ? `:${s.lineNumber}` : "") };
    }
    const stack = f._debugStack?.stack;
    if (typeof stack !== "string") return;
    for (const m of stack.matchAll(/at (?:([\w$.]+) )?\(?(?:https?:\/\/[^/\s]+)?(\/[^\s():?]+\.(?:[jt]sx?|vue|svelte))(?:\?[^\s:)]*)?:\d+:\d+/g)) {
      if (!LIB_PATH.test(m[2])) return { file: shortPath(m[2]), fn: m[1]?.split(".").pop() };
    }
  };
  // Components written in the app: an element whose JSX lives in app code was created by an app
  // component (its owner). Library wrappers such as Styled(div) or MuiPaperRoot drop out.
  const react = (el) => {
    const host = fiberOf(el);
    if (!host) return {};
    const comps = [];
    let file;
    for (let f = host, i = 0; f && comps.length < 4 && i < 200; f = f.return, i++) {
      const src = appSource(f);
      if (!src) continue;
      file ??= src.file;
      const n = (f._debugOwner && compName(f._debugOwner)) || src.fn;
      if (n && /^[A-Z]/.test(n) && !SKIP_COMP.test(n) && !comps.includes(n)) comps.push(n);
    }
    // Production builds have no debug info: fall back to every named component above.
    if (!comps.length && !file) {
      for (let f = host.return; f && comps.length < 4; f = f.return) {
        const n = compName(f);
        if (n && /^[A-Z]/.test(n) && !SKIP_COMP.test(n) && !comps.includes(n)) comps.push(n);
      }
    }
    return { comps, file };
  };

  const clean = (s) => (s || "").replace(/\s+/g, " ").trim();
  const textOf = (el) => {
    if (/^(EMBED|OBJECT|IFRAME)$/.test(el.tagName)) {
      const src = el.getAttribute("src") || el.getAttribute("data") || "";
      const kind = /pdf/.test(el.getAttribute("type") || "") || document.contentType === "application/pdf" ? "PDF 문서" : el.tagName.toLowerCase();
      const name = src && src !== "about:blank" ? ` ${src.split(/[?#]/)[0].split("/").pop()}` : "";
      return `${el.getAttribute("title") || kind}${name}`.slice(0, 80);
    }
    const a = el.getAttribute?.("aria-label") || el.getAttribute?.("title") || el.getAttribute?.("alt") || el.getAttribute?.("placeholder");
    if (a) return clean(a).slice(0, 80);
    const t = clean(el.innerText ?? el.textContent);
    return t.length > 80 ? `${t.slice(0, 77)}…` : t;
  };
  const tagOf = (el) => {
    let s = el.tagName.toLowerCase();
    const role = el.getAttribute("role");
    if (role) s += `[role=${role}]`;
    const type = /^(EMBED|OBJECT)$/.test(el.tagName) && el.getAttribute("type");
    if (type) s += `[type=${type}]`;
    // Skip hashed class names from CSS modules and CSS-in-JS.
    const cls = [...el.classList].find((c) => c.length < 40 && !/^(css|sc|jsx|emotion)-|_[a-z0-9]{5,}$|^[a-z]{1,3}[A-Z0-9][A-Za-z0-9]{4,}$/.test(c));
    if (cls) s += `.${cls}`;
    return s;
  };
  // A PDF or image tab is not an HTML page: its elements mean nothing, the document does.
  const plainDoc = !/html|xml/.test(document.contentType);
  const docName = () => `${document.contentType === "application/pdf" ? "PDF 문서" : document.contentType} ${decodeURIComponent(location.pathname.split("/").pop() || "")}`.trim();
  const describe = (raw) => {
    let el = raw instanceof Element ? raw : raw?.parentElement;
    if (!el || el === host) return;
    if (plainDoc) return { tag: "document", text: docName(), rect: [0, 0, innerWidth, innerHeight] };
    if (el instanceof SVGElement && !(el instanceof SVGSVGElement)) el = el.closest("[class]") || el;
    let target = el.closest(MEANINGFUL) || el;
    const r0 = target.getBoundingClientRect();
    if (r0.width * r0.height > innerWidth * innerHeight * 0.4) target = el;
    const r = target.getBoundingClientRect();
    const { comps, file } = react(target);
    return {
      tag: tagOf(target),
      text: textOf(target),
      comps: comps?.length ? comps : undefined,
      file,
      testid: target.closest("[data-testid]")?.getAttribute("data-testid") || undefined,
      rect: [r.x, r.y, r.width, r.height].map(Math.round),
    };
  };
  const keyOf = (d) => (d ? `${d.tag}|${d.text}|${d.comps?.[0] ?? ""}` : "");

  // ---------- Activity tracking ----------

  let host; // toolbar host element, excluded from tracking
  const ours = (e) => host && (e.target === host || e.composedPath?.().includes(host));

  let hoverKey = "";
  let lastPtr = { x: 0, y: 0 };
  addEventListener("pointermove", throttle((e) => {
    if (ours(e) || pinMode || drag || draft) return;
    lastPtr = { x: Math.round(e.clientX), y: Math.round(e.clientY) };
    const d = describe(e.target);
    const k = keyOf(d);
    if (!d || k === hoverKey) return;
    hoverKey = k;
    ev("hover", { x: lastPtr.x, y: lastPtr.y, d });
  }, 120), { capture: true, passive: true });
  // Pointer position for screenshot markers; not part of the timeline.
  addEventListener("pointermove", throttle((e) => {
    if (!ours(e)) post({ kind: "ptr", x: Math.round(e.clientX), y: Math.round(e.clientY) });
  }, 400), { capture: true, passive: true });

  addEventListener("click", (e) => {
    if (ours(e) || pinMode || drag || swallowClick) return;
    ev("click", { x: Math.round(e.clientX), y: Math.round(e.clientY), d: describe(e.target) });
  }, true);

  addEventListener("change", (e) => {
    const el = e.target;
    if (ours(e) || !(el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement)) return;
    const secret = window.__piReviewCfg?.maskAllInputs || el.type === "password" || el.type === "hidden" || /pass|secret|token|card/i.test(el.name || "");
    const value = el.type === "checkbox" || el.type === "radio" ? String(el.checked) : secret ? "••••" : clean(el.value).slice(0, 120);
    ev("input", { d: describe(el), value });
  }, true);

  document.addEventListener("selectionchange", debounce(() => {
    const sel = getSelection();
    const text = clean(sel?.toString()).slice(0, 400);
    if (text) ev("select", { text, d: describe(sel.anchorNode) });
  }, 600));

  addEventListener("scroll", debounce(() => {
    const max = document.documentElement.scrollHeight - innerHeight;
    ev("scroll", { y: Math.round(scrollY), pct: max > 0 ? Math.round((scrollY / max) * 100) : 0, d: describe(document.elementFromPoint(innerWidth / 2, innerHeight / 2)) });
  }, 500), { capture: true, passive: true });

  let lastUrl = "";
  const nav = () => {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    clearPinMarks();
    ev("nav", { url: location.href, title: document.title });
  };
  for (const m of ["pushState", "replaceState"]) {
    const orig = history[m];
    history[m] = function (...a) {
      const r = orig.apply(this, a);
      setTimeout(nav, 0);
      return r;
    };
  }
  addEventListener("popstate", nav);
  addEventListener("hashchange", nav);
  document.addEventListener("visibilitychange", () => ev(document.hidden ? "away" : "back"));
  addEventListener("focus", () => post({ kind: "focus" }));

  // ---------- rrweb, for replaying the session later ----------

  const canvasFps = Number(window.__piReviewCfg?.canvasFps ?? 1);
  const startRrweb = () => {
    const rr = window.__piRrweb;
    if (!rr?.record) return;
    let buf = [];
    try {
      rr.record({
        emit: (e) => buf.push(e),
        sampling: { mousemove: 50, scroll: 150, input: "last", canvas: canvasFps || undefined },
        recordCanvas: canvasFps > 0,
        dataURLOptions: { type: "image/webp", quality: 0.6 },
        maskAllInputs: !!window.__piReviewCfg?.maskAllInputs,
        maskInputOptions: { password: true },
        inlineStylesheet: true,
        blockSelector: "[data-pi-review]",
      });
    } catch (err) {
      post({ kind: "log", text: `rrweb: ${err}` });
      return;
    }
    const flush = () => {
      if (!buf.length) return;
      post({ kind: "rr", events: buf });
      buf = [];
    };
    window.__piReviewFlush = flush;
    setInterval(flush, 1000);
    addEventListener("pagehide", flush);
  };

  // ---------- Toolbar ----------

  let state = { rec: false, recMs: 0, recSince: null, points: [], active: null, pins: 0, busy: null };
  let pinMode = false;
  let ui;

  window.__piReviewSet = (s) => {
    state = { ...state, ...s };
    render();
  };
  window.__piReviewLevel = (peak) => {
    if (ui) ui.lvl.style.width = `${Math.min(100, Math.round(peak * 160))}%`;
  };

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", sans-serif; }
    .wrap { position: fixed; bottom: 16px; right: 16px; z-index: 2147483647; display: flex; flex-direction: column; align-items: flex-end; gap: 8px; }
    .wrap.left { right: auto; left: 16px; align-items: flex-start; }
    .bar { display: flex; align-items: center; gap: 6px; padding: 6px; border-radius: 12px; background: rgba(28,28,30,.92);
           color: #f2f2f2; box-shadow: 0 6px 24px rgba(0,0,0,.25); backdrop-filter: blur(8px); }
    button { border: 0; border-radius: 8px; padding: 6px 10px; background: rgba(255,255,255,.1); color: inherit; cursor: pointer; }
    button:hover { background: rgba(255,255,255,.2); }
    button.on { background: #e5484d; }
    button.primary { background: #2f6fed; }
    button.pinning { background: #f5a524; color: #111; }
    button:disabled { opacity: .5; cursor: default; }
    .time { font-variant-numeric: tabular-nums; min-width: 3.2em; color: #bbb; }
    .lvl { width: 40px; height: 5px; border-radius: 3px; background: rgba(255,255,255,.15); overflow: hidden; }
    .lvl i { display: block; height: 100%; width: 0; background: #e5484d; transition: width 90ms; }
    .panel { width: 340px; max-height: 50vh; overflow: auto; padding: 8px; border-radius: 12px; background: rgba(28,28,30,.95); color: #f2f2f2;
                    box-shadow: 0 6px 24px rgba(0,0,0,.25); }
    .pt { display: block; width: 100%; text-align: left; margin: 2px 0; padding: 8px 10px; background: transparent; }
    .pt.active { background: rgba(47,111,237,.45); }
    .pt small { display: block; color: #aaa; margin-top: 2px; white-space: pre-wrap; }
    .pt b { font-weight: 600; }
    input { width: 100%; padding: 8px 10px; border-radius: 8px; border: 1px solid #444; background: #111; color: #eee; outline: none; }
    .hint { color: #aaa; margin: 2px 2px 6px; }
    .hl { position: fixed; pointer-events: none; z-index: 2147483646; border: 3px solid #f5a524; border-radius: 4px;
          background: rgba(245,165,36,.12); display: none; }
    .hl.area { border-style: dashed; background: rgba(245,165,36,.08); }
    .glass { position: fixed; inset: 0; z-index: 2147483644; cursor: crosshair; display: none; }
    .memo { position: fixed; z-index: 2147483647; width: 300px; padding: 8px; border-radius: 10px; background: rgba(28,28,30,.96);
            color: #f2f2f2; box-shadow: 0 6px 24px rgba(0,0,0,.3); }
    .marks { position: absolute; left: 0; top: 0; z-index: 2147483645; pointer-events: none; }
    .mark { position: absolute; border: 2px solid #f5a524; border-radius: 4px; }
    .mark.area { border-style: dashed; }
    .mark b { position: absolute; top: -20px; left: -2px; max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
              padding: 1px 6px; border-radius: 6px; background: #f5a524; color: #111; font-size: 11px; font-weight: 600; }
    .toast { padding: 6px 10px; border-radius: 8px; background: rgba(28,28,30,.92); color: #f2f2f2; display: none; }
    [hidden] { display: none !important; }
  `;

  const mount = () => {
    if (host?.isConnected) return;
    host = document.createElement("pi-review-toolbar");
    host.setAttribute("data-pi-review", "");
    const root = host.attachShadow({ mode: "closed" });
    root.innerHTML = `<style>${CSS}</style>
      <div class="marks"></div>
      <div class="glass"></div>
      <div class="hl"></div>
      <div class="memo" hidden><div class="hint"></div><input placeholder="메모 (비워도 됩니다)"></div>
      <div class="wrap">
        <div class="toast"></div>
        <div class="panel" hidden></div>
        <div class="bar">
          <button class="rec" title="${MOD}+R">● 녹음</button><span class="time">0:00</span><span class="lvl"><i></i></span>
          <button class="pin" title="${MOD}+P. 클릭하면 요소, 드래그하면 영역을 핀으로. ${MOD}+드래그는 언제든 영역 핀">📌 핀</button>
          <button class="pts" hidden>포인트</button>
          <button class="submit primary">제출</button>
          <button class="cancel" title="리뷰 취소">✕</button>
          <button class="side" title="툴바 위치 바꾸기">⇆</button>
        </div>
      </div>`;
    const $ = (s) => root.querySelector(s);
    ui = { root, wrap: $(".wrap"), rec: $(".rec"), time: $(".time"), lvl: $(".lvl i"), pin: $(".pin"), pts: $(".pts"),
           submit: $(".submit"), cancel: $(".cancel"), panel: $(".panel"), hl: $(".hl"), toast: $(".toast"),
           glass: $(".glass"), marks: $(".marks"), memo: $(".memo"), memoHint: $(".memo .hint"), memoInput: $(".memo input") };
    ui.rec.onclick = () => post({ kind: "cmd", cmd: "rec" });
    ui.pin.onclick = () => setPinMode(!pinMode);
    ui.pts.onclick = () => (ui.panel.hidden = !ui.panel.hidden);
    ui.submit.onclick = () => post({ kind: "cmd", cmd: "submit" });
    ui.cancel.onclick = () => { if (confirm("리뷰를 취소할까요? 에이전트에게 취소했다고 전달됩니다.")) post({ kind: "cmd", cmd: "cancel" }); };
    $(".side").onclick = () => ui.wrap.classList.toggle("left");
    ui.panel.onclick = (e) => {
      const b = e.target.closest?.("[data-pt]");
      if (!b) return;
      const p = state.points.find((x) => x.id === b.dataset.pt);
      ev("point", { id: p.id });
      post({ kind: "cmd", cmd: "point", id: p.id });
      if (p.url) location.href = new URL(p.url, location.href).href;
    };
    ui.memoInput.onkeydown = (e) => {
      if (e.isComposing) return;
      if (e.key === "Enter") finishDraft(true);
      else if (e.key === "Escape") finishDraft(false);
    };
    // Typing in our inputs must not trigger the app's keyboard shortcuts.
    for (const type of ["keydown", "keyup", "keypress", "input"]) host.addEventListener(type, (e) => e.stopPropagation());
    bindGlass();
    document.documentElement.appendChild(host);
    render();
  };

  let renderedPoints = "";
  function render() {
    if (!ui) return;
    ui.rec.classList.toggle("on", !!state.rec);
    ui.rec.textContent = state.rec ? "■ 정지" : "● 녹음";
    ui.pin.classList.toggle("pinning", pinMode);
    ui.pin.textContent = state.pins ? `📌 핀 ${state.pins}` : "📌 핀";
    for (const b of [ui.rec, ui.submit, ui.cancel]) b.disabled = !!state.busy;
    ui.submit.textContent = state.busy || "제출";
    ui.pts.hidden = !state.points.length;
    ui.pts.textContent = `포인트 ${state.points.length}`;
    const key = JSON.stringify([state.points, state.active]);
    if (key !== renderedPoints) {
      renderedPoints = key;
      const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
      ui.panel.innerHTML = `<div class="hint">리뷰 포인트 · 누르면 지금 이야기하는 포인트로 표시</div>` +
        state.points.map((p) => `<button class="pt ${p.id === state.active ? "active" : ""}" data-pt="${esc(p.id)}"><b>${esc(p.title)}</b>${p.body ? `<small>${esc(p.body)}</small>` : ""}</button>`).join("");
    }
    if (!state.rec) ui.lvl.style.width = "0";
  }
  setInterval(() => {
    if (!ui) return;
    if (!host.isConnected) document.documentElement.appendChild(host);
    const ms = state.recMs + (state.rec && state.recSince ? Date.now() - state.recSince : 0);
    const s = Math.floor(ms / 1000);
    ui.time.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  }, 250);

  window.__piReviewToast = (text, ms = 2500) => {
    if (!ui) return;
    ui.toast.textContent = text;
    ui.toast.style.display = "block";
    clearTimeout(ui.toastTimer);
    ui.toastTimer = setTimeout(() => (ui.toast.style.display = "none"), ms);
  };

  // ---------- Pins: click an element or drag an area, then type a memo next to it ----------
  // In pin mode (📌 or Cmd/Alt+P) a click pins the element under the pointer and a drag pins an area.
  // Cmd/Alt+drag pins an area at any time. Pins stay outlined on the page until it navigates away.

  const DRAG_MIN = 6;
  let drag = null; // { x0, y0, x1, y1 } while the pointer is down for a pin
  let swallowClick = false;
  let draft = null; // pin waiting for its memo

  const toRect = (d) => [Math.min(d.x0, d.x1), Math.min(d.y0, d.y1), Math.abs(d.x1 - d.x0), Math.abs(d.y1 - d.y0)].map(Math.round);
  const dragged = (d) => Math.hypot(d.x1 - d.x0, d.y1 - d.y0) >= DRAG_MIN;
  const showBox = (r, area) => {
    ui.hl.classList.toggle("area", !!area);
    Object.assign(ui.hl.style, { display: "block", left: `${r[0] - 3}px`, top: `${r[1] - 3}px`, width: `${r[2] + 6}px`, height: `${r[3] + 6}px` });
  };
  const hideBox = () => (ui.hl.style.display = "none");

  // While pinning, a transparent glass covers the page so clicks and drags over a PDF viewer, a
  // cross-origin iframe or a canvas reach us instead of the frame underneath.
  const setGlass = (on) => {
    if (ui) ui.glass.style.display = on ? "block" : "none";
  };
  // The element under a point, looking through the glass.
  const under = (x, y) => {
    if (!ui) return document.elementFromPoint(x, y);
    const prev = ui.glass.style.pointerEvents;
    ui.glass.style.pointerEvents = "none";
    const el = document.elementFromPoint(x, y);
    ui.glass.style.pointerEvents = prev;
    return el === host ? null : el;
  };

  // Lets tests (and the extension) start pin mode where keys go to a plugin, like a PDF viewer.
  window.__piReviewPin = (on = true) => setPinMode(!!on);

  function setPinMode(on) {
    pinMode = on;
    setGlass(on || !!drag);
    document.documentElement.style.cursor = on ? "crosshair" : "";
    if (!on && !draft && !drag) hideBox();
    render();
  }

  // Text of every text node that shows inside the rectangle.
  const textIn = (root, [x, y, w, h]) => {
    const out = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    let len = 0;
    for (let n = walker.nextNode(), i = 0; n && i < 3000 && len < 300; n = walker.nextNode(), i++) {
      const t = clean(n.textContent);
      if (!t) continue;
      range.selectNodeContents(n);
      const hit = [...range.getClientRects()].some((r) => r.right > x && r.left < x + w && r.bottom > y && r.top < y + h);
      if (hit) { out.push(t); len += t.length + 1; }
    }
    const s = out.join(" ");
    return s.length > 300 ? `${s.slice(0, 297)}…` : s;
  };

  // An area: the smallest element holding everything in it, what is inside, and the visible text.
  const describeArea = (r) => {
    const [x, y, w, h] = r;
    const els = [];
    for (const fx of [0.1, 0.5, 0.9]) for (const fy of [0.1, 0.5, 0.9]) {
      const el = under(x + w * fx, y + h * fy);
      if (el) els.push(el);
    }
    let common = els[0];
    while (common && !els.every((el) => common.contains(el))) common = common.parentElement;
    const base = (plainDoc ? describe(document.body) : describe(common || els[0])) || { tag: "?", text: "", rect: r };
    if (plainDoc) return { ...base, rect: r, area: true, inside: [] };
    const inside = [];
    const seen = new Set([keyOf(base)]);
    for (const el of els) {
      const d = describe(el);
      const k = keyOf(d);
      if (!d || seen.has(k)) continue;
      seen.add(k);
      inside.push({ tag: d.tag, text: d.text, comps: d.comps, file: d.file });
    }
    return { ...base, rect: r, area: true, inside: inside.slice(0, 6), areaText: textIn(common || document.body, r) };
  };

  function draftPin(d, at, area, x, y) {
    draft = { id: `p${at}`, d, at, area, x: Math.round(x), y: Math.round(y) };
    showBox(d.rect, area);
    // Put the memo right under the pin, or above it when there is no room.
    const [rx, ry, rw, rh] = d.rect;
    const mw = 300, mh = 76;
    let top = ry + rh + 10;
    if (top + mh > innerHeight - 8) top = Math.max(8, ry - mh - 10);
    Object.assign(ui.memo.style, { left: `${Math.min(Math.max(8, rx), innerWidth - mw - 8)}px`, top: `${top}px` });
    ui.memoHint.textContent = `📌 ${state.pins + 1} · ${area ? "영역" : (d.comps?.[0] ?? d.tag)} · Enter 저장 · Esc 취소`;
    ui.memoInput.value = "";
    ui.memo.hidden = false;
    ui.memoInput.focus();
  }

  function finishDraft(save) {
    const p = draft;
    if (!p) return;
    draft = null;
    ui.memo.hidden = true;
    hideBox();
    if (!save) return;
    const text = clean(ui.memoInput.value).slice(0, 500) || undefined;
    addMark(state.pins + 1, p.d.rect, p.area, text);
    // Timestamped when the pin was drawn, not when the memo was saved: that is when they were talking about it.
    ev("pin", { at: p.at, id: p.id, x: p.x, y: p.y, d: p.d, area: p.area || undefined, text });
  }

  function addMark(n, r, area, text) {
    const m = document.createElement("div");
    m.className = area ? "mark area" : "mark";
    Object.assign(m.style, { left: `${r[0] + scrollX}px`, top: `${r[1] + scrollY}px`, width: `${r[2]}px`, height: `${r[3]}px` });
    const label = document.createElement("b");
    label.textContent = text ? `${n} ${text}` : String(n);
    m.appendChild(label);
    ui.marks.appendChild(m);
  }
  function clearPinMarks() {
    if (ui) ui.marks.textContent = "";
  }

  function gestureDown(e) {
    e.preventDefault();
    e.stopImmediatePropagation();
    drag = { x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY };
    setGlass(true);
  }
  function gestureMove(e) {
    if (drag) {
      drag.x1 = e.clientX;
      drag.y1 = e.clientY;
      if (dragged(drag)) showBox(toRect(drag), true);
    } else if (pinMode && !draft) {
      const d = describe(under(e.clientX, e.clientY));
      if (d) showBox(d.rect);
    }
  }
  function gestureUp(e) {
    if (!drag) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const d = drag;
    drag = null;
    // The click that follows belongs to the pin, not to the app.
    swallowClick = true;
    setTimeout(() => (swallowClick = false), 0);
    setPinMode(false);
    if (dragged(d)) draftPin(describeArea(toRect(d)), Date.now(), true, d.x1, d.y1);
    else {
      const desc = describe(under(d.x1, d.y1));
      // Inside a PDF there is no element to outline, so mark the spot that was clicked.
      if (desc && plainDoc) desc.rect = [Math.round(d.x1 - 24), Math.round(d.y1 - 24), 48, 48];
      if (desc) draftPin(desc, Date.now(), false, d.x1, d.y1);
    }
  }

  // Cmd/Alt+drag on the page itself; in pin mode the glass receives everything.
  addEventListener("pointerdown", (e) => {
    if (ours(e) || e.button !== 0) return;
    // Clicking elsewhere keeps the pin being written, like leaving a comment box.
    if (draft) finishDraft(true);
    if (pinMode || modHeld(e)) gestureDown(e);
  }, true);
  addEventListener("pointermove", (e) => {
    if (!ours(e)) gestureMove(e);
  }, { capture: true, passive: true });
  addEventListener("pointerup", (e) => {
    if (!ours(e)) gestureUp(e);
  }, true);
  const onGlass = (type, fn) => ui.glass.addEventListener(type, fn);
  const bindGlass = () => {
    onGlass("pointerdown", (e) => {
      if (e.button !== 0) return;
      if (draft) finishDraft(true);
      gestureDown(e);
    });
    onGlass("pointermove", gestureMove);
    onGlass("pointerup", gestureUp);
  };
  for (const type of ["mousedown", "mouseup", "click", "dblclick"]) {
    addEventListener(type, (e) => {
      if (ours(e) || !(drag || swallowClick || pinMode)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
    }, true);
  }
  addEventListener("dragstart", (e) => {
    if (drag || pinMode) e.preventDefault();
  }, true);

  addEventListener("keydown", (e) => {
    if (modOnly(e) && e.code === "KeyR") { e.preventDefault(); post({ kind: "cmd", cmd: "rec" }); }
    else if (modOnly(e) && e.code === "KeyP") { e.preventDefault(); setPinMode(!pinMode); }
    else if (e.key === "Escape" && draft) finishDraft(false);
    else if (e.key === "Escape" && pinMode) setPinMode(false);
  }, true);

  const ready = () => {
    mount();
    nav();
    startRrweb();
    post({ kind: "hello", url: location.href, dpr: devicePixelRatio, contentType: document.contentType });
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", ready, { once: true });
  else ready();
})();
