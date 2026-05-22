import type { AgentSession, AgentSessionEvent, AgentSessionEventListener } from "@earendil-works/pi-coding-agent"
import { describe, expect, it, vi } from "vitest"
import type { RemoteAgentSession } from "./agent-session.js"
import { IllegalStateError, TeleportableAgentSession, type TransportChangedEvent } from "./teleportable-session.js"

// Minimal fake AgentSession: subscribe + emit + a couple of sentinel methods/getters
// the passthrough tests need. Cast at the test seam via asSession()/asRemote().
class FakeAgentSession {
	readonly sessionId: string
	readonly tag: string
	private listeners = new Set<AgentSessionEventListener>()
	subscribeCallCount = 0
	unsubscribeCallCount = 0
	disposed = false
	// Configurable sentinels for passthrough verification
	messages: unknown[] = []
	model: unknown = undefined
	systemPrompt = ""
	// `prompt` is replaceable per-test (e.g. deferred for in-flight tests)
	promptImpl: (text: string) => Promise<unknown> = async () => "default"
	// Mirrors the shape the wrapper reads off `homeBase` to decide whether a
	// slash command should be routed locally. Tests that exercise routing
	// configure this; everything else can leave it undefined.
	extensionRunner?: { getCommand: (name: string) => unknown }

	constructor(sessionId: string, tag = sessionId) {
		this.sessionId = sessionId
		this.tag = tag
	}

	subscribe(listener: AgentSessionEventListener): () => void {
		this.subscribeCallCount++
		this.listeners.add(listener)
		return () => {
			this.unsubscribeCallCount++
			this.listeners.delete(listener)
		}
	}

	emit(event: AgentSessionEvent): void {
		for (const l of [...this.listeners]) l(event)
	}

	listenerCount(): number {
		return this.listeners.size
	}

	async prompt(text: string): Promise<unknown> {
		return this.promptImpl(text)
	}

	dispose(): void {
		this.disposed = true
		this.listeners.clear()
	}
}

function asSession(fake: FakeAgentSession): AgentSession {
	return fake as unknown as AgentSession
}

function asRemote(fake: FakeAgentSession): RemoteAgentSession {
	return fake as unknown as RemoteAgentSession
}

// Helper to type-check passthrough property access in tests. The wrapper's
// Proxy forwards arbitrary property accesses to `foreground` at runtime, but
// TypeScript only sees the wrapper's declared surface. Cast to the fake's
// shape so test assertions on `.messages`, `.prompt`, etc. compile.
type PassthroughView = TeleportableAgentSession & {
	messages: unknown
	model: unknown
	systemPrompt: string
	sessionId: string
	prompt: FakeAgentSession["prompt"]
}
function asPassthrough(w: TeleportableAgentSession): PassthroughView {
	return w as unknown as PassthroughView
}

// Use a fake event type so we don't depend on the precise shape of any
// real AgentSessionEvent variant — the wrapper just forwards opaquely.
const fakeEvent = (tag: string): AgentSessionEvent => ({ type: "test_event", tag }) as unknown as AgentSessionEvent

