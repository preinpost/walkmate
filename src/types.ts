import { type Static, Type } from "typebox";

export const SectionSchema = Type.Object({
	id: Type.String({
		description: "Short id unique within this review, e.g. d1, q1, c1. Letters, digits, '-' or '_' only.",
		pattern: "^[A-Za-z0-9_-]{1,32}$",
	}),
	kind: Type.Union([Type.Literal("decision"), Type.Literal("question"), Type.Literal("diff"), Type.Literal("note")], {
		description:
			"decision: a choice you made that the user should confirm. question: something you need answered (give options). diff: code changes, rendered by the tool from git. note: anything else worth reading.",
	}),
	title: Type.String({ description: "One line." }),
	body: Type.Optional(Type.String({ description: "Markdown. Keep it short; the user reads this while talking." })),
	options: Type.Optional(Type.Array(Type.String(), { description: "question only: answers the user can click." })),
	paths: Type.Optional(
		Type.Array(Type.String(), {
			description: "diff only: repo-relative paths. Omit to show every uncommitted change, including untracked files.",
		}),
	),
	base: Type.Optional(Type.String({ description: "diff only: git ref to diff against. Default HEAD." })),
	url: Type.Optional(
		Type.String({ description: "Live review only: page to open when the reviewer picks this point (absolute, or relative to the review url)." }),
	),
});

export const ReviewParams = Type.Object({
	title: Type.String({ description: "What is being reviewed, in a few words." }),
	url: Type.Optional(
		Type.String({
			description:
				"Live review: open this running app (e.g. http://localhost:5173/dashboard) in a review browser. The user clicks around and talks; " +
				"you get their speech tied to the elements, React components and source files they pointed at, plus screenshots. " +
				"Sections become a checklist of review points in the page toolbar. Omit url for a document review of decisions, questions and diffs.",
		}),
	),
	summary: Type.Optional(Type.String({ description: "Markdown shown at the top: what you did and what you want feedback on." })),
	sections: Type.Optional(Type.Array(SectionSchema, { description: "Required for a document review; optional review points for a live review." })),
});

export type Section = Static<typeof SectionSchema>;
export type ReviewRequest = Static<typeof ReviewParams>;

/** Event logged by the page. `t` is seconds since the page loaded; audio clips use the same clock. */
export interface ReviewEvent {
	t: number;
	type: "view" | "hover" | "select" | "click" | "answer" | "comment" | "away" | "back" | "rec-start" | "rec-stop";
	rid?: string;
	line?: string;
	text?: string;
	value?: string;
}

export interface ClipInfo {
	idx: number;
	/** Page-clock second at which the clip started. */
	offset: number;
	mime: string;
	file: string;
}

export interface SubmitPayload {
	events: ReviewEvent[];
	comments: Record<string, string>;
	answers: Record<string, string>;
	general: string;
	duration: number;
}

export interface Word {
	/** Page-clock seconds. */
	start: number;
	end: number;
	text: string;
}

export interface ReviewDetails {
	status: "submitted" | "cancelled" | "timeout";
	title: string;
	dir: string;
	duration?: number;
	utterances?: number;
	comments?: number;
	answers?: number;
	engine?: string;
	mode?: "doc" | "live";
	pins?: number;
	shots?: number;
	replay?: string;
}
