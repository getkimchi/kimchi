import { readFileSync, writeFileSync } from "node:fs"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { join } from "node:path"

export const EXPIRING_ACCESS_TOKEN = "e2e-expiring-access"
export const REPLACEMENT_ACCESS_TOKEN = "e2e-replacement-access"
export const REFRESH_CONTINUED_REPLY = "Refreshed prompt continued."
const HOUR_MS = 3_600_000

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
export async function startFakeOAuthRefreshServer(
	options: { expiresInSeconds?: number; failFirstGrant?: boolean; idToken?: string } = {},
): Promise<FakeOAuthRefreshServer> {
	const { expiresInSeconds = 3600, failFirstGrant = false, idToken } = options
	const grants: RefreshGrant[] = []
	let revoked = false
	let transientFailurePending = failFirstGrant
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
			if (transientFailurePending) {
				transientFailurePending = false
				res.writeHead(500, { "content-type": "application/json" })
				res.end(JSON.stringify({ error: "server_error", error_description: "E2E transient refresh failure" }))
				return
			}
			res.writeHead(200, { "content-type": "application/json" })
			res.end(
				JSON.stringify({
					access_token: REPLACEMENT_ACCESS_TOKEN,
					// Optional ID-token-bearing response: selected-ID-token mode
					// (useIdToken) needs the issuer to return the JWT it will use
					// as the bearer. Raw-access-token consumers omit `idToken` and
					// keep the previous response shape unchanged.
					...(idToken ? { id_token: idToken } : {}),
					refresh_token: "e2e-rotated-refresh",
					expires_in: expiresInSeconds,
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

/** Seed valid fake OAuth credentials before model discovery and session startup. */
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
		expires: Date.now() + 3_600_000,
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

/** Secret-free synthetic JWT (alg "none") with a numeric epoch-seconds exp. */
export function syntheticIdTokenJwt(expiryMs: number): string {
	return `${Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url")}.${Buffer.from(
		JSON.stringify({ exp: Math.floor(expiryMs / 1000) }),
	).toString("base64url")}.e2e-fixture-signature`
}

/** A legacy credential: the stored response-derived schedule (24h) outlives
 * the selected ID-token bearer that was persisted before the shared expiry
 * rule, so the effective expiry is the (expired/near-expiry) JWT exp. */
export function legacyIdTokenCredential(bearerExpiryMs: number, tokenUrl: string): Record<string, unknown> {
	const bearer = syntheticIdTokenJwt(bearerExpiryMs)
	return {
		type: "oauth",
		tokenUrl,
		clientId: "e2e-client",
		access: bearer,
		refresh: "e2e-original-refresh",
		expires: Date.now() + 24 * HOUR_MS,
		useIdToken: true,
		region: "us",
		audience: "https://llm.kimchi.dev",
		orgId: "e2e-org",
		orgName: "E2E Org",
		idToken: bearer,
		accessToken: "e2e-legacy-raw-access",
	}
}

/** Clear the fixture's fake default API key and seed canonical plus concrete
 * legacy ID-token credentials before the process starts, so auth status must
 * resolve and recover OAuth instead of the config short-circuit. */
export function seedLegacyIdTokenCredentials(homeDir: string, tokenUrl: string): string {
	const configDir = join(homeDir, ".config", "kimchi")
	const configPath = join(configDir, "config.json")
	const config = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>
	config.apiKey = ""
	writeFileSync(configPath, JSON.stringify(config, null, "\t"))

	const credential = legacyIdTokenCredential(Date.now() - 10 * 60_000, tokenUrl)
	const authPath = join(configDir, "harness", "auth.json")
	writeFileSync(authPath, JSON.stringify({ "kimchi-dev": credential, "kimchi-dev/openai": credential }), {
		mode: 0o600,
	})
	return authPath
}

/** Enter the refresh window only for the active prompt, without changing the seed grant's identity. */
export function expireSeededOAuthCredential(authPath: string): void {
	const stored = JSON.parse(readFileSync(authPath, "utf8")) as Record<string, { type?: string; expires?: number }>
	const expires = Date.now() + 60_000
	for (const credential of Object.values(stored)) {
		if (credential.type === "oauth") credential.expires = expires
	}
	writeFileSync(authPath, JSON.stringify(stored), { mode: 0o600 })
}

export function chatAuthorization(request: {
	url: string
	headers: Record<string, string | string[] | undefined>
}): string | undefined {
	if (request.url !== "/openai/v1/chat/completions") return undefined
	const authorization = request.headers.authorization
	return Array.isArray(authorization) ? authorization[0] : authorization
}
