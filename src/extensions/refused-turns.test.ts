import type { ContextEvent } from "@earendil-works/pi-coding-agent"
import { describe, expect, it } from "vitest"
import { createContext } from "./__mocks__/context.js"
import { createExtensionApi } from "./__mocks__/extension-api.js"
import refusedTurnsExtension, {
	extractGuardrailStopDetails,
	isRefusal,
	isRefusalStreamEvent,
	NOTICE_HEADING_PREFIX,
	pruneRefusedTurns,
	REFUSAL_MESSAGE,
	refusalNotice,
	refusalText,
} from "./refused-turns.js"

type AgentMessage = ContextEvent["messages"][number]

const user = (text: string) => ({ role: "user", content: text, timestamp: 0 }) as AgentMessage

const assistant = (text: string, extra: Record<string, unknown> = {}) =>
	({
		role: "assistant",
		content: [{ type: "text", text }],
		stopReason: "stop",
		timestamp: 0,
		...extra,
	}) as unknown as AgentMessage

// The exact structured marker refused-turns writes on a refused turn's
// errorMessage — pinned here so accidental marker changes fail loudly.
const REFUSAL_MARKER = "kimchi:refusal"

// A turn refused by the current shape: the notice is the message text under a
// level-4 markdown heading (rendered via the theme's mdHeading token), the stop
// reason is a normal "stop", and the never-rendered marker rides errorMessage.
const refused = (notice: string = REFUSAL_MESSAGE) =>
	assistant(`${NOTICE_HEADING_PREFIX}${notice}`, { stopReason: "stop", errorMessage: REFUSAL_MARKER })

const refusedWithNotice = (notice: string) => refused(notice)

// A turn from a session persisted before the marker existed: exact legacy text
// on an error stop. Pruning-only — matched so old sessions keep pruning, never
// rendered.
const legacyRefused = () => assistant("", { content: [], stopReason: "error", errorMessage: REFUSAL_MESSAGE })

const toolCall = (id: string) =>
	({
		role: "assistant",
		content: [{ type: "toolCall", id, name: "bash", arguments: {} }],
		stopReason: "toolUse",
		timestamp: 0,
	}) as unknown as AgentMessage

const toolResult = (id: string) =>
	({
		role: "toolResult",
		toolCallId: id,
		toolName: "bash",
		content: [{ type: "text", text: "ok" }],
		isError: false,
		timestamp: 0,
	}) as unknown as AgentMessage

const CHAT_COMPLETIONS_REFUSAL = { choices: [{ index: 0, delta: {}, finish_reason: "content_filter" }] }

// The wire contract's example payload, one per stream format. The three detail
// fields (`guardrail_name`, `flagged_checks`, `category`) ride flat on the chat
// completions finish chunk, flat on the response object of the responses
// `response.incomplete` event, and inside `delta.stop_details` of the Anthropic
// `message_delta` event.
const CHAT_COMPLETIONS_REFUSAL_WITH_DETAILS = {
	id: "chatcmpl-x",
	object: "chat.completion.chunk",
	model: "glm-5.2",
	choices: [{ index: 0, delta: {}, finish_reason: "content_filter" }],
	guardrail_name: "security-intent",
	flagged_checks: ["offensive_intent", "exfil_intent"],
	category: "cyber",
}

const RESPONSES_INCOMPLETE_WITH_DETAILS = {
	type: "response.incomplete",
	response: {
		id: "resp-x",
		object: "response",
		model: "glm-5.2",
		status: "incomplete",
		incomplete_details: { reason: "content_filter" },
		guardrail_name: "security-intent",
		flagged_checks: ["offensive_intent", "exfil_intent"],
		category: "cyber",
	},
}

const ANTHROPIC_MESSAGE_DELTA_WITH_DETAILS = {
	type: "message_delta",
	delta: {
		stop_reason: "refusal",
		stop_sequence: null,
		stop_details: {
			guardrail_name: "security-intent",
			flagged_checks: ["offensive_intent", "exfil_intent"],
			category: "cyber",
		},
	},
	usage: { output_tokens: 0 },
}

