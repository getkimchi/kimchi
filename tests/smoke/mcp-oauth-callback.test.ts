import { createServer, type Server } from "node:http"
import { describe, expect, it } from "vitest"
import { spawnInteractive } from "./harness.js"

// Occupy the complete pre-fix fallback range so eager startup fails deterministically.
const LEGACY_CALLBACK_PORT_SCAN_ATTEMPTS = 25

async function closeServers(servers: Server[]): Promise<void> {
	await Promise.all(
		servers
			.filter((server) => server.listening)
			.map(
				(server) =>
					new Promise<void>((resolve, reject) => {
						server.close((error) => (error ? reject(error) : resolve()))
					}),
			),
	)
}

async function reserveCallbackPortRange(): Promise<{ port: number; release: () => Promise<void> }> {
	for (let attempt = 0; attempt < 10; attempt++) {
		const servers: Server[] = []
		try {
			const first = createServer()
			await new Promise<void>((resolve, reject) => {
				first.once("error", reject)
				first.listen(0, "127.0.0.1", resolve)
			})
			servers.push(first)

			const address = first.address()
			if (!address || typeof address === "string" || address.port > 65_535 - (LEGACY_CALLBACK_PORT_SCAN_ATTEMPTS - 1)) {
				await closeServers(servers)
				continue
			}

			for (let offset = 1; offset < LEGACY_CALLBACK_PORT_SCAN_ATTEMPTS; offset++) {
				const server = createServer()
				await new Promise<void>((resolve, reject) => {
					server.once("error", reject)
					server.listen(address.port + offset, "127.0.0.1", resolve)
				})
				servers.push(server)
			}

			return { port: address.port, release: () => closeServers(servers) }
		} catch {
			await closeServers(servers)
		}
	}

	throw new Error("Could not reserve an OAuth callback port range")
}

describe("MCP OAuth callback smoke test", () => {
	it("an idle harness does not initialize the OAuth callback server", { timeout: 20_000 }, async () => {
		const reservation = await reserveCallbackPortRange()
		const session = spawnInteractive({ extraEnv: { MCP_OAUTH_CALLBACK_PORT: String(reservation.port) } })

		try {
			await session.waitFor((output) => output.length > 0, 10_000)
			session.write("\r")
			await session.waitFor((output) => output.includes("ask anything or type / for commands"), 10_000)
			expect(session.output()).not.toContain("MCP OAuth initialization failed")
		} finally {
			await session.kill()
			await reservation.release()
		}
	})
})
