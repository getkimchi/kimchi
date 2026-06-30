import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"

const BRANCH_MESSAGE_TYPE = "kimchi-session-branch"
const BRANCH_NAME_MAX_LENGTH = 50

type SessionNameWriter = {
	appendSessionInfo(name: string): string
}

export function formatBranchSessionName(parentName: string | undefined, sessionId: string): string {
	const shortId = sessionId.slice(0, 8)
	const prefix = `Branch ${shortId}`
	const base = parentName?.trim()
	if (!base) return prefix

	const maxBaseLength = BRANCH_NAME_MAX_LENGTH - prefix.length - ": ".length
	const trimmedBase =
		base.length <= maxBaseLength ? base : `${base.slice(0, Math.max(0, maxBaseLength - 3)).trimEnd()}...`
	return `${prefix}: ${trimmedBase}`
}

function appendSessionName(ctx: { sessionManager: unknown }, name: string): void {
	const sessionManager = ctx.sessionManager as Partial<SessionNameWriter>
	if (typeof sessionManager.appendSessionInfo !== "function") {
		throw new Error("Current session manager does not support session naming")
	}
	sessionManager.appendSessionInfo(name)
}

export default function branchCommandExtension(pi: ExtensionAPI): void {
	pi.registerCommand("branch", {
		description: "Branch the current session and print a resume command",
		handler: async (_args, ctx) => {
			await ctx.waitForIdle()

			const leafId = ctx.sessionManager.getLeafId()
			if (!leafId) {
				ctx.ui.notify("Nothing to branch yet", "info")
				return
			}

			const parentName = ctx.sessionManager.getSessionName()
			await ctx.fork(leafId, {
				position: "at",
				withSession: async (branchCtx) => {
					const sessionId = branchCtx.sessionManager.getSessionId()
					appendSessionName(branchCtx, formatBranchSessionName(parentName, sessionId))
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
		},
	})
}
