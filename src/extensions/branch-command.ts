import type { ExtensionAPI, ExtensionContext, SessionManager } from "@earendil-works/pi-coding-agent"

const BRANCH_MESSAGE_TYPE = "kimchi-session-branch"
type WritableSessionManager = Pick<SessionManager, "appendSessionInfo">

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
					await branchCtx.sendMessage(
						{
							customType: BRANCH_MESSAGE_TYPE,
							content: `You can resume a branch of this session with -r ${sessionId}`,
							display: true,
						},
						{ triggerTurn: false },
					)
				},
			})
			if (result.cancelled) return
		},
	})
}
