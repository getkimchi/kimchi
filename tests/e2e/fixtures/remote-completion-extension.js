// Seed a finished remote run without a network worker. Resume must use the
// production persistence and completion flow, scoped to the owning session.
export default function (pi) {
	pi.registerCommand("seed-remote-completion", {
		description: "Seed a remote result awaiting user action",
		handler: async (_args, ctx) => {
			pi.setSessionName("Remote completion origin")
			pi.appendEntry("remote_run:state", {
				id: "saved-remote-run",
				description: "saved remote work",
				remoteSession: {
					workspaceId: "ws-test",
					sessionName: "acp-test",
					wsUrl: "ws://127.0.0.1:1",
					host: "127.0.0.1",
					cwd: "/home/sandbox/acp-test",
				},
				acpSessionId: "remote-test-session",
				remoteOrigin: "plan",
				startedAt: Date.now(),
				status: "completed",
				completionPending: true,
				result: "Remote recovery result: original-session-only",
			})
			ctx.ui.notify("Remote completion saved for this session", "info")
		},
	})
}