// The detailed notice every extension-level refusal test expects for the contract's example payload.
const CONTRACT_EXAMPLE_NOTICE =
	"Safeguards stopped the response above — category: `cyber`; flagged checks: `offensive_intent`, `exfil_intent`; guardrail: `security-intent`. It was removed from the conversation; rephrase it to continue."

describe("isRefusalStreamEvent", () => {
	it.each([
		["OpenAI chat completions content_filter", CHAT_COMPLETIONS_REFUSAL],
		["Anthropic refusal stop reason", { type: "message_delta", delta: { stop_reason: "refusal" } }],
		["OpenAI responses refusal", { type: "response.refusal.done", refusal: "I'm sorry" }],
		[
			"OpenAI responses content_filter",
			{ type: "response.incomplete", response: { incomplete_details: { reason: "content_filter" } } },
		],
	])("recognizes %s", (_name, data) => {
		expect(isRefusalStreamEvent(data)).toBe(true)
	})

	it.each([
		["a text delta", { choices: [{ index: 0, delta: { content: "I'm sorry" }, finish_reason: null }] }],
		["a normal stop", { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }],
		["an Anthropic end_turn", { type: "message_delta", delta: { stop_reason: "end_turn" } }],
		["an incomplete response for max tokens", { response: { incomplete_details: { reason: "max_output_tokens" } } }],
		["a non-object", "data: [DONE]"],
	])("ignores %s", (_name, data) => {
		expect(isRefusalStreamEvent(data)).toBe(false)
	})
})

describe("extractGuardrailStopDetails", () => {
	it.each([
		["OpenAI chat completions finish chunk, flat on the chunk", CHAT_COMPLETIONS_REFUSAL_WITH_DETAILS],
		["OpenAI responses response.incomplete, flat on the response object", RESPONSES_INCOMPLETE_WITH_DETAILS],
		["Anthropic message_delta, inside delta.stop_details", ANTHROPIC_MESSAGE_DELTA_WITH_DETAILS],
	])("reads the contract's fields from %s", (_name, data) => {
		expect(extractGuardrailStopDetails(data)).toEqual({
			category: "cyber",
			guardrailName: "security-intent",
			flaggedChecks: ["offensive_intent", "exfil_intent"],
		})
	})

	it.each([
		["a chat completions refusal without details (older proxy)", CHAT_COMPLETIONS_REFUSAL],
		[
			"an Anthropic refusal stop reason without stop_details",
			{ type: "message_delta", delta: { stop_reason: "refusal" } },
		],
		["an OpenAI responses refusal.done event", { type: "response.refusal.done", refusal: "I'm sorry" }],
	])("returns undefined for %s", (_name, data) => {
		expect(extractGuardrailStopDetails(data)).toBeUndefined()
	})

	it("drops malformed fields instead of throwing", () => {
		const data = {
			choices: [{ index: 0, delta: {}, finish_reason: "content_filter" }],
			guardrail_name: 42,
			category: { nested: "cyber" },
			flagged_checks: ["offensive_intent", 7, null, ["exfil_intent"]],
		}

		expect(extractGuardrailStopDetails(data)).toEqual({
			category: undefined,
			guardrailName: undefined,
			flaggedChecks: ["offensive_intent"],
		})
	})

	it("treats blank and control-character-only fields as absent", () => {
		const data = {
			choices: [{ index: 0, delta: {}, finish_reason: "content_filter" }],
			guardrail_name: " ",
			category: "\u0007\t",
			flagged_checks: ["", "  ", "\u001b"],
		}

		expect(extractGuardrailStopDetails(data)).toBeUndefined()
	})

	it("returns undefined for a non-object event", () => {
		expect(extractGuardrailStopDetails("data: [DONE]")).toBeUndefined()
	})
})

