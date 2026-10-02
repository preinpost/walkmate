// Internal DOM helpers for the Walkmate runtime. No user-provided JavaScript is evaluated.
(() => {
  if (window.__walkmateRuntime?.document === document) return;
  const prefix = Math.random().toString(36).slice(2, 10);
  const refs = new Map(), ids = new WeakMap();
  let seq = 0;
  const clean = (s) => (s || "").replace(/\s+/g, " ").trim();
  const ours = (el) => !!el.closest?.("[data-pi-review]");
  const visible = (el) => {
    const r = el.getBoundingClientRect(), style = getComputedStyle(el);
    return !ours(el) && r.width > 0 && r.height > 0 && style.display !== "none" && style.visibility !== "hidden";
  };
  const role = (el) => el.getAttribute("role") || ({ BUTTON: "button", A: "link", SELECT: "combobox", TEXTAREA: "textbox" })[el.tagName] ||
    (el.tagName === "INPUT" ? ({ checkbox: "checkbox", radio: "radio", button: "button", submit: "button" })[el.type] || "textbox" : "");
  const name = (el) => clean(el.getAttribute("aria-label") ||
    el.getAttribute("aria-labelledby")?.split(/\s+/).map((id) => document.getElementById(id)?.textContent || "").join(" ") ||
    (el.labels && [...el.labels].map((label) => label.textContent).join(" ")) ||
    el.getAttribute("placeholder") || el.innerText || el.getAttribute("title"));
  const disabled = (el) => !!el.disabled || el.getAttribute("aria-disabled") === "true" || !!el.closest("[inert]");
  const ref = (el) => {
    if (!ids.has(el)) { const id = `${prefix}:e${++seq}`; ids.set(el, id); refs.set(id, el); }
    return ids.get(el);
  };
  const matches = (target) => {
    let root = document;
    if (target.scope) {
      const scopes = document.querySelectorAll(target.scope);
      if (scopes.length !== 1) throw new Error("scope must match exactly one container.");
      root = scopes[0];
    }
    let elements;
    if (target.kind === "ref") {
      const el = refs.get(target.value);
      if (!el?.isConnected) throw new Error("Stale element ref. Observe again and choose a current ref.");
      elements = root.contains(el) ? [el] : [];
    } else if (target.kind === "testid") elements = [...root.querySelectorAll("[data-testid]")].filter((el) => el.getAttribute("data-testid") === target.value);
    else if (target.kind === "css") elements = [...root.querySelectorAll(target.value)];
    else elements = [...root.querySelectorAll("button,a,input,select,textarea,[role]")].filter((el) => role(el) === target.value &&
      (target.name === undefined || name(el) === target.name));
    return elements.filter((el) => !ours(el));
  };
  const one = (target) => {
    const elements = matches(target);
    if (elements.length !== 1) throw new Error(`Target matches ${elements.length} elements; choose a unique ref or scope.`);
    return elements[0];
  };
  const describe = (el) => ({
    ref: ref(el), tag: el.tagName.toLowerCase(), role: role(el), name: name(el).slice(0, 160),
    testid: el.getAttribute("data-testid") || undefined, disabled: disabled(el),
    checked: typeof el.checked === "boolean" ? el.checked : undefined,
  });
  window.__walkmateRuntime = {
    document,
    observe() {
      for (const [id, el] of refs) if (!el.isConnected) refs.delete(id);
      const elements = [...document.querySelectorAll("button,a,input,select,textarea,summary,[role],[contenteditable=true]")].filter(visible);
      // Exclude the recorder's toolbar and scripts from page text. Never include input values.
      const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
      const text = [];
      let node, size = 0;
      while ((node = walker.nextNode()) && size < 8000) {
        const parent = node.parentElement;
        if (!parent || ours(parent) || parent.closest("script,style,noscript,textarea,input") || !visible(parent)) continue;
        const value = clean(node.textContent);
        if (value) { text.push(value); size += value.length; }
      }
      return { url: location.href, title: document.title, text: text.join("\n").slice(0, 8000), elements: elements.slice(0, 200).map(describe) };
    },
    condition(target, condition, expected) {
      if (condition === "url") return location.href.includes(expected);
      const elements = matches(target);
      if (elements.length > 1) throw new Error("Condition target is ambiguous; choose a unique ref or scope.");
      if (condition === "hidden") return !elements.length || !visible(elements[0]);
      if (!elements.length || !visible(elements[0])) return false;
      return condition === "visible" || clean(elements[0].innerText || elements[0].textContent).includes(expected);
    },
    prepare(target, action) {
      const el = one(target);
      if (disabled(el) || el.readOnly) throw new Error("Target is disabled or read-only.");
      el.scrollIntoView({ block: "center", inline: "center" });
      if (!visible(el)) throw new Error("Target is not visible.");
      const r = el.getBoundingClientRect(), x = r.x + r.width / 2, y = r.y + r.height / 2;
      const hit = document.elementFromPoint(x, y);
      if (!hit || (hit !== el && !el.contains(hit))) throw new Error("Target is covered by another element.");
      if (action === "fill") {
        if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) ||
          (el instanceof HTMLInputElement && !["text", "email", "password", "search", "tel", "url", "number"].includes(el.type))) {
          throw new Error("fill supports text-like input and textarea elements only.");
        }
        el.focus();
        el.select();
      } else if (action === "press") el.focus();
      else if (action === "check" && !(el instanceof HTMLInputElement && ["checkbox", "radio"].includes(el.type))) throw new Error("check requires a checkbox or radio input.");
      return { x, y, checked: el.checked };
    },
    blur(target) { one(target).blur(); },
    select(target, value) {
      const el = one(target);
      if (!(el instanceof HTMLSelectElement)) throw new Error("select requires a native select element.");
      if (![...el.options].some((option) => option.value === value && !option.disabled)) throw new Error("No enabled option matches the requested value.");
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set;
      setter.call(el, value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    },
    checked(target) { return one(target).checked; },
  };
})();
