import { readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { ClipInfo } from "../types.ts";
import { distFile } from "./assets.ts";
import type { LiveUtterance } from "./report.ts";

/**
 * Write replay.html next to the recording: the rrweb session of each tab, with the microphone
 * clips playing in sync and the transcript as a clickable list. Opens from disk, no server needed.
 */
export async function writeReplay(opts: {
	dir: string;
	title: string;
	t0: number;
	rrweb: { tab: number; file: string }[];
	clips: ClipInfo[];
	utterances: LiveUtterance[];
	/** Original URL → saved copy, so images and fonts load without the dev server. */
	assets?: Record<string, string>;
}): Promise<string | undefined> {
	const tabs: { tab: number; events: unknown[] }[] = [];
	for (const r of opts.rrweb) {
		const text = await readFile(r.file, "utf8").catch(() => "");
		const events = text
			.split("\n")
			.filter(Boolean)
			.flatMap((l) => {
				try {
					return [JSON.parse(l)];
				} catch {
					return [];
				}
			});
		// The replayer needs a full snapshot to start from.
		if (!events.some((e) => e.type === 2)) continue;
		rewriteAssets(events, opts.assets ?? {});
		tabs.push({ tab: r.tab, events });
	}
	if (!tabs.length) return undefined;

	const lib = distFile("rrweb", "rrweb.umd.min.cjs");
	const css = distFile("rrweb", "style.min.css");
	const data = {
		title: opts.title,
		t0: opts.t0,
		tabs,
		clips: opts.clips.map((c) => ({ src: basename(c.file), offset: c.offset })),
		utterances: opts.utterances.map((u) => ({ t: u.start, text: u.text, tab: u.tab })),
	};
	const json = JSON.stringify(data).replace(/</g, "\\u003c");
	const html = `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><title>재생 · ${esc(opts.title)}</title>
<style>${css}
body { margin: 0; font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", sans-serif; background: #111; color: #eee; display: flex; height: 100vh; }
#stage { flex: 1; display: flex; flex-direction: column; min-width: 0; }
#bar { display: flex; gap: 10px; align-items: center; padding: 8px 12px; background: #1c1c1e; }
#bar input[type=range] { flex: 1; }
button, select { font: inherit; background: #333; color: #eee; border: 0; border-radius: 6px; padding: 4px 10px; }
#time { font-variant-numeric: tabular-nums; color: #aaa; }
#view { flex: 1; position: relative; overflow: hidden; }
#player { position: absolute; top: 0; left: 0; transform-origin: 0 0; }
#player iframe { background: #fff; }
#side { width: 360px; overflow: auto; background: #1a1a1a; border-left: 1px solid #333; }
#side h1 { font-size: 14px; padding: 10px 12px; margin: 0; border-bottom: 1px solid #333; }
.u { padding: 8px 12px; border-bottom: 1px solid #262626; cursor: pointer; }
.u:hover { background: #222; } .u.now { background: #23324f; }
.u small { color: #888; display: block; }
</style></head>
<body>
<div id="stage">
  <div id="bar"><button id="play">▶</button><select id="tab"></select><input id="seek" type="range" min="0" value="0"><span id="time">0:00</span></div>
  <div id="view"><div id="player"></div></div>
</div>
<div id="side"><h1>${esc(opts.title)}</h1><div id="utts"></div></div>
<script>window.__DATA__ = ${json};</script>
<script>(function(){var module={exports:{}};var exports=module.exports;${lib}
;window.rrweb=module.exports;})();</script>
<script>
const D = window.__DATA__;
const $ = (id) => document.getElementById(id);
const audios = D.clips.map((c) => Object.assign(new Audio(c.src), { _offset: c.offset }));
// rrweb getCurrentTime() is only meaningful while playing, so track the paused position here.
let replayer, first = 0, playing = false, pos = 0;

D.tabs.forEach((t, i) => $("tab").add(new Option("탭 " + t.tab, i)));
const fit = (w, h) => {
  const v = $("view"), k = Math.min(v.clientWidth / w, v.clientHeight / h, 1);
  $("player").style.transform = "scale(" + k + ")";
};
function load(i) {
  if (replayer) { replayer.pause(); replayer.destroy?.(); $("player").innerHTML = ""; }
  const events = D.tabs[i].events;
  first = events[0].timestamp;
  replayer = new rrweb.Replayer(events, { root: $("player"), mouseTail: { strokeStyle: "#ff3b30" }, showWarning: false, skipInactive: false, UNSAFE_replayCanvas: true });
  replayer.on("resize", (d) => fit(d.width, d.height));
  $("seek").max = replayer.getMetaData().totalTime;
  playing = false; pos = 0; $("play").textContent = "▶";
  replayer.pause(0);
}
// Review clock (seconds since the review started) for the replayer's current position.
const cur = () => (playing ? replayer.getCurrentTime() : pos);
const reviewT = () => (first + cur() - D.t0) / 1000;
function seekReview(t) {
  pos = Math.min(Math.max(0, D.t0 + t * 1000 - first), replayer.getMetaData().totalTime);
  if (playing) replayer.play(pos); else replayer.pause(pos);
  sync(true);
}
function sync(force) {
  const t = reviewT();
  for (const a of audios) {
    const local = t - a._offset;
    const inside = playing && local >= 0 && (!isFinite(a.duration) || local < a.duration);
    if (!inside) { if (!a.paused) a.pause(); continue; }
    if (force || a.paused || Math.abs(a.currentTime - local) > 0.35) a.currentTime = local;
    if (a.paused) a.play().catch(() => {});
  }
  if (playing && cur() >= replayer.getMetaData().totalTime) togglePlay(false);
  $("seek").value = cur();
  const s = Math.max(0, Math.floor(t));
  $("time").textContent = Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
  document.querySelectorAll(".u").forEach((el) => el.classList.toggle("now", t >= +el.dataset.t && t < +el.dataset.t + 4));
}
function togglePlay(on) {
  if (on === playing) return;
  if (!on) pos = replayer.getCurrentTime();
  else if (pos >= replayer.getMetaData().totalTime) pos = 0;
  playing = on;
  $("play").textContent = playing ? "⏸" : "▶";
  if (playing) replayer.play(pos); else replayer.pause(pos);
  sync(true);
}
$("play").onclick = () => togglePlay(!playing);
$("seek").oninput = () => seekReview((first + +$("seek").value - D.t0) / 1000);
$("tab").onchange = () => load(+$("tab").value);
$("utts").innerHTML = D.utterances.map((u) => {
  const m = Math.floor(u.t / 60), s = (u.t % 60).toFixed(1).padStart(4, "0");
  return '<div class="u" data-t="' + u.t + '" data-tab="' + u.tab + '"><small>' + m + ":" + s + "</small>" + u.text.replace(/[&<>]/g, (c) => "&#" + c.charCodeAt(0) + ";") + "</div>";
}).join("") || '<div class="u"><small>발화 없음</small></div>';
$("utts").onclick = (e) => {
  const el = e.target.closest(".u[data-t]");
  if (!el) return;
  const ti = D.tabs.findIndex((t) => t.tab === +el.dataset.tab);
  if (ti >= 0 && ti !== +$("tab").value) { $("tab").value = ti; load(ti); }
  seekReview(Math.max(0, +el.dataset.t - 1));
};
addEventListener("resize", () => { const f = $("player").querySelector("iframe"); if (f) fit(f.width, f.height); });
load(0);
setInterval(() => playing && sync(false), 250);
</script>
</body></html>`;
	const file = join(opts.dir, "replay.html");
	await writeFile(file, html);
	return file;
}

/**
 * Point image, font and CSS url() references in the rrweb events at the copies saved during the
 * review. rrweb records absolute URLs, so a plain lookup is enough.
 */
export function rewriteAssets(events: any[], assets: Record<string, string>): void {
	const map = new Map(Object.entries(assets));
	if (!map.size) return;
	const css = (t: string) => t.replace(/url\((['"]?)([^'")]+)\1\)/g, (m, q, u) => (map.has(u) ? `url(${q}${map.get(u)}${q})` : m));
	const srcset = (v: string) =>
		v
			.split(",")
			.map((part) => {
				const [u, ...rest] = part.trim().split(/\s+/);
				return [map.get(u) ?? u, ...rest].join(" ");
			})
			.join(", ");
	const attrs = (a: Record<string, unknown> | undefined) => {
		if (!a) return;
		for (const k of ["src", "href", "poster", "xlink:href", "data"]) {
			const v = a[k];
			if (typeof v === "string" && map.has(v)) a[k] = map.get(v);
		}
		if (typeof a.srcset === "string") a.srcset = srcset(a.srcset);
		if (typeof a.style === "string") a.style = css(a.style);
		if (typeof a._cssText === "string") a._cssText = css(a._cssText);
	};
	const node = (n: any) => {
		if (!n) return;
		attrs(n.attributes);
		if (n.isStyle && typeof n.textContent === "string") n.textContent = css(n.textContent);
		for (const c of n.childNodes ?? []) node(c);
	};
	for (const e of events) {
		if (e.type === 2) node(e.data?.node);
		else if (e.type === 3 && e.data?.source === 0) {
			for (const a of e.data.adds ?? []) node(a.node);
			for (const a of e.data.attributes ?? []) attrs(a.attributes);
		} else if (e.type === 3 && e.data?.source === 8) {
			for (const r of e.data.adds ?? []) if (typeof r.rule === "string") r.rule = css(r.rule);
		}
	}
}

function esc(s: string): string {
	return s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
}
