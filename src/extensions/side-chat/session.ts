/**
 * Side chat sub-session: a real AgentSession branched from the main session.
 *
 * The child is seeded with the main session's context at the branch point
 * (the leaf when the side chat started), then runs independently with
 * read-only tools so it can inspect code without racing the main agent's
 * edits. Seeding follows dbachelder/pi-btw (MIT): an in-memory
 * SessionManager pre-filled with the parent's projected messages.
 */

import {
	type AgentSession,
	buildSessionContext,
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionContext,
	getAgentDir,
	SessionManager,
} from "@earendil-works/pi-coding-agent"
import { requireModelRuntime } from "../../shared/model-runtime.js"
import { extractText } from "../agents/prompt/context.js"
import { isAutoRoutedModel } from "../auto-model/constants.js"
import { createAutoModelRoutingExtension } from "../auto-model/index.js"
import { getEffectiveModel } from "../auto-model/state.js"
import type { SideChatRecord } from "./records.js"

export const SIDE_CHAT_TOOLS = ["read", "grep", "find", "ls"]

function sideChatPrompt(fresh: boolean): string {
	return [
		"<side_chat>",
		...(fresh
			? [
					"You are in a fresh side chat the user opened next to their main working session.",
					"You do not see the main session's conversation; another agent is handling that work. Rely on the user's words, the project instructions and the code.",
				]
			: [
					"You are in a side chat the user branched off their main working session.",
					"Messages before the branch point are context only: another agent is still handling that work, so do not continue it on your own.",
				]),
		"Answer the user's side questions, help them think, explore the code, and plan.",
		`Only these tools are available here: ${SIDE_CHAT_TOOLS.join(", ")}. The side chat is read-only; never claim to have changed files.`,
		"Earlier tool calls in the inherited conversation are history, not available capabilities.",
		"</side_chat>",
	].join("\n")
}

export interface SideChatSession {
	session: AgentSession
	/** Count of inherited main-session messages at the head of `session.messages`. */
	contextLength: number
}

/**
 * `appendMessage` is typed for the roles a live session produces; inherited
 * context can also hold `compactionSummary`/`branchSummary` messages, which
 * the session stores and projects back verbatim.
 */
type AppendableMessage = Parameters<SessionManager["appendMessage"]>[0]

export async function createSideSession(
	ctx: ExtensionContext,
	options: {
		branchLeafId: string | null
		fresh: boolean
		thinkingLevel: AgentSession["thinkingLevel"]
		resume?: SideChatRecord
	},
): Promise<SideChatSession> {
	const model = getEffectiveModel(ctx) ?? ctx.model
	if (!model) throw new Error("No model selected.")
	const modelRuntime = requireModelRuntime(ctx.modelRegistry)

	const sessionManager = SessionManager.inMemory(ctx.cwd)
	const inherited = options.fresh
		? []
		: buildSessionContext(ctx.sessionManager.getEntries(), options.branchLeafId).messages
	for (const message of [...inherited, ...(options.resume?.messages ?? [])]) {
		sessionManager.appendMessage(message as AppendableMessage)
	}

	const systemPrompt = ctx.getSystemPrompt()
	const agentDir = getAgentDir()
	const loader = new DefaultResourceLoader({
		cwd: ctx.cwd,
		agentDir,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		systemPromptOverride: () => systemPrompt,
		appendSystemPromptOverride: () => [sideChatPrompt(options.fresh)],
		extensionFactories: isAutoRoutedModel(model) ? [createAutoModelRoutingExtension()] : [],
	})
	await loader.reload()

	const { session } = await createAgentSession({
		cwd: ctx.cwd,
		agentDir,
		sessionManager,
		model,
		modelRuntime,
		resourceLoader: loader,
		tools: SIDE_CHAT_TOOLS,
		thinkingLevel: options.thinkingLevel,
	})
	await session.bindExtensions({})
	session.setActiveToolsByName(SIDE_CHAT_TOOLS)
	return { session, contextLength: inherited.length }
}

export function sideThreadMessages(side: SideChatSession): SideChatRecord["messages"] {
	return side.session.messages.slice(side.contextLength)
}

export function lastAssistantText(session: AgentSession): string {
	for (let i = session.messages.length - 1; i >= 0; i--) {
		const message = session.messages[i]
		if (message.role === "assistant") return extractText(message.content).trim()
	}
	return ""
}
