import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AssistantMessage } from "@earendil-works/pi-ai"
import { type AfterProviderResponseEvent, SessionManager } from "@earendil-works/pi-coding-agent"
import { describe, expect, it } from "vitest"
import { createContext } from "../__mocks__/context.js"
import { createExtensionApi } from "../__mocks__/extension-api.js"
import { createAutoModelRoutingExtension } from "./index.js"
import { beginRoutedEffort, captureRoutedEffort, takeRoutedEffort } from "./routed-effort.js"

function response(effort?: string): AfterProviderResponseEvent {
	return { type: "after_provider_response", status: 200, headers: effort ? { "x-auto-reasoning-effort": effort } : {} }
}

const BETA = { provider: "kimchi-dev", id: "auto-beta" }

function autoMessage(model = "auto"): AssistantMessage {
	return { role: "assistant", provider: "kimchi-dev", model } as unknown as AssistantMessage
}

describe("routed effort attribution", () => {
	it("captures actual supported effort only for the current request", () => {
		const owner = SessionManager.inMemory()
		captureRoutedEffort(response("max"), owner)
		expect(takeRoutedEffort(owner, autoMessage())).toBeUndefined()
		beginRoutedEffort(owner, BETA)
		captureRoutedEffort(response(" HIGH "), owner)
		expect(takeRoutedEffort(owner, autoMessage("auto-beta"))).toBe("high")
		expect(takeRoutedEffort(owner, autoMessage("auto-beta"))).toBeUndefined()
	})

	it("does not treat Auto, malformed values, or missing headers as maximum", () => {
		for (const value of ["auto", "frugal", undefined]) {
			const owner = SessionManager.inMemory()
			beginRoutedEffort(owner, BETA)
			captureRoutedEffort(response(value), owner)
			expect(takeRoutedEffort(owner, autoMessage("auto-beta"))).toBeUndefined()
		}
	})

	it("does not share attribution between different owners with the same session id", () => {
		const first = SessionManager.inMemory()
		const second = SessionManager.inMemory()
		Object.assign(first, { sessionId: "same-id" })
		Object.assign(second, { sessionId: "same-id" })
		beginRoutedEffort(first, BETA)
		beginRoutedEffort(second, BETA)
		captureRoutedEffort(response("xhigh"), first)
		captureRoutedEffort(response("low"), second)
		expect(takeRoutedEffort(first, autoMessage("auto-beta"))).toBe("xhigh")
		expect(takeRoutedEffort(second, autoMessage("auto-beta"))).toBe("low")
	})

	it("attributes the real response and stops only virtual-routed cache warming", async () => {
		const owner = SessionManager.inMemory()
		const ctx = createContext({ sessionManager: owner, model: { provider: "kimchi-dev", id: "auto-beta" } })
		const pi = createExtensionApi()
		createAutoModelRoutingExtension()(pi.api)
		await pi.emit("before_provider_headers", {}, ctx)
		await pi.emit("after_provider_response", response("high"), ctx)
		const message = {
			role: "assistant",
			content: [],
			provider: "kimchi-dev",
			model: "auto-beta",
		} as unknown as AssistantMessage
		await pi.emit("message_end", { message }, ctx)
		expect(message.thinkingLevel).toBe("high")
		expect(await pi.emit("cache_warming_decision", { action: "warm" }, ctx)).toEqual([{ action: "stop" }])

		const directCtx = createContext({ sessionManager: owner, model: { provider: "anthropic", id: "claude-test" } })
		expect(await pi.emit("cache_warming_decision", { action: "warm" }, directCtx)).toEqual([undefined])
	})

	it("persists actual effort before assistant serialization and reload", async () => {
		const dir = mkdtempSync(join(tmpdir(), "routed-effort-persist-"))
		try {
			const owner = SessionManager.create(dir, dir)
			owner.appendMessage({ role: "user", content: "Original request", timestamp: Date.now() })
			const ctx = createContext({
				sessionManager: owner,
				model: { provider: "kimchi-dev", id: "auto-beta" },
				thinkingLevel: "low",
			})
			const pi = createExtensionApi()
			createAutoModelRoutingExtension()(pi.api)
			await pi.emit("before_provider_headers", {}, ctx)
			await pi.emit("after_provider_response", response("high"), ctx)
			const message = {
				...autoMessage("auto-beta"),
				content: [{ type: "text", text: "done" }],
				thinkingLevel: "low",
			} as AssistantMessage
			await pi.emit("message_end", { message }, ctx)
			owner.appendMessage(message)
			await pi.emit("turn_end", { message }, ctx)
			const sessionFile = owner.getSessionFile()
			if (!sessionFile) throw new Error("Session file was not created")
			const diskEntries = readFileSync(sessionFile, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line))
			expect(diskEntries.find((entry) => entry.type === "message" && entry.message.role === "assistant")).toMatchObject(
				{
					message: { thinkingLevel: "high" },
				},
			)
			const reloaded = SessionManager.open(sessionFile)
			expect(
				reloaded.getBranch().find((entry) => entry.type === "message" && entry.message.role === "assistant"),
			).toMatchObject({
				message: { thinkingLevel: "high" },
			})
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})

	it("accepts mixed-case headers only for the matching Auto response", () => {
		const owner = SessionManager.inMemory()
		beginRoutedEffort(owner, BETA)
		captureRoutedEffort(
			{ type: "after_provider_response", status: 200, headers: { "X-Auto-Reasoning-Effort": "high" } },
			owner,
		)
		expect(takeRoutedEffort(owner, autoMessage("another-model"))).toBeUndefined()
		beginRoutedEffort(owner, BETA)
		captureRoutedEffort(
			{
				type: "after_provider_response",
				status: 200,
				headers: new Headers({ "X-Auto-Reasoning-Effort": "high" }) as unknown as AfterProviderResponseEvent["headers"],
			},
			owner,
		)
		expect(takeRoutedEffort(owner, autoMessage("auto-beta"))).toBe("high")

		const concreteOwner = SessionManager.inMemory()
		beginRoutedEffort(concreteOwner, { provider: "anthropic", id: "claude-test" })
		captureRoutedEffort(response("high"), concreteOwner)
		expect(takeRoutedEffort(concreteOwner, autoMessage("auto-beta"))).toBeUndefined()
	})
})
