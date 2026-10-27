import { type Static, Type } from "typebox"

/** The report must read in one screen: verdict cells are one line, findings one or two sentences. */
const cell = (description: string) => Type.String({ minLength: 1, maxLength: 160, description })
const summary = Type.String({ minLength: 1, maxLength: 280, description: "One or two sentences" })

const evidence = Type.String({
	minLength: 1,
	maxLength: 300,
	description:
		"Upstream changelog heading, PR/issue/commit URL, or path:line — required, findings without it are dropped",
})

export const Finding = Type.Object({ summary, evidence })
export type Finding = Static<typeof Finding>

/** What one upstream release step changed. Facts about Pi; cached across runs in the issue state. */
export const Digest = Type.Object({
	from: Type.String(),
	to: Type.String(),
	features: Type.Array(Finding),
	breaking: Type.Array(Finding),
	behaviorChanges: Type.Array(Finding, { description: "Changes that compile clean but alter behaviour" }),
	builtins: Type.Array(Finding, { description: "New built-in commands, tools, settings, defaults" }),
	internalsTouched: Type.Array(Finding, { description: "Changed private internals / dist files of note" }),
	badReleaseNotes: Type.Array(Finding, { description: "Notes that a version was broken or regressed" }),
})
export type Digest = Static<typeof Digest>

export const Impact = Type.Object({
	verdict: Type.Object({
		risk: Type.Union([Type.Literal("low"), Type.Literal("moderate"), Type.Literal("high")]),
		effort: Type.Union([Type.Literal("S"), Type.Literal("M"), Type.Literal("L")]),
		effortWhy: cell("Why this effort, one line"),
		apiBreakage: cell("API breakage, one line"),
		topHazard: cell("The single thing most likely to bite, one line"),
	}),
	breaking: Type.Array(Finding),
	keepDisabled: Type.Array(
		Type.Object({ summary, evidence, how: Type.String({ maxLength: 200, description: "The concrete off-switch" }) }),
	),
	patchRework: Type.Array(
		Type.Object({
			summary,
			evidence,
			patch: Type.String(),
			status: Type.Union([
				Type.Literal("rebase"),
				Type.Literal("relocated"),
				Type.Literal("retire"),
				Type.Literal("upstream-candidate"),
			]),
		}),
	),
	freeWins: Type.Array(Finding),
	testTriage: Type.Array(
		Type.Object({
			test: Type.String(),
			cause: Type.Union([Type.Literal("excluded-patch"), Type.Literal("breaking-change"), Type.Literal("unexplained")]),
			note: Type.String(),
		}),
	),
})
export type Impact = Static<typeof Impact>

/** `analysis.json`: the impact report plus every digest in `(baseline, target]` and which are new. */
export type Analysis = Impact & { digests: Digest[]; newDigests: Digest[] }

export type AnalysisFile = Analysis | { unavailable: true; reason: string }
