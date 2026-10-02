import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { collectDiff } from "../core/diff.ts";
import { type ReviewOutcome, runAnyReview } from "../core/review.ts";
import { type ReviewDetails, ReviewParamsSchema, type ReviewRequest, type Section } from "../core/types.ts";
import { Type } from "typebox";

const ReviewParams = Type.Unsafe<ReviewRequest>(ReviewParamsSchema);
const WIDGET = "review-recorder";

type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

export default function reviewRecorder(pi: ExtensionAPI) {
	const active = new Set<{ close(): void }>();
	const track = (resource: { close(): void }) => {
		active.add(resource);
		return () => active.delete(resource);
	};

	pi.on("session_shutdown", () => {
		for (const resource of active) resource.close();
		active.clear();
	});

	const review = async (ctx: ExtensionContext, req: ReviewRequest, signal?: AbortSignal, onStatus?: (s: string) => void) => {
		const openaiKey = await ctx.modelRegistry.getApiKeyForProvider("openai").catch(() => undefined);
		try {
			return await runAnyReview(req, {
				cwd: ctx.cwd,
				group: ctx.sessionManager.getSessionId(),
				openaiKey,
				signal,
				onStatus,
				track,
				onWaiting: ({ url, title, live }) => {
					if (!ctx.hasUI) return;
					ctx.ui.setWidget(
						WIDGET,
						live
							? [
									`🎙 라이브 리뷰 중 · ${title}`,
									`   ${url}`,
									"   리뷰 창 오른쪽 아래 툴바: ● 녹음(Alt+R) · 📌 핀(Alt+P) · 제출. 창을 닫아도 제출됩니다. Esc로 중단.",
								]
							: [`🎙 리뷰 대기 중 · ${title}`, `   ${url}`, "   브라우저에서 제출하거나 취소하세요. Esc로 중단합니다."],
					);
				},
			});
		} finally {
			if (ctx.hasUI) ctx.ui.setWidget(WIDGET, undefined);
		}
	};

	pi.registerTool({
		name: "request_review",
		label: "Review",
		description:
			"Get the user's spoken feedback on your work, tied to exactly what they were looking at. Two modes:\n" +
			"- Live (pass url): opens the running app in a review browser. The user clicks through it and talks, pinning elements they mean. " +
			"You get each utterance with the page, element, React component chain and source file they pointed at, plus annotated screenshots. " +
			"Sections become a checklist of review points (give each a url to jump to a page).\n" +
			"- Document (no url): a page of sections. decision (a choice to confirm), question (needs an answer; give options), " +
			"diff (code changes, fetched from git by the tool), note. You get speech, comments and answers tied to the section, diff hunk or line.\n" +
			"Blocks until the user submits or cancels.",
		promptSnippet: "Show work to the user (live in the running app, or as a review page) and get their spoken feedback",
		promptGuidelines: [
			"For UI work, use request_review with the running app's url so the user can review it live; list what to check as short sections.",
			"For decisions, open questions or diffs, use request_review without url instead of a long text summary. One decision or question per section; put code changes in diff sections.",
			"After request_review returns, act on the feedback; quote the timestamp when something the user said is ambiguous.",
		],
		parameters: ReviewParams,
		executionMode: "sequential",

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			if (!ctx.hasUI) throw new Error("request_review needs an interactive session: a person has to review and submit.");
			const result = await review(ctx, params, signal, (status) =>
				onUpdate?.({ content: [{ type: "text", text: status }], details: { status: "submitted", title: params.title, dir: "" } }),
			);
			return { content: toContent(result), details: result.details };
		},

		renderCall(args, theme) {
			const n = Array.isArray(args.sections) ? args.sections.length : 0;
			const what = args.url ? `${args.url} · 포인트 ${n}` : `섹션 ${n}`;
			return new Text(theme.fg("toolTitle", theme.bold("request_review ")) + theme.fg("muted", `${args.title ?? ""} · ${what}`), 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme) {
			const first = result.content[0];
			const text = first?.type === "text" ? first.text : "";
			if (isPartial) return new Text(theme.fg("dim", text), 0, 0);
			const d = result.details as ReviewDetails | undefined;
			if (!d || d.status !== "submitted") return new Text(theme.fg("warning", text), 0, 0);
			return new Text(expanded ? `${summaryLine(d, theme)}\n\n${text}` : summaryLine(d, theme), 0, 0);
		},
	});

	pi.registerCommand("review", {
		description:
			"/review <url> [title]: review the running app live in a browser. /review [title]: review the current changes and the agent's last reply. Feedback goes to the agent.",
		handler: async (args, ctx) => {
			const req = await buildCommandRequest(args.trim(), ctx);
			if (!req) {
				ctx.ui.notify("리뷰할 내용이 없습니다: 변경 사항도, 에이전트 응답도 없습니다. 앱을 보려면 /review <url>", "warning");
				return;
			}
			try {
				const result = await review(ctx, req);
				if (result.details.status !== "submitted") {
					ctx.ui.notify(result.text, "info");
					return;
				}
				const content = toContent(result);
				pi.sendUserMessage(content.length === 1 ? result.text : content, ctx.isIdle() ? undefined : { deliverAs: "followUp" });
			} catch (err) {
				ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
			}
		},
	});
}

function toContent(result: ReviewOutcome): Content[] {
	const content: Content[] = [{ type: "text", text: result.text }];
	for (const img of result.images ?? []) {
		content.push({ type: "text", text: `🖼 #${img.n} ${img.caption}` });
		content.push({ type: "image", data: img.data, mimeType: "image/jpeg" });
	}
	return content;
}

function summaryLine(d: ReviewDetails, theme: { fg(color: any, s: string): string }): string {
	const stats =
		d.mode === "live"
			? `발화 ${d.utterances} · 핀 ${d.pins} · 스크린샷 ${d.shots} · ${d.replay ?? d.dir}`
			: `발화 ${d.utterances} · 코멘트 ${d.comments} · 답 ${d.answers} · ${d.dir}`;
	return theme.fg("success", "✓ 리뷰 받음 ") + theme.fg("muted", stats);
}

const URL_LIKE = /^(https?:\/\/\S+|localhost(:\d+)?(\/\S*)?|127\.0\.0\.1(:\d+)?(\/\S*)?|\S+\.\S+:\d+(\/\S*)?)$/;

/** For /review: a live review when given a url; otherwise the last assistant reply as a note, plus every uncommitted change. */
async function buildCommandRequest(args: string, ctx: ExtensionContext): Promise<ReviewRequest | undefined> {
	const [head, ...rest] = args.split(/\s+/);
	if (head && URL_LIKE.test(head)) return { title: rest.join(" ") || head, url: head };
	const title = args;
	const sections: Section[] = [];
	const reply = lastAssistantText(ctx);
	if (reply) sections.push({ id: "reply", kind: "note", title: "에이전트의 마지막 응답", body: reply.slice(0, 12_000) });

	const changes = await collectDiff(ctx.cwd, undefined).catch(() => []);
	if (changes.length) sections.push({ id: "changes", kind: "diff", title: "변경 사항" });

	if (!sections.length) return undefined;
	return { title: title || "현재 작업", sections };
}

function lastAssistantText(ctx: ExtensionContext): string | undefined {
	const branch = ctx.sessionManager.getBranch();
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		const text = entry.message.content
			.flatMap((c) => (c.type === "text" ? [c.text] : []))
			.join("\n")
			.trim();
		if (text) return text;
	}
	return undefined;
}
