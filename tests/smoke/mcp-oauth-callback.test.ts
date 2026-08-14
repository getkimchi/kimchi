import { createServer } from "node:http"
import { describe, it } from "vitest"
import { spawnInteractive } from "./harness.js"

async function getFreePort(): Promise<number> {
	const server = createServer()
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
	const address = server.address()
	await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
	if (!address || typeof address === "string") throw new Error("Could not allocate a local test port")
	return address.port
}

async function expectPortCanBind(port: number): Promise<void> {
	const server = createServer()
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject)
		server.listen(port, "127.0.0.1", resolve)
	})
	await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
}

describe("MCP OAuth callback smoke test", () => {
	it("an idle harness leaves the callback port available to another process", { timeout: 20_000 }, async () => {
		const port = await getFreePort()
		const session = spawnInteractive({ extraEnv: { MCP_OAUTH_CALLBACK_PORT: String(port) } })

		try {
			await session.waitFor((output) => output.length > 0, 10_000)
			session.write("\r")
			await session.waitFor((output) => output.includes("ask anything or type / for commands"), 10_000)
			await expectPortCanBind(port)
		} finally {
			await session.kill()
		}
	})
})
