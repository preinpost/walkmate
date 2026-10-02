// Runs in the review page. Logs what the reviewer looks at, points to, selects and clicks,
// records the microphone in clips, and posts everything back on submit.
// Every event and clip uses one clock: seconds since the page loaded.
(() => {
  const cfg = window.__REVIEW__;
  const t0 = performance.now();
  const now = () => Math.round(performance.now() - t0) / 1000;
  const events = [];
  const log = (type, data = {}) => events.push({ t: now(), type, ...data });
  const ridOf = (el) => el?.closest?.("[data-rid]")?.dataset.rid;
  const $ = (id) => document.getElementById(id);

  const throttle = (fn, ms) => {
    let last = 0, timer;
    return (...args) => {
      const wait = last + ms - Date.now();
      clearTimeout(timer);
      if (wait <= 0) { last = Date.now(); fn(...args); }
      else timer = setTimeout(() => { last = Date.now(); fn(...args); }, wait);
    };
  };
  const debounce = (fn, ms) => {
    let timer;
    return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); };
  };

  // --- What is on screen: the most specific element near the reading line. ---
  let view;
  const checkView = () => {
    const main = document.querySelector("main").getBoundingClientRect();
    const x = main.left + main.width / 2;
    const y = innerHeight * 0.4;
    let rid;
    for (const dy of [0, 40, -40, 120, -120]) {
      rid = ridOf(document.elementFromPoint(x, y + dy));
      if (rid) break;
    }
    if (rid && rid !== view) { view = rid; log("view", { rid }); }
  };
  addEventListener("scroll", throttle(checkView, 200), { passive: true });
  addEventListener("resize", throttle(checkView, 200));
  setInterval(checkView, 1000);
  checkView();

  // --- What the pointer is on, down to a diff line. ---
  let hoverKey = "";
  addEventListener("pointermove", throttle((e) => {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const rid = ridOf(el);
    if (!rid) return;
    const row = el.closest("[data-line]");
    const line = row?.dataset.line;
    const key = `${rid}|${line ?? ""}`;
    if (key === hoverKey) return;
    hoverKey = key;
    const text = row?.querySelector(".code")?.textContent.trim().slice(0, 160);
    log("hover", line ? { rid, line, text } : { rid });
  }, 150), { passive: true });

  // --- Highlighted text. ---
  document.addEventListener("selectionchange", debounce(() => {
    const sel = getSelection();
    const text = sel.toString().trim();
    if (!text) return;
    log("select", { rid: ridOf(sel.anchorNode?.parentElement), text: text.slice(0, 400) });
  }, 500));

  // --- Option answers and clicks. ---
  const answers = {};
  document.addEventListener("click", (e) => {
    const opt = e.target.closest("[data-answer-for]");
    if (opt) {
      const qid = opt.dataset.answerFor;
      const picked = !opt.classList.contains("picked");
      document.querySelectorAll(`[data-answer-for="${CSS.escape(qid)}"]`).forEach((b) => b.classList.remove("picked"));
      if (picked) { opt.classList.add("picked"); answers[qid] = opt.dataset.value; }
      else delete answers[qid];
      log("answer", { rid: qid, value: picked ? opt.dataset.value : "" });
      return;
    }
    if (e.target.closest("button, textarea")) return;
    const rid = ridOf(e.target);
    if (rid) {
      const row = e.target.closest("[data-line]");
      log("click", row ? { rid, line: row.dataset.line } : { rid });
    }
  });

  document.addEventListener("change", (e) => {
    const ta = e.target.closest("[data-comment-for]");
    if (ta) log("comment", { rid: ta.dataset.commentFor, text: ta.value.trim().slice(0, 2000) });
  });

  document.addEventListener("visibilitychange", () => log(document.hidden ? "away" : "back"));

  // --- Microphone. Each start/stop makes one clip, uploaded right away. ---
  const recBtn = $("rec");
  const uploads = [];
  let rec = null, clipIdx = 0, clipStart = 0, meterStop = null;

  const upload = async (blob, idx, offset, mime) => {
    const q = new URLSearchParams({ idx: String(idx), offset: String(offset), mime });
    const res = await fetch(`${cfg.base}/audio?${q}`, { method: "POST", body: blob });
    if (!res.ok) throw new Error(`audio upload failed: ${res.status}`);
  };

  const startMeter = (stream) => {
    const ac = new AudioContext();
    const an = ac.createAnalyser();
    an.fftSize = 512;
    ac.createMediaStreamSource(stream).connect(an);
    const buf = new Uint8Array(an.fftSize);
    const bar = document.querySelector("#level i");
    let raf;
    const tick = () => {
      an.getByteTimeDomainData(buf);
      let peak = 0;
      for (const v of buf) peak = Math.max(peak, Math.abs(v - 128));
      bar.style.width = `${Math.min(100, (peak / 64) * 100)}%`;
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => { cancelAnimationFrame(raf); bar.style.width = "0"; ac.close(); };
  };

  const startRec = async () => {
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch (err) {
      alert(`마이크를 쓸 수 없습니다: ${err.message}\n텍스트 코멘트로도 리뷰할 수 있습니다.`);
      return;
    }
    const mime = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm"].find((m) => MediaRecorder.isTypeSupported(m));
    const r = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    const chunks = [];
    const idx = clipIdx++;
    r.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    r.onstart = () => { clipStart = now(); log("rec-start"); };
    r.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      log("rec-stop");
      const type = r.mimeType || mime || "audio/webm";
      uploads.push(upload(new Blob(chunks, { type }), idx, clipStart, type));
    };
    rec = r;
    meterStop = startMeter(stream);
    r.start(1000);
    recBtn.classList.add("on");
    recBtn.textContent = "■ 정지";
  };

  const stopRec = () => new Promise((resolve) => {
    if (!rec || rec.state === "inactive") return resolve();
    rec.addEventListener("stop", () => resolve(), { once: true });
    rec.stop();
    rec = null;
    recorded += now() - clipStart;
    meterStop?.();
    recBtn.classList.remove("on");
    recBtn.textContent = "● 녹음";
  });

  let recorded = 0;
  const toggleRec = () => (rec ? stopRec() : startRec());
  recBtn.addEventListener("click", toggleRec);
  addEventListener("keydown", (e) => {
    if (e.key !== "r" && e.key !== "R") return;
    if (e.metaKey || e.ctrlKey || e.altKey || e.target.closest("textarea, input")) return;
    e.preventDefault();
    toggleRec();
  });

  // Timer shows total recorded time across clips.
  setInterval(() => {
    const live = rec ? now() - clipStart : 0;
    const s = Math.floor(recorded + live);
    $("timer").textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  }, 250);

  // --- Submit / cancel. ---
  const finish = (title) => {
    $("done-title").textContent = title;
    $("done").hidden = false;
  };
  const lock = (on) => document.querySelectorAll(".controls button").forEach((b) => (b.disabled = on));

  $("submit").addEventListener("click", async () => {
    lock(true);
    $("submit").textContent = "보내는 중…";
    try {
      await stopRec();
      await Promise.all(uploads);
      const comments = {};
      document.querySelectorAll("[data-comment-for]").forEach((ta) => {
        if (ta.value.trim()) comments[ta.dataset.commentFor] = ta.value.trim();
      });
      const body = { events, comments, answers, general: $("general").value.trim(), duration: now() };
      const res = await fetch(`${cfg.base}/submit`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
      finish("제출했습니다");
    } catch (err) {
      alert(`제출하지 못했습니다: ${err.message}`);
      lock(false);
      $("submit").textContent = "제출";
    }
  });

  $("cancel").addEventListener("click", async () => {
    if (!confirm("리뷰를 취소할까요? 에이전트에게 취소했다고 전달됩니다.")) return;
    await stopRec();
    await fetch(`${cfg.base}/cancel`, { method: "POST" }).catch(() => {});
    finish("취소했습니다");
  });
})();
