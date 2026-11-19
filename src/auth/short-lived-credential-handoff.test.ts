import type { OAuthCredentials } from "@earendil-works/pi-ai/oauth"
import { beforeEach, describe, expect, it, vi } from "vitest"
import {
	rememberPreparedOAuthCredential,
	resetPreparedOAuthCredentialsForTests,
	shouldReusePreparedOAuthCredential,
} from "./short-lived-credential-handoff.js"

const authPath = "/tmp/kimchi-prepared-handoff/auth.json"
const otherAuthPath = "/tmp/kimchi-other-store/auth.json"
const credential = { access: "replacement-access", refresh: "rotated-refresh", expires: Date.now() + 60_000 }

beforeEach(() => {
	resetPreparedOAuthCredentialsForTests()
})

describe("short-lived OAuth credential handoff", () => {
	it("preserves an unsynchronized replacement across canonical recovery and consumes it once ready", () => {
		rememberPreparedOAuthCredential(authPath, credential, { fanoutPending: true })
		expect(shouldReusePreparedOAuthCredential(authPath, credential)).toBe(true)
		expect(shouldReusePreparedOAuthCredential(authPath, credential)).toBe(true)

		rememberPreparedOAuthCredential(authPath, credential, { fanoutPending: false })
		expect(shouldReusePreparedOAuthCredential(authPath, credential)).toBe(true)
		expect(shouldReusePreparedOAuthCredential(authPath, credential)).toBe(false)
	})

	it("never reuses a different or retired grant", () => {
		rememberPreparedOAuthCredential(authPath, credential, { fanoutPending: false })
		expect(shouldReusePreparedOAuthCredential(authPath, { ...credential, refresh: "original-refresh" })).toBe(false)
		expect(shouldReusePreparedOAuthCredential(otherAuthPath, credential)).toBe(false)
		expect(shouldReusePreparedOAuthCredential(authPath, credential)).toBe(true)
	})

	it("allows a margin-expired replacement for its immediate auth use, then refreshes normally", () => {
		const now = Date.now()
		vi.useFakeTimers()
		try {
			vi.setSystemTime(now)
			rememberPreparedOAuthCredential(authPath, credential, { fanoutPending: false })
			vi.setSystemTime(credential.expires)
			expect(shouldReusePreparedOAuthCredential(authPath, credential)).toBe(true)
			expect(shouldReusePreparedOAuthCredential(authPath, credential)).toBe(false)
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
		rememberPreparedOAuthCredential(authPath, stored, { fanoutPending: false })
		expect(shouldReusePreparedOAuthCredential(authPath, stored)).toBe(true)
	})
})
