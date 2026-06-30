import type { ExtensionAPI, ExtensionContext, MessageRenderer, SessionManager } from "@earendil-works/pi-coding-agent"
import { Box, Spacer, Text } from "@earendil-works/pi-tui"

type WritableSessionManager = Pick<SessionManager, "appendSessionInfo">
export const BRANCH_RESUME_CUSTOM_TYPE = "kimchi-session-branch"

interface BranchResumeDetails {
	message: string
}

export function branchResumeMessage(sessionId: string): string {
	return `You can resume a branch of this session with -r ${sessionId}`
}

const branchResumeRenderer: MessageRenderer<BranchResumeDetails> = (message, _options, theme) => {
	const details = message.details as BranchResumeDetails | undefined
	if (!details?.message) return undefined

	const box = new Box(1, 1, (text) => theme.fg("accent", text))
	box.addChild(new Text(theme.bold(theme.fg("customMessageLabel", `[${BRANCH_RESUME_CUSTOM_TYPE}]`)), 0, 0))
	box.addChild(new Spacer(1))
	box.addChild(new Text(theme.fg("customMessageText", details.message), 0, 0))
	return box
}

export function branchSessionName(sessionId: string, parentName: string | undefined, requestedName?: string): string {
	const explicitName = requestedName?.trim()
	if (explicitName) return explicitName

	const suffix = parentName?.trim()
	return `Branch ${sessionId.slice(0, 8)}${suffix ? `: ${suffix}` : ""}`
}

function appendBranchName(ctx: { sessionManager: unknown; ui: ExtensionContext["ui"] }, name: string): boolean {
	const appendSessionInfo = (ctx.sessionManager as Partial<WritableSessionManager>).appendSessionInfo
	if (typeof appendSessionInfo !== "function") {
		ctx.ui.notify("Current session manager does not support session naming", "error")
		return false
	}

	try {
		appendSessionInfo.call(ctx.sessionManager, name)
		return true
	} catch (error) {
		ctx.ui.notify(error instanceof Error ? error.message : String(error), "error")
		return false
	}
}

export default function branchCommandExtension(pi: ExtensionAPI): void {
	pi.registerMessageRenderer(BRANCH_RESUME_CUSTOM_TYPE, branchResumeRenderer)

	pi.registerCommand("branch", {
		description: "Branch the current session and print a resume command",
		handler: async (args, ctx) => {
			await ctx.waitForIdle()

			const leafId = ctx.sessionManager.getLeafId()
			if (!leafId) {
				ctx.ui.notify("Nothing to branch yet", "info")
				return
			}

			const parentName = ctx.sessionManager.getSessionName()
			const requestedName = args.trim()
			const result = await ctx.fork(leafId, {
				position: "at",
				withSession: async (branchCtx) => {
					const sessionId = branchCtx.sessionManager.getSessionId()
					if (typeof sessionId !== "string" || !sessionId) {
						branchCtx.ui.notify("Failed to get branch session id", "error")
						return
					}
					if (!appendBranchName(branchCtx, branchSessionName(sessionId, parentName, requestedName))) return
					await branchCtx.sendMessage<BranchResumeDetails>(
						{
							customType: BRANCH_RESUME_CUSTOM_TYPE,
							content: "",
							display: true,
							details: { message: branchResumeMessage(sessionId) },
						},
						{ triggerTurn: false },
					)
				},
			})
			if (result.cancelled) return
		},
	})
}
