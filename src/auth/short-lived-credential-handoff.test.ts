import type { OAuthCredentials } from "@earendil-works/pi-ai/oauth"
import { beforeEach, describe, expect, it, vi } from "vitest"
import {
	releasePreparedOAuthCredential,
	rememberPreparedOAuthCredential,
	resetPreparedOAuthCredentialsForTests,
	shouldReusePreparedOAuthCredential,
} from "./short-lived-credential-handoff.js"

const authPath = "/tmp/kimchi-prepared-handoff/auth.json"
const otherAuthPath = "/tmp/kimchi-other-store/auth.json"
const credential = { access: "replacement-access", refresh: "rotated-refresh", expires: Date.now() + 60_000 }
const sessionOwner: object = {}

beforeEach(() => {
	resetPreparedOAuthCredentialsForTests()
})

describe("short-lived OAuth credential handoff", () => {
	it("keeps same-store prompt handoffs independent for concurrent sessions", () => {
		const sessionA: object = {}
		const sessionB: object = {}
		rememberPreparedOAuthCredential(authPath, credential, sessionA)
		rememberPreparedOAuthCredential(authPath, credential, sessionB)

		for (const owner of [sessionA, sessionB]) {
			expect(shouldReusePreparedOAuthCredential(authPath, credential, owner)).toBe(true)
			expect(shouldReusePreparedOAuthCredential(authPath, credential, owner)).toBe(true)
		}
		releasePreparedOAuthCredential(authPath, sessionA)
		expect(shouldReusePreparedOAuthCredential(authPath, credential, sessionA)).toBe(false)
		expect(shouldReusePreparedOAuthCredential(authPath, credential, sessionB)).toBe(true)
		releasePreparedOAuthCredential(authPath, sessionB)
		expect(shouldReusePreparedOAuthCredential(authPath, credential, sessionB)).toBe(false)
	})

	it("reuses the exact replacement until the originating prompt is released", () => {
		rememberPreparedOAuthCredential(authPath, credential, sessionOwner)
		expect(shouldReusePreparedOAuthCredential(authPath, credential, sessionOwner)).toBe(true)
		expect(shouldReusePreparedOAuthCredential(authPath, credential, sessionOwner)).toBe(true)

		releasePreparedOAuthCredential(authPath, sessionOwner)

		expect(shouldReusePreparedOAuthCredential(authPath, credential, sessionOwner)).toBe(false)
	})

	it("never reuses a different or retired grant", () => {
		rememberPreparedOAuthCredential(authPath, credential, sessionOwner)
		expect(
			shouldReusePreparedOAuthCredential(authPath, { ...credential, refresh: "original-refresh" }, sessionOwner),
		).toBe(false)
		expect(shouldReusePreparedOAuthCredential(otherAuthPath, credential, sessionOwner)).toBe(false)
		expect(shouldReusePreparedOAuthCredential(authPath, credential, sessionOwner)).toBe(true)
	})

	it("allows a margin-expired replacement for its prompt until explicit release", () => {
		const now = Date.now()
		vi.useFakeTimers()
		try {
			vi.setSystemTime(now)
			rememberPreparedOAuthCredential(authPath, credential, sessionOwner)
			vi.setSystemTime(credential.expires)
			expect(shouldReusePreparedOAuthCredential(authPath, credential, sessionOwner)).toBe(true)
			releasePreparedOAuthCredential(authPath, sessionOwner)
			expect(shouldReusePreparedOAuthCredential(authPath, credential, sessionOwner)).toBe(false)
		} finally {
			vi.useRealTimers()
		}
	})

	it("accepts the credential shape used by real ModelRuntime callbacks", () => {
		const stored: OAuthCredentials = {
			...credential,
			type: "oauth",
			clientId: "fake-client",
			tokenUrl: "http://127.0.0.1/token",
			accessToken: credential.access,
		}
		rememberPreparedOAuthCredential(authPath, stored, sessionOwner)
		expect(shouldReusePreparedOAuthCredential(authPath, stored, sessionOwner)).toBe(true)
	})
})