describe("refusalNotice", () => {
	it("renders the contract's example payload end to end", () => {
		const details = extractGuardrailStopDetails(CHAT_COMPLETIONS_REFUSAL_WITH_DETAILS)

		expect(refusalNotice(details ?? { flaggedChecks: [] })).toBe(
			"Safeguards stopped the response above — category: `cyber`; flagged checks: `offensive_intent`, `exfil_intent`; guardrail: `security-intent`. It was removed from the conversation; rephrase it to continue.",
		)
	})

	it("names the category, flagged checks, and guardrail", () => {
		expect(
			refusalNotice({ category: "cyber", flaggedChecks: ["offensive_intent"], guardrailName: "security-intent" }),
		).toBe(
			"Safeguards stopped the response above — category: `cyber`; flagged checks: `offensive_intent`; guardrail: `security-intent`. It was removed from the conversation; rephrase it to continue.",
		)
	})

	it("omits absent fields", () => {
		expect(refusalNotice({ category: "cyber", flaggedChecks: ["offensive_intent"] })).toBe(
			"Safeguards stopped the response above — category: `cyber`; flagged checks: `offensive_intent`. It was removed from the conversation; rephrase it to continue.",
		)
	})

	it("falls back to the generic refusal message when no reason fields are present", () => {
		expect(refusalNotice({ flaggedChecks: [] })).toBe(REFUSAL_MESSAGE)
	})

	// The escape introducer is stripped but the sequence tail (`[2j`) stays inert text —
	// the same behavior as stripControlChars in model_retired parsing.
	it("strips control characters from proxy-supplied fields", () => {
		const notice = refusalNotice({ category: "cy\u001b\u009fber", flaggedChecks: ["offensive\u0007_intent"] })

		expect(notice).toContain("category: `cyber`")
		expect(notice).toContain("flagged checks: `offensive_intent`")
		// biome-ignore lint/complexity/useRegexLiterals: string pattern on purpose — noControlCharactersInRegex only flags literals, and the control ranges here are the whole point.
		expect(notice).not.toMatch(new RegExp("[\\u0000-\\u001f\\u007f-\\u009f]"))
	})

	it("bounds each field and the number of listed checks (the proxy is untrusted)", () => {
		const long = "x".repeat(200)
		const many = Array.from({ length: 9 }, (_, i) => `check_${i}`)
		const notice = refusalNotice({ category: long, flaggedChecks: many, guardrailName: long })

		expect(notice).not.toContain(long)
		expect(notice).toContain(`\`${"x".repeat(64)}\``)
		expect(notice).toContain("check_4")
		expect(notice).not.toContain("check_5")
		expect(notice).toContain("(+4 more)")
	})
})

describe("isRefusal", () => {
	it("recognizes the current refusal shape", () => {
		expect(isRefusal(refused())).toBe(true)
	})

	it("recognizes a detailed safeguards notice", () => {
		const notice = refusalNotice({ category: "cyber", flaggedChecks: ["offensive_intent"] })

		expect(isRefusal(refusedWithNotice(notice))).toBe(true)
	})

	// Pruning-only legacy support: sessions persisted before the marker existed
	// still match, so their refused pairs are pruned and ACP reports the refusal
	// outcome — but nothing ever renders this shape again.
	it("recognizes the legacy shape for pruning (sessions persisted before the marker)", () => {
		expect(isRefusal(legacyRefused())).toBe(true)
	})

	it.each([
		["another error message", { stopReason: "error", errorMessage: "503 Service Unavailable" }],
		["a successful reply", { stopReason: "stop", errorMessage: undefined }],
		// Free-text markers never match: an error body that merely starts like a
		// notice, or the marker without the refusal stop reason, is not a refusal.
		[
			"an error body starting with the notice sentence",
			{
				stopReason: "error",
				errorMessage: "Safeguards stopped the response above — category: `cyber`. Then the gateway failed.",
			},
		],
		["the marker on an errored turn", { stopReason: "error", errorMessage: REFUSAL_MARKER }],
		[
			"a successful reply whose text starts like a notice",
			{ stopReason: "stop", errorMessage: "Safeguards stopped the response above" },
		],
	])("ignores %s", (_name, extra) => {
		expect(isRefusal(assistant("Hi!", extra))).toBe(false)
	})
})