describe("TeleportableAgentSession", () => {
	describe("construction", () => {
		it("foreground starts as homeBase; detached is empty", () => {
			const home = new FakeAgentSession("home")
			const wrapper = TeleportableAgentSession.create(asSession(home))
			expect(wrapper.foreground).toBe(asSession(home))
			expect(wrapper.homeBase).toBe(asSession(home))
			expect(wrapper.isForegroundHomeBase).toBe(true)
			expect(wrapper.getDetached().size).toBe(0)
		})

		it("subscribes to homeBase exactly once on construction", () => {
			const home = new FakeAgentSession("home")
			TeleportableAgentSession.create(asSession(home))
			expect(home.subscribeCallCount).toBe(1)
			expect(home.listenerCount()).toBe(1)
		})
	})

	describe("pure passthrough (foreground === homeBase)", () => {
		it("getters delegate to homeBase", () => {
			const home = new FakeAgentSession("home")
			home.messages = [{ role: "user", content: "hi" }]
			home.model = { id: "claude-test", provider: "anthropic" }
			home.systemPrompt = "you are a test"

			const wrapper = asPassthrough(TeleportableAgentSession.create(asSession(home)))

			expect(wrapper.messages).toEqual(home.messages)
			expect(wrapper.model).toEqual(home.model)
			expect(wrapper.systemPrompt).toBe(home.systemPrompt)
			expect(wrapper.sessionId).toBe("home")
		})

		it("methods forward to homeBase and return its value", async () => {
			const home = new FakeAgentSession("home")
			home.promptImpl = async (t) => `home:${t}`
			const wrapper = asPassthrough(TeleportableAgentSession.create(asSession(home)))

			const result = await wrapper.prompt("hello")
			expect(result).toBe("home:hello")
		})
	})

	describe("foregroundRemote", () => {
		it("happy path: swaps foreground, events route from remote, transport_changed fires", () => {
			const home = new FakeAgentSession("home")
			const remote = new FakeAgentSession("remote-A")
			const wrapper = TeleportableAgentSession.create(asSession(home))

			const received: AgentSessionEvent[] = []
			wrapper.subscribe((e) => received.push(e))

			wrapper.foregroundRemote(asRemote(remote))

			// (a) foreground identity changed
			expect(wrapper.foreground).toBe(asSession(remote))
			expect(wrapper.isForegroundHomeBase).toBe(false)

			// (d) transport_changed emitted with correct payload
			expect(received).toHaveLength(1)
			const tc = received[0] as unknown as TransportChangedEvent
			expect(tc.type).toBe("transport_changed")
			expect(tc.from).toBe("local")
			expect(tc.to).toBe("remote")
			expect(tc.sessionId).toBe("remote-A")

			// (b) events from remote reach the subscriber
			remote.emit(fakeEvent("from-remote"))
			expect(received).toHaveLength(2)
			expect((received[1] as unknown as { tag: string }).tag).toBe("from-remote")

			// (c) events from homeBase no longer reach the subscriber
			home.emit(fakeEvent("from-home-stray"))
			expect(received).toHaveLength(2)
		})

		it("precondition: throws when called while a remote is already foregrounded", () => {
			const home = new FakeAgentSession("home")
			const remoteA = new FakeAgentSession("A")
			const remoteB = new FakeAgentSession("B")
			const wrapper = TeleportableAgentSession.create(asSession(home))

			wrapper.foregroundRemote(asRemote(remoteA))
			expect(() => wrapper.foregroundRemote(asRemote(remoteB))).toThrowError(IllegalStateError)
		})

		it("unsubscribes from the old inner on swap", () => {
			const home = new FakeAgentSession("home")
			const remote = new FakeAgentSession("remote-A")
			const wrapper = TeleportableAgentSession.create(asSession(home))

			expect(home.listenerCount()).toBe(1)
			wrapper.foregroundRemote(asRemote(remote))

			expect(home.listenerCount()).toBe(0)
			expect(remote.listenerCount()).toBe(1)
		})
	})

	describe("detachToHomeBase", () => {
		it("happy path: foreground reverts, detached map gains the remote, events route back", () => {
			const home = new FakeAgentSession("home")
			const remote = new FakeAgentSession("remote-A")
			const wrapper = TeleportableAgentSession.create(asSession(home))

			wrapper.foregroundRemote(asRemote(remote))

			const received: AgentSessionEvent[] = []
			wrapper.subscribe((e) => received.push(e))

			const result = wrapper.detachToHomeBase()

			// (a) foreground reverted
			expect(wrapper.foreground).toBe(asSession(home))
			expect(wrapper.isForegroundHomeBase).toBe(true)

			// (b) detached map contains the remote keyed by sessionId
			expect(wrapper.getDetached().size).toBe(1)
			expect(wrapper.getDetached().get("remote-A")).toBe(asRemote(remote))
			expect(result.sessionId).toBe("remote-A")

			// (c) events flow from homeBase; events from the now-detached remote do not
			expect(received).toHaveLength(1) // transport_changed local→remote was emitted before subscribe
			home.emit(fakeEvent("from-home"))
			expect(received).toHaveLength(2)
			expect((received[1] as unknown as { tag: string }).tag).toBe("from-home")
			remote.emit(fakeEvent("from-detached"))
			expect(received).toHaveLength(2) // unchanged

			// Wait — actually the first event received WAS the swap-to-home
			// transport_changed. Verify its payload.
			const tc = received[0] as unknown as TransportChangedEvent
			expect(tc.type).toBe("transport_changed")
			expect(tc.from).toBe("remote")
			expect(tc.to).toBe("local")
			expect(tc.sessionId).toBe("remote-A")
		})

		it("precondition: throws when called from initial home-base state", () => {
			const home = new FakeAgentSession("home")
			const wrapper = TeleportableAgentSession.create(asSession(home))
			expect(() => wrapper.detachToHomeBase()).toThrowError(IllegalStateError)
		})
	})

	describe("multi-cycle and detached map ordering", () => {
		it("two foreground/detach cycles produce a detached map with insertion order preserved", () => {
			const home = new FakeAgentSession("home")
			const remoteA = new FakeAgentSession("A")
			const remoteB = new FakeAgentSession("B")
			const wrapper = TeleportableAgentSession.create(asSession(home))

			wrapper.foregroundRemote(asRemote(remoteA))
			wrapper.detachToHomeBase()
			wrapper.foregroundRemote(asRemote(remoteB))
			wrapper.detachToHomeBase()

			const ids = Array.from(wrapper.getDetached().keys())
			expect(ids).toEqual(["A", "B"])
			expect(wrapper.getDetached().get("A")).toBe(asRemote(remoteA))
			expect(wrapper.getDetached().get("B")).toBe(asRemote(remoteB))
		})
	})

	describe("promoteFromDetached", () => {
		it("returns the instance and removes it from the map", () => {
			const home = new FakeAgentSession("home")
			const remote = new FakeAgentSession("remote-A")
			const wrapper = TeleportableAgentSession.create(asSession(home))

			wrapper.foregroundRemote(asRemote(remote))
			wrapper.detachToHomeBase()
			expect(wrapper.getDetached().size).toBe(1)

			const pulled = wrapper.promoteFromDetached("remote-A")
			expect(pulled).toBe(asRemote(remote))
			expect(wrapper.getDetached().size).toBe(0)
		})

		it("throws when the sessionId is unknown", () => {
			const home = new FakeAgentSession("home")
			const wrapper = TeleportableAgentSession.create(asSession(home))
			expect(() => wrapper.promoteFromDetached("nope")).toThrowError(IllegalStateError)
		})
	})

	describe("listener identity across swaps", () => {
		it("a single subscription remains exactly one subscription across many swaps", () => {
			const home = new FakeAgentSession("home")
			const remoteA = new FakeAgentSession("A")
			const remoteB = new FakeAgentSession("B")
			const wrapper = TeleportableAgentSession.create(asSession(home))

			const listener = vi.fn()
			wrapper.subscribe(listener)

			// transport_changed counts as one event; we'll account for those.
			const callsAfter = () => listener.mock.calls.length

			expect(callsAfter()).toBe(0)
			home.emit(fakeEvent("h1"))
			expect(callsAfter()).toBe(1)

			wrapper.foregroundRemote(asRemote(remoteA)) // emits transport_changed
			expect(callsAfter()).toBe(2)
			remoteA.emit(fakeEvent("a1"))
			expect(callsAfter()).toBe(3)

			wrapper.detachToHomeBase() // emits transport_changed
			expect(callsAfter()).toBe(4)
			home.emit(fakeEvent("h2"))
			expect(callsAfter()).toBe(5)

			wrapper.foregroundRemote(asRemote(remoteB)) // emits transport_changed
			expect(callsAfter()).toBe(6)
			remoteB.emit(fakeEvent("b1"))
			expect(callsAfter()).toBe(7)

			// Detached remoteA must NOT reach the listener anymore
			remoteA.emit(fakeEvent("stray-from-A"))
			expect(callsAfter()).toBe(7)
		})

		it("unsubscribe stops events", () => {
			const home = new FakeAgentSession("home")
			const wrapper = TeleportableAgentSession.create(asSession(home))
			const listener = vi.fn()
			const unsub = wrapper.subscribe(listener)
			home.emit(fakeEvent("before"))
			expect(listener).toHaveBeenCalledTimes(1)
			unsub()
			home.emit(fakeEvent("after"))
			expect(listener).toHaveBeenCalledTimes(1)
		})
	})

	describe("in-flight prompt across swap", () => {
		it("a prompt() Promise issued on the old inner resolves with the old inner's value after swap", async () => {
			const home = new FakeAgentSession("home")
			const remote = new FakeAgentSession("remote-A")

			let resolveHomePrompt: ((v: unknown) => void) | undefined
			home.promptImpl = (text) =>
				new Promise((resolve) => {
					resolveHomePrompt = () => resolve(`home-resolved:${text}`)
				})

			const wrapper = asPassthrough(TeleportableAgentSession.create(asSession(home)))
			const inFlight = wrapper.prompt("first")

			// Mid-flight: swap foreground to remote
			wrapper.foregroundRemote(asRemote(remote))

			// Now resolve the home's deferred. Caller still receives home's result.
			resolveHomePrompt?.(undefined)
			const result = await inFlight
			expect(result).toBe("home-resolved:first")

			// And a fresh prompt after swap goes to the new foreground (remote).
			remote.promptImpl = async (t) => `remote-resolved:${t}`
			const afterSwap = await wrapper.prompt("second")
			expect(afterSwap).toBe("remote-resolved:second")
		})
	})

	describe("prompt routing", () => {
		it("routes allowlisted teleport commands to homeBase", async () => {
			const home = new FakeAgentSession("home")
			home.promptImpl = async (t) => `home:${t}`
			const remote = new FakeAgentSession("remote-A")
			const remoteSpy = vi.fn(async (t: string) => `remote:${t}`)
			remote.promptImpl = remoteSpy

			const wrapper = asPassthrough(TeleportableAgentSession.create(asSession(home)))
			wrapper.foregroundRemote(asRemote(remote))

			// /connect is in the local allowlist.
			const result = await wrapper.prompt("/connect abc123")
			expect(result).toBe("home:/connect abc123")
			expect(remoteSpy).not.toHaveBeenCalled()
		})

		it("routes non-allowlisted commands to foreground even if homeBase recognises them", async () => {
			const home = new FakeAgentSession("home")
			home.extensionRunner = {
				getCommand: (name: string) => (name === "permissions" ? { name } : undefined),
			}
			const homeSpy = vi.fn(async (t: string) => `home:${t}`)
			home.promptImpl = homeSpy
			const remote = new FakeAgentSession("remote-A")
			remote.promptImpl = async (t) => `remote:${t}`

			const wrapper = asPassthrough(TeleportableAgentSession.create(asSession(home)))
			wrapper.foregroundRemote(asRemote(remote))

			// /permissions is registered locally but NOT in the allowlist.
			const result = await wrapper.prompt("/permissions mode allow")
			expect(result).toBe("remote:/permissions mode allow")
			expect(homeSpy).not.toHaveBeenCalled()
		})

		it("routes plain (non-slash) text to the foreground", async () => {
			const home = new FakeAgentSession("home")
			const homeSpy = vi.fn(async () => "home")
			home.promptImpl = homeSpy
			const remote = new FakeAgentSession("remote-A")
			remote.promptImpl = async (t) => `remote:${t}`

			const wrapper = asPassthrough(TeleportableAgentSession.create(asSession(home)))
			wrapper.foregroundRemote(asRemote(remote))

			const result = await wrapper.prompt("just a chat message")
			expect(result).toBe("remote:just a chat message")
			expect(homeSpy).not.toHaveBeenCalled()
		})

		it("tolerates leading whitespace before the slash", async () => {
			const home = new FakeAgentSession("home")
			home.promptImpl = async (t) => `home:${t}`
			const remote = new FakeAgentSession("remote-A")
			const remoteSpy = vi.fn(async () => "remote")
			remote.promptImpl = remoteSpy

			const wrapper = asPassthrough(TeleportableAgentSession.create(asSession(home)))
			wrapper.foregroundRemote(asRemote(remote))

			const result = await wrapper.prompt("  /connect xyz  ")
			expect(result).toBe("home:  /connect xyz  ")
			expect(remoteSpy).not.toHaveBeenCalled()
		})

		it("treats bare '/' (no command name) as a non-local message", async () => {
			const home = new FakeAgentSession("home")
			const homeSpy = vi.fn(async () => "home")
			home.promptImpl = homeSpy
			const remote = new FakeAgentSession("remote-A")
			remote.promptImpl = async (t) => `remote:${t}`

			const wrapper = asPassthrough(TeleportableAgentSession.create(asSession(home)))
			wrapper.foregroundRemote(asRemote(remote))

			const result = await wrapper.prompt("/")
			expect(result).toBe("remote:/")
			expect(homeSpy).not.toHaveBeenCalled()
		})

		it("forwards options on the local-route as well", async () => {
			const home = new FakeAgentSession("home")
			const homeSpy = vi.fn(async (_t: string, _o?: unknown) => "home")
			// Replace prompt entirely so we can assert the options argument.
			;(home as unknown as { prompt: (t: string, o?: unknown) => Promise<unknown> }).prompt = async (
				t: string,
				o?: unknown,
			) => homeSpy(t, o)
			const remote = new FakeAgentSession("remote-A")

			const wrapper = asPassthrough(TeleportableAgentSession.create(asSession(home)))
			wrapper.foregroundRemote(asRemote(remote))

			await (wrapper as unknown as { prompt: (t: string, o?: unknown) => Promise<unknown> }).prompt("/connect abc", {
				streamingBehavior: "steer",
			})
			expect(homeSpy).toHaveBeenCalledWith("/connect abc", { streamingBehavior: "steer" })
		})

		it("when foreground === homeBase, behaves identically (always to homeBase)", async () => {
			const home = new FakeAgentSession("home")
			home.promptImpl = async (t) => `home:${t}`
			const wrapper = asPassthrough(TeleportableAgentSession.create(asSession(home)))

			// Both branches converge on home before any swap.
			expect(await wrapper.prompt("/connect abc")).toBe("home:/connect abc")
			expect(await wrapper.prompt("hello")).toBe("home:hello")
		})
	})

	describe("reload routing", () => {
		it("always routes reload() to homeBase, even when a remote is foregrounded", async () => {
			const home = new FakeAgentSession("home")
			const homeSpy = vi.fn(async () => "home-reloaded")
			;(home as unknown as { reload: () => Promise<unknown> }).reload = homeSpy

			const remote = new FakeAgentSession("remote-A")
			const remoteSpy = vi.fn(async () => "remote-reloaded")
			;(remote as unknown as { reload: () => Promise<unknown> }).reload = remoteSpy

			const wrapper = TeleportableAgentSession.create(asSession(home))
			wrapper.foregroundRemote(asRemote(remote))

			const result = await (wrapper as unknown as { reload: () => Promise<unknown> }).reload()
			expect(result).toBe("home-reloaded")
			expect(homeSpy).toHaveBeenCalledTimes(1)
			expect(remoteSpy).not.toHaveBeenCalled()
		})

		it("routes reload() to homeBase when foreground IS homeBase", async () => {
			const home = new FakeAgentSession("home")
			const homeSpy = vi.fn(async () => "home-reloaded")
			;(home as unknown as { reload: () => Promise<unknown> }).reload = homeSpy

			const wrapper = TeleportableAgentSession.create(asSession(home))
			const result = await (wrapper as unknown as { reload: () => Promise<unknown> }).reload()
			expect(result).toBe("home-reloaded")
			expect(homeSpy).toHaveBeenCalledTimes(1)
		})
	})

	describe("dispose", () => {
		it("clears wrapper listeners and unsubscribes from the current foreground; does not dispose inner", () => {
			const home = new FakeAgentSession("home")
			const wrapper = TeleportableAgentSession.create(asSession(home))
			const listener = vi.fn()
			wrapper.subscribe(listener)

			expect(home.listenerCount()).toBe(1)
			wrapper.dispose()
			expect(home.listenerCount()).toBe(0)
			expect(home.disposed).toBe(false)

			// Further emits go nowhere.
			home.emit(fakeEvent("after-dispose"))
			expect(listener).not.toHaveBeenCalled()
		})
	})
})
