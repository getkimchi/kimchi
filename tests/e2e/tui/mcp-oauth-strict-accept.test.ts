import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { expect, test } from "@microsoft/tui-test"
import { STREAM_TIMEOUT_MS, waitForText } from "./support/assertions.js"
import { BINARY_PATH, runMcpKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"
import { modelReply } from "./support/mcp-model-script.js"

test.use(TUI_TEST_CONFIG)

const execFileAsync = promisify(execFile)

// Regression proof for the pi-mcp OAuth Accept-header patch: spec-strict
// gateways (e.g. agentgateway v1.5.0) answer 406 when the metadata-discovery
// GET or the DCR POST lack "text/event-stream" in Accept. The fixture's
// strictAccept mode emulates that gateway: `kimchi mcp login` only completes
// if the binary (pi's native OAuth client) sends
// "application/json, text/event-stream" on those endpoints. Auth now goes
// through the native CLI (`kimchi mcp login`), which proxies to pi's native
// MCP runtime — which is exactly the client this e2e guards.
test("completes MCP OAuth login against a spec-strict gateway requiring text/event-stream", async ({ terminal }) => {
	await runMcpKimchiSession(
		terminal,
		{
			artifactName: "mcp-oauth-strict-accept",
			mcp: { transport: "oauth", strictAccept: true },
			responses: [modelReply("OAuth login succeeded against the spec-strict gateway.")],
		},
		async (fixture, trace) => {
			const { stdout } = await execFileAsync(BINARY_PATH, ["mcp", "login", "fixture"], {
				env: {
					...process.env,
					// Same isolation as the session launch: temp HOME pins config + agentDir.
					HOME: fixture.homeDir,
					// The OAuth browser driver script intercepts the native `open`/xdg-open.
					...fixture.mcp.env,
					KIMCHI_PERMISSIONS: "yolo",
					KIMCHI_NO_UPDATE_CHECK: "1",
				},
				cwd: fixture.workDir,
				timeout: 60_000,
			})
			expect(stdout).toContain('Signed in to MCP server "fixture"')

			expect(fixture.mcp.hasEvent("oauth_strict_accept_rejected")).toBe(false)
			const serverMetadata = fixture.mcp.hasEvent("oauth_server_metadata_requested", {
				accept: "application/json, text/event-stream",
			})
			expect(serverMetadata).toBe(true)
			const registered = await fixture.mcp.waitForEvent("oauth_client_registered", {
				description: "DCR carried the text/event-stream Accept header",
			})
			expect(registered.accept).toContain("text/event-stream")
			await fixture.mcp.waitForEvent("oauth_token_issued", {
				where: { grantType: "authorization_code", pkceVerified: true },
				description: "authorization-code flow against the spec-strict gateway",
			})
			trace.step("native OAuth login carried application/json, text/event-stream on discovery and DCR")

			terminal.submit("Say that the OAuth login succeeded")
			await waitForText(terminal, "OAuth login succeeded against the spec-strict gateway.", {
				timeoutMs: STREAM_TIMEOUT_MS,
			})
			trace.step("session remained usable through the out-of-band CLI login")
		},
	)
})