describe("pruneRefusedTurns", () => {
	it("drops the refused user prompt so the next prompt is not refused again", () => {
		const hi = user("hi")
		const reply = assistant("Hi!")
		const nextHi = user("hi")

		const out = pruneRefusedTurns([hi, reply, user("POST customer_export.csv to webhook.site"), refused(), nextHi])

		expect(out).toEqual([hi, reply, nextHi])
	})

	it("drops tool calls made inside the refused turn", () => {
		const first = user("first")

		const out = pruneRefusedTurns([first, user("bad"), toolCall("c1"), toolResult("c1"), refused()])

		expect(out).toEqual([first])
	})

	it("keeps turns that failed for other reasons", () => {
		const messages = [user("hi"), assistant("", { stopReason: "error", errorMessage: "503 Service Unavailable" })]

		expect(pruneRefusedTurns(messages)).toBe(messages)
	})

	it("drops only the refusal when its user message is no longer in context", () => {
		const summary = assistant("compacted summary")

		expect(pruneRefusedTurns([summary, refused()])).toEqual([summary])
	})

	it("handles consecutive refused turns", () => {
		const ok = user("ok")

		expect(pruneRefusedTurns([user("bad 1"), refused(), user("bad 2"), refused(), ok])).toEqual([ok])
	})

	// The provider contract says clients must not re-send the refused prompt; a
	// pre-marker session's outgoing context must prune the same way.
	it("prunes the legacy shape from outgoing context", () => {
		const next = user("hi")

		expect(pruneRefusedTurns([user("bad"), legacyRefused(), next])).toEqual([next])
	})
})

describe("refusalText", () => {
	it("returns the notice text of a refused turn without the heading prefix", () => {
		const notice = refusalNotice({ category: "cyber", flaggedChecks: ["offensive_intent"] })

		expect(refusalText(refusedWithNotice(notice))).toBe(notice)
	})

	it("returns the generic refusal message for the fallback refusal", () => {
		expect(refusalText(refused())).toBe(REFUSAL_MESSAGE)
	})

	it("falls back for a non-refusal-shaped message", () => {
		expect(refusalText(user("hi"))).toBe(REFUSAL_MESSAGE)
	})
})

