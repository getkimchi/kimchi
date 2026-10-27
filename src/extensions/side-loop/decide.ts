/**
 * Whether a candidate card is worth showing and how loudly. d3 answers both
 * questions in one batched call; rules answer when d3 is unavailable, off, or
 * unsure. See docs/side-loop.md — "Decisions (d3)".
 */
import { resolveGatewayCredentials } from "../../auth/gateway-credentials.js"
import { loadConfig } from "../../config.js"
import { type ChoiceQuestion, type DecisionGateOptions, decide, systemoneEndpoint } from "../memory/decision-gate.js"
import type { Signal } from "./signals.js"
import type { SideLoopStats } from "./stats.js"
import type { SurfaceVerdict } from "./surface.js"

export const SIDE_LOOP_DECISION_TAG = "side-loop:decision"
export const DECISION_ENV = "KIMCHI_SIDE_LOOP_DECISION"
const MIN_CONFIDENCE = 0.6
const PROMPT_LIMIT = 600

export interface Candidate {
	signal: Signal
	/** The user's latest prompt, truncated; the only conversation text sent. */
	prompt: string
	/** The card's current data model (never file contents). */
	data: Record<string, unknown>
}

export type Admission = { keep: false; verdict: SurfaceVerdict } | { keep: true; verdict: SurfaceVerdict }

const QUESTIONS: Record<string, ChoiceQuestion> = {
	relevance: {
		type: "choice",
		instructions:
			"A coding agent produced state.candidate while working on state.user_request. Is it something the user would want a link to now, or an internal step of the work?",
		criteria: {
			deliverable:
				"An outcome the user asked for or will review: a pull request, a report, a generated document or page.",
			working_file: "Scratch, logs, intermediate or temporary output the agent used along the way.",
		},
	},
	attention: {
		type: "choice",
		instructions:
			"Given state.candidate and its state.candidate.data, should the user be interrupted now, or is a quiet badge enough?",
		criteria: {
			interrupt: "Something failed or needs the user's action: failed CI, changes requested, a blocking error.",
			badge: "Informational: created, pending, passing, or a file that is ready.",
		},
	},
}

export function ruleAdmission(candidate: Candidate): Admission {
	const { signal, data } = candidate
	const failing = data.tone === "error" || data.review === "CHANGES_REQUESTED"
	const attention = failing ? "interrupt" : "badge"
	if (signal.kind !== "artifact") return { keep: true, verdict: { source: "rule", attention } }
	// Sniffed paths from command output are the noisy ones; drop temp locations.
	const scratch = /(?:^|\/)(?:tmp|temp|\.cache|node_modules)\//.test(signal.path) || /\.log$/.test(signal.path)
	return { keep: !scratch, verdict: { source: "rule", attention } }
}

export function decisionGateFromConfig(): DecisionGateOptions | undefined {
	if (process.env[DECISION_ENV] === "0") return undefined
	try {
		const config = loadConfig()
		const credentials = resolveGatewayCredentials(config)
		if (credentials.source === "none") return undefined
		return {
			endpoint: systemoneEndpoint(config.llmEndpoint),
			apiKey: credentials.token,
			organizationId: credentials.organizationId,
			timeoutMs: 4000,
			maxRetries: 0,
			tag: SIDE_LOOP_DECISION_TAG,
		}
	} catch {
		return undefined
	}
}

function describe(signal: Signal): Record<string, unknown> {
	switch (signal.kind) {
		case "pr":
			return { kind: "pull_request", url: signal.pr.url, number: signal.pr.number }
		case "artifact":
			return { kind: "file", name: signal.name, path: signal.path, how: signal.origin }
		case "message":
			return { kind: "chat_message", service: signal.service, channel: signal.channel, direction: signal.direction }
		default:
			return { kind: signal.kind, command: signal.command, ok: signal.ok }
	}
}

export async function admit(
	candidate: Candidate,
	gate: DecisionGateOptions | undefined,
	stats: SideLoopStats,
): Promise<Admission> {
	const fallback = () => {
		stats.decisions.ruleFallbacks++
		return ruleAdmission(candidate)
	}
	if (!gate) return fallback()
	const state = JSON.stringify({
		user_request: candidate.prompt.slice(0, PROMPT_LIMIT),
		candidate: { ...describe(candidate.signal), data: candidate.data },
	})
	const started = performance.now()
	stats.decisions.calls++
	try {
		const response = await decide(gate, state, QUESTIONS)
		stats.decisions.inputTokens += response.usage.input_tokens
		const relevance = response.answers.relevance
		const attention = response.answers.attention
		if (Math.min(relevance.confidence, attention.confidence) < MIN_CONFIDENCE) return fallback()
		// Only files can be scratch; a PR, test run or deploy happened either way.
		const keep = candidate.signal.kind !== "artifact" || relevance.choice === "deliverable"
		return {
			keep,
			verdict: {
				source: "d3",
				attention: attention.choice === "interrupt" ? "interrupt" : "badge",
				confidence: Math.min(relevance.confidence, attention.confidence),
			},
		}
	} catch {
		stats.decisions.failures++
		return fallback()
	} finally {
		stats.decisions.totalMs += performance.now() - started
	}
}
