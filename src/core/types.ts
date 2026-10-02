// Plain JSON Schema shared by request validation and the MCP server.

const SECTION_KINDS = ["decision", "question", "diff", "note"] as const;

export const SectionSchema = {
	type: "object",
	properties: {
		id: {
			type: "string",
			description: "Short id unique within this review, e.g. d1, q1, c1. Letters, digits, '-' or '_' only.",
			pattern: "^[A-Za-z0-9_-]{1,32}$",
		},
		kind: {
			type: "string",
			enum: [...SECTION_KINDS],
			description:
				"decision: a choice you made that the user should confirm. question: something you need answered (give options). diff: code changes, rendered by the tool from git. note: anything else worth reading.",
		},
		title: { type: "string", description: "One line." },
		body: { type: "string", description: "Markdown. Keep it short; the user reads this while talking." },
		options: { type: "array", items: { type: "string" }, description: "question only: answers the user can click." },
		paths: {
			type: "array",
			items: { type: "string" },
			description: "diff only: repo-relative paths. Omit to show every uncommitted change, including untracked files.",
		},
		base: { type: "string", description: "diff only: git ref to diff against. Default HEAD." },
		url: {
			type: "string",
			description: "Live review only: page to open when the reviewer picks this point (absolute, or relative to the review url).",
		},
	},
	required: ["id", "kind", "title"],
	additionalProperties: false,
};

export const ReviewParamsSchema = {
	type: "object" as const,
	properties: {
		title: { type: "string", description: "What is being reviewed, in a few words." },
		url: {
			type: "string",
			description:
				"Live review: open this running app (e.g. http://localhost:5173/dashboard) in a review browser. The user clicks around and talks; " +
				"you get their speech tied to the elements, React components and source files they pointed at, plus screenshots. " +
				"Sections become a checklist of review points in the page toolbar. Omit url for a document review of decisions, questions and diffs.",
		},
		summary: { type: "string", description: "Markdown shown at the top: what you did and what you want feedback on." },
		sections: {
			type: "array",
			items: SectionSchema,
			description: "Required for a document review; optional review points for a live review.",
		},
	},
	required: ["title"],
	additionalProperties: false,
};

export interface Section {
	id: string;
	kind: (typeof SECTION_KINDS)[number];
	title: string;
	body?: string;
	options?: string[];
	paths?: string[];
	base?: string;
	url?: string;
}

export interface ReviewRequest {
	title: string;
	url?: string;
	summary?: string;
	sections?: Section[];
}

/** Check a request from a client that may not validate against the schema. Throws with a readable message. */
export function parseReviewRequest(input: unknown): ReviewRequest {
	const fail = (msg: string): never => {
		throw new Error(`invalid review request: ${msg}`);
	};
	const str = (v: unknown, name: string, optional = true) => {
		if (v === undefined && optional) return undefined;
		if (typeof v !== "string") fail(`${name} must be a string`);
		return v as string;
	};
	const strs = (v: unknown, name: string) => {
		if (v === undefined) return undefined;
		if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) fail(`${name} must be an array of strings`);
		return v as string[];
	};
	if (!input || typeof input !== "object") fail("expected an object");
	const o = input as Record<string, unknown>;
	const req: ReviewRequest = { title: str(o.title, "title", false)!, url: str(o.url, "url"), summary: str(o.summary, "summary") };
	if (o.sections !== undefined) {
		if (!Array.isArray(o.sections)) fail("sections must be an array");
		req.sections = (o.sections as Record<string, unknown>[]).map((s, i) => {
			if (!s || typeof s !== "object") fail(`sections[${i}] must be an object`);
			const id = str(s.id, `sections[${i}].id`, false)!;
			if (!/^[A-Za-z0-9_-]{1,32}$/.test(id)) fail(`sections[${i}].id must match [A-Za-z0-9_-]{1,32}`);
			const kind = str(s.kind, `sections[${i}].kind`, false) as Section["kind"];
			if (!SECTION_KINDS.includes(kind)) fail(`sections[${i}].kind must be one of ${SECTION_KINDS.join(", ")}`);
			return {
				id,
				kind,
				title: str(s.title, `sections[${i}].title`, false)!,
				body: str(s.body, `sections[${i}].body`),
				options: strs(s.options, `sections[${i}].options`),
				paths: strs(s.paths, `sections[${i}].paths`),
				base: str(s.base, `sections[${i}].base`),
				url: str(s.url, `sections[${i}].url`),
			};
		});
	}
	return JSON.parse(JSON.stringify(req)) as ReviewRequest;
}

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
