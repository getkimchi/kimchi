import { readFileSync, writeFileSync } from "node:fs"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { join } from "node:path"

export const EXPIRING_ACCESS_TOKEN = "e2e-expiring-access"
export const REPLACEMENT_ACCESS_TOKEN = "e2e-replacement-access"
export const REFRESH_CONTINUED_REPLY = "Refreshed prompt continued."

export interface RefreshGrant {
	grantType: string
	refreshToken: string
}

export interface FakeOAuthRefreshServer {
	tokenUrl: string
	grants: RefreshGrant[]
	revokeGrants(): void
	close(): Promise<void>
}

/** A loopback-only OAuth token endpoint that rotates fake credentials. It never logs request bodies or headers. */
export async function startFakeOAuthRefreshServer(): Promise<FakeOAuthRefreshServer> {
	const grants: RefreshGrant[] = []
	let revoked = false
	const server: Server = createServer((req, res) => {
		if (req.method !== "POST" || req.url !== "/token") {
			res.writeHead(404).end()
			return
		}
		let body = ""
		req.setEncoding("utf-8")
		req.on("data", (chunk: string) => {
			body += chunk
		})
		req.on("end", () => {
			const params = new URLSearchParams(body)
			grants.push({
				grantType: params.get("grant_type") ?? "",
				refreshToken: params.get("refresh_token") ?? "",
			})
			if (revoked) {
				res.writeHead(400, { "content-type": "application/json" })
				res.end(JSON.stringify({ error: "invalid_grant", error_description: "E2E refresh grant revoked" }))
				return
			}
			res.writeHead(200, { "content-type": "application/json" })
			res.end(
				JSON.stringify({
					access_token: REPLACEMENT_ACCESS_TOKEN,
					refresh_token: "e2e-rotated-refresh",
					expires_in: 3600,
					token_type: "Bearer",
				}),
			)
		})
	})
	await new Promise<void>((resolveListen, rejectListen) => {
		server.once("error", rejectListen)
		server.listen(0, "127.0.0.1", resolveListen)
	})
	const { port } = server.address() as AddressInfo
	return {
		tokenUrl: `http://127.0.0.1:${port}/token`,
		grants,
		revokeGrants: () => {
			revoked = true
		},
		close: () =>
			new Promise<void>((done) => {
				server.closeAllConnections()
				server.close(() => done())
			}),
	}
}

/** Convert the standard isolated fixture from API-key auth to an expiring fake OAuth credential. */
export function seedExpiringOAuthCredential(homeDir: string, tokenUrl: string): string {
	const configDir = join(homeDir, ".config", "kimchi")
	const agentDir = join(configDir, "harness")
	const configPath = join(configDir, "config.json")
	const config = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>
	config.apiKey = ""
	writeFileSync(configPath, JSON.stringify(config, null, "\t"))
	const settingsPath = join(agentDir, "settings.json")
	const settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<string, unknown>
	settings.defaultProvider = "kimchi-dev/openai"
	settings.defaultModel = "basic"
	writeFileSync(settingsPath, JSON.stringify(settings, null, "\t"))

	const credential = {
		type: "oauth",
		access: EXPIRING_ACCESS_TOKEN,
		refresh: "e2e-original-refresh",
		expires: Date.now() + 60_000,
		region: "us",
		tokenUrl,
		clientId: "e2e-client",
		useIdToken: false,
		accessToken: EXPIRING_ACCESS_TOKEN,
	}
	const authPath = join(agentDir, "auth.json")
	writeFileSync(authPath, JSON.stringify({ "kimchi-dev": credential, "kimchi-dev/openai": credential }), {
		mode: 0o600,
	})
	return authPath
}

export function chatAuthorization(request: {
	url: string
	headers: Record<string, string | string[] | undefined>
}): string | undefined {
	if (request.url !== "/openai/v1/chat/completions") return undefined
	const authorization = request.headers.authorization
	return Array.isArray(authorization) ? authorization[0] : authorization
}
