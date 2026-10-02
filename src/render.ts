import { readFileSync } from "node:fs";
import { marked } from "marked";
import { collectDiff, type DiffFile } from "./diff.ts";
import type { ReviewRequest, Section } from "./types.ts";

const KIND_LABEL: Record<Section["kind"], string> = {
	decision: "결정",
	question: "질문",
	diff: "변경",
	note: "메모",
};

const pageCss = readFileSync(new URL("./page/style.css", import.meta.url), "utf8");
const recorderJs = readFileSync(new URL("./page/recorder.js", import.meta.url), "utf8");

export interface Rendered {
	html: string;
	/** Human-readable name for every data-rid on the page, used in the timeline. */
	labels: Record<string, string>;
}

/** Fetch the diffs for every diff section. A failure is shown on the page instead of failing the review. */
export async function loadDiffs(req: ReviewRequest, cwd: string): Promise<Map<string, DiffFile[] | Error>> {
	const diffs = new Map<string, DiffFile[] | Error>();
	for (const s of req.sections ?? []) {
		if (s.kind !== "diff") continue;
		try {
			diffs.set(s.id, await collectDiff(cwd, s.paths, s.base));
		} catch (err) {
			diffs.set(s.id, err instanceof Error ? err : new Error(String(err)));
		}
	}
	return diffs;
}

export function renderPage(
	req: ReviewRequest,
	diffs: Map<string, DiffFile[] | Error>,
	opts: { base: string; nonce: string },
): Rendered {
	const labels: Record<string, string> = {};
	const parts: string[] = [];

	if (req.summary) {
		labels.summary = "요약";
		parts.push(`<section class="card summary" data-rid="summary"><div class="md">${md(req.summary)}</div></section>`);
	}

	const seen = new Set<string>();
	for (const s of req.sections ?? []) {
		if (seen.has(s.id)) throw new Error(`duplicate section id: ${s.id}`);
		seen.add(s.id);
		labels[s.id] = `${KIND_LABEL[s.kind]} · ${s.title}`;

		const body: string[] = [];
		if (s.body) body.push(`<div class="md">${md(s.body)}</div>`);
		if (s.kind === "question" && s.options?.length) {
			const buttons = s.options
				.map((o) => `<button type="button" class="opt" data-answer-for="${esc(s.id)}" data-value="${esc(o)}">${esc(o)}</button>`)
				.join("");
			body.push(`<div class="opts">${buttons}</div>`);
		}
		if (s.kind === "diff") body.push(renderDiff(s.id, diffs.get(s.id), labels));
		body.push(`<textarea data-comment-for="${esc(s.id)}" rows="2" placeholder="코멘트 (선택)"></textarea>`);

		parts.push(
			`<section class="card kind-${s.kind}" data-rid="${esc(s.id)}">` +
				`<h2><span class="tag">${KIND_LABEL[s.kind]}</span><span class="sid">${esc(s.id)}</span>${esc(s.title)}</h2>` +
				body.join("") +
				"</section>",
		);
	}

	const config = JSON.stringify({ base: opts.base }).replace(/</g, "\\u003c");
	const html = `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>리뷰 · ${esc(req.title)}</title>
<style>${pageCss}</style>
</head>
<body>
<header class="bar">
  <div class="title">${esc(req.title)}</div>
  <div class="controls">
    <button type="button" id="rec" title="R">● 녹음</button>
    <span id="timer">0:00</span>
    <span id="level"><i></i></span>
    <button type="button" id="submit">제출</button>
    <button type="button" id="cancel" class="ghost">취소</button>
  </div>
</header>
<main>
${parts.join("\n")}
<section class="card general">
  <h2>전체 코멘트</h2>
  <textarea id="general" rows="3" placeholder="섹션에 속하지 않는 의견 (선택)"></textarea>
</section>
<p class="hint">녹음하면서 읽고, 가리키고, 선택하며 말하세요. 무엇을 보고 있었는지가 말과 함께 기록됩니다.</p>
</main>
<div id="done" hidden><div><h1 id="done-title">제출했습니다</h1><p>이 탭은 닫아도 됩니다.</p></div></div>
<script nonce="${opts.nonce}">window.__REVIEW__ = ${config};</script>
<script nonce="${opts.nonce}">${recorderJs}</script>
</body>
</html>`;
	return { html, labels };
}

function renderDiff(sid: string, diff: DiffFile[] | Error | undefined, labels: Record<string, string>): string {
	if (diff instanceof Error) return `<div class="diff-error">diff를 가져오지 못했습니다: ${esc(diff.message)}</div>`;
	if (!diff?.length) return `<div class="diff-empty">변경 사항 없음</div>`;

	return diff
		.map((f) => {
			if (f.binary || !f.hunks.length) {
				const rid = `${sid}:${f.path}`;
				labels[rid] = `${f.path}${f.binary ? " (바이너리)" : ""}`;
				return `<div class="file" data-rid="${esc(rid)}"><div class="path">${esc(f.path)}</div><div class="diff-empty">${f.binary ? "바이너리 파일" : "내용 변경 없음"}</div></div>`;
			}
			const hunks = f.hunks
				.map((h, i) => {
					const rid = `${sid}:${f.path}#h${i + 1}`;
					labels[rid] = h.newEnd > h.newStart ? `${f.path} L${h.newStart}-${h.newEnd}` : `${f.path} L${h.newStart}`;
					const rows = h.lines
						.map((l) => {
							const cls = l.kind === "+" ? "add" : l.kind === "-" ? "del" : "ctx";
							const line = l.kind === "-" ? `-${l.oldNo}` : l.kind === "+" ? `+${l.newNo}` : `${l.newNo}`;
							return `<tr class="${cls}" data-line="${line}"><td class="no">${l.oldNo ?? ""}</td><td class="no">${l.newNo ?? ""}</td><td class="code">${esc(l.text)}</td></tr>`;
						})
						.join("");
					return `<div class="hunk" data-rid="${esc(rid)}"><div class="hh">${esc(h.header)}</div><table>${rows}</table></div>`;
				})
				.join("");
			const more = f.truncated ? `<div class="diff-empty">… 일부 생략됨</div>` : "";
			return `<div class="file"><div class="path">${esc(f.path)}</div>${hunks}${more}</div>`;
		})
		.join("");
}

function md(src: string): string {
	return marked.parse(src, { async: false, gfm: true });
}

function esc(s: string): string {
	return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