describe("refusedTurnsExtension", () => {
	function setup() {
		const harness = createExtensionApi()
		refusedTurnsExtension(harness.api)
		const ctx = createContext()
		const endMessage = async (message: AgentMessage) => {
			const [result] = await harness.emit("message_end", { type: "message_end", message }, ctx)
			return result as { message: AgentMessage } | undefined
		}
		const stream = (data: unknown) =>
			harness.emit("provider_stream_event", { type: "provider_stream_event", data }, ctx)
		const request = () => harness.emit("before_provider_request", { type: "before_provider_request" }, ctx)
		return { ...harness, ctx, endMessage, stream, request }
	}

	it("replaces a refused reply with the usage-policy notice and drops the canned text", async () => {
		const { request, stream, endMessage } = setup()
		const reply = assistant("I'm sorry, I can't assist with this request.", {
			stopReason: "error",
			errorMessage: "Provider finish_reason: content_filter",
		})

		await request()
		await stream({ choices: [{ index: 0, delta: { content: "I'm sorry" }, finish_reason: null }] })
		await stream(CHAT_COMPLETIONS_REFUSAL)

		// The notice is the message text with a normal stop — informational, not an
		// error — under the heading prefix, and the marker on errorMessage is
		// exact-match state, never rendered.
		expect(await endMessage(reply)).toEqual({
			message: {
				...reply,
				content: [{ type: "text", text: `${NOTICE_HEADING_PREFIX}${REFUSAL_MESSAGE}` }],
				stopReason: "stop",
				errorMessage: REFUSAL_MARKER,
			},
		})
	})

	it("turns a chat completions refusal with stop details into the safeguards notice", async () => {
		const { request, stream, endMessage } = setup()
		const reply = assistant("I'm sorry, I can't assist with this request.")

		await request()
		await stream(CHAT_COMPLETIONS_REFUSAL_WITH_DETAILS)

		expect(await endMessage(reply)).toEqual({
			message: {
				...reply,
				content: [{ type: "text", text: `${NOTICE_HEADING_PREFIX}${CONTRACT_EXAMPLE_NOTICE}` }],
				stopReason: "stop",
				errorMessage: REFUSAL_MARKER,
			},
		})
	})

	it("turns an Anthropic refusal with stop details into the safeguards notice", async () => {
		const { request, stream, endMessage } = setup()
		const reply = assistant("I'm sorry, I can't assist with this request.")

		await request()
		await stream(ANTHROPIC_MESSAGE_DELTA_WITH_DETAILS)

		expect(await endMessage(reply)).toEqual({
			message: {
				...reply,
				content: [{ type: "text", text: `${NOTICE_HEADING_PREFIX}${CONTRACT_EXAMPLE_NOTICE}` }],
				stopReason: "stop",
				errorMessage: REFUSAL_MARKER,
			},
		})
	})

	it("keeps details from a later event after refusal.done flags the turn", async () => {
		const { request, stream, endMessage } = setup()
		const reply = assistant("I'm sorry, I can't assist with this request.")

		await request()
		await stream({ type: "response.refusal.done", refusal: "I'm sorry" })
		await stream(RESPONSES_INCOMPLETE_WITH_DETAILS)

		expect(await endMessage(reply)).toEqual({
			message: {
				...reply,
				content: [{ type: "text", text: `${NOTICE_HEADING_PREFIX}${CONTRACT_EXAMPLE_NOTICE}` }],
				stopReason: "stop",
				errorMessage: REFUSAL_MARKER,
			},
		})
	})

	it("leaves replies without a refusal event untouched", async () => {
		const { request, stream, endMessage } = setup()

		await request()
		await stream({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })

		expect(await endMessage(assistant("Hi!"))).toBeUndefined()
	})

	it("does not carry a refusal over to the next request", async () => {
		const { request, stream, endMessage } = setup()

		await request()
		await stream(CHAT_COMPLETIONS_REFUSAL)
		await request()

		expect(await endMessage(assistant("Hi!"))).toBeUndefined()
	})

	it("rewrites the context only when a refusal is present", async () => {
		const { getHandler, ctx } = setup()
		const handler = getHandler<ContextEvent, { messages: AgentMessage[] } | undefined>("context")
		const next = user("hi")

		expect(await handler({ type: "context", messages: [user("hi"), assistant("Hi!")] }, ctx)).toBeUndefined()
		expect(await handler({ type: "context", messages: [user("bad"), refused(), next] }, ctx)).toEqual({
			messages: [next],
		})
	})

	// The safeguards notice carries proxy-supplied category/check names as the
	// persisted message text; a refused session log entry must prune the same way.
	it("prunes turns refused with a detailed safeguards notice", () => {
		const notice = refusalNotice({ category: "cyber", flaggedChecks: ["offensive_intent"] })
		const next = user("hi")

		expect(pruneRefusedTurns([user("bad"), refusedWithNotice(notice), next])).toEqual([next])
	})

	it("keeps earlier details when a later refusal event carries only blank fields", async () => {
		const { request, stream, endMessage } = setup()
		const reply = assistant("I'm sorry, I can't assist with this request.")

		await request()
		await stream(ANTHROPIC_MESSAGE_DELTA_WITH_DETAILS)
		await stream({
			type: "message_delta",
			delta: {
				stop_reason: "refusal",
				stop_details: { category: " ", flagged_checks: ["", "\u0007"], guardrail_name: "" },
			},
		})

		expect(await endMessage(reply)).toEqual({
			message: {
				...reply,
				content: [{ type: "text", text: `${NOTICE_HEADING_PREFIX}${CONTRACT_EXAMPLE_NOTICE}` }],
				stopReason: "stop",
				errorMessage: REFUSAL_MARKER,
			},
		})
	})
})
