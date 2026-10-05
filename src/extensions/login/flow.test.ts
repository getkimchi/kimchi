import { initTheme, LoginDialogComponent } from "@earendil-works/pi-coding-agent"
import type { TUI } from "@earendil-works/pi-tui"
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { setExperimentalFeaturesEnabled } from "../experimental.js"
import { createRegionSelector, regionChoiceRequired, SwappableAuthComponent } from "./flow.js"

beforeAll(() => {
	initTheme("default")
})

function createTui(): TUI {
	return { requestRender: vi.fn() } as unknown as TUI
}

describe("createRegionSelector", () => {
	// EU is gated behind --enable-experimental-features; these tests cover the
	// ungated (flag-on) behaviour.
	beforeEach(() => setExperimentalFeaturesEnabled(true))
	afterEach(() => setExperimentalFeaturesEnabled(false))

	function optionsOf(selector: unknown): string[] {
		return (selector as { options: string[] }).options
	}

	it("lists the current region first", () => {
		const us = createRegionSelector({ currentRegion: "us", onSelect: vi.fn(), onBack: vi.fn() })
		expect(optionsOf(us)).toEqual(["United States \u2014 current", "Europe", "Self-hosted"])

		const eu = createRegionSelector({ currentRegion: "eu", onSelect: vi.fn(), onBack: vi.fn() })
		expect(optionsOf(eu)).toEqual(["Europe \u2014 current", "United States", "Self-hosted"])

		const selfHosted = createRegionSelector({ currentRegion: "self-hosted", onSelect: vi.fn(), onBack: vi.fn() })
		expect(optionsOf(selfHosted)).toEqual(["Self-hosted \u2014 current", "United States", "Europe"])
	})

	it("maps the selected option to its region id", () => {
		const onSelect = vi.fn()
		const selector = createRegionSelector({ currentRegion: "us", onSelect, onBack: vi.fn() })
		selector.handleInput("\n")
		expect(onSelect).toHaveBeenCalledWith("us")

		const second = createRegionSelector({ currentRegion: "us", onSelect, onBack: vi.fn() })
		second.handleInput("j")
		second.handleInput("\n")
		expect(onSelect).toHaveBeenCalledWith("eu")
	})

	it("maps options to region ids when the current region is not the first region", () => {
		const onSelect = vi.fn()
		const selector = createRegionSelector({ currentRegion: "eu", onSelect, onBack: vi.fn() })
		selector.handleInput("\n")
		expect(onSelect).toHaveBeenLastCalledWith("eu")

		const second = createRegionSelector({ currentRegion: "eu", onSelect, onBack: vi.fn() })
		second.handleInput("j")
		second.handleInput("\n")
		expect(onSelect).toHaveBeenLastCalledWith("us")
	})

	it("invokes onBack on Esc without selecting", () => {
		const onSelect = vi.fn()
		const onBack = vi.fn()
		const selector = createRegionSelector({ currentRegion: "us", onSelect, onBack })
		selector.handleInput("\x1b")
		expect(onBack).toHaveBeenCalledOnce()
		expect(onSelect).not.toHaveBeenCalled()
	})

	it("hides EU and self-hosted when experimental features are off", () => {
		setExperimentalFeaturesEnabled(false)

		const us = createRegionSelector({ currentRegion: "us", onSelect: vi.fn(), onBack: vi.fn() })
		expect(optionsOf(us)).toEqual(["United States \u2014 current"])
	})

	it("still lists the configured EU region first when experimental features are off", () => {
		setExperimentalFeaturesEnabled(false)

		const eu = createRegionSelector({ currentRegion: "eu", onSelect: vi.fn(), onBack: vi.fn() })
		expect(optionsOf(eu)).toEqual(["Europe \u2014 current", "United States"])
	})

	it("still lists the configured self-hosted region first when experimental features are off", () => {
		setExperimentalFeaturesEnabled(false)

		const selfHosted = createRegionSelector({ currentRegion: "self-hosted", onSelect: vi.fn(), onBack: vi.fn() })
		expect(optionsOf(selfHosted)).toEqual(["Self-hosted \u2014 current", "United States"])
	})
})

describe("regionChoiceRequired", () => {
	beforeEach(() => setExperimentalFeaturesEnabled(true))
	afterEach(() => setExperimentalFeaturesEnabled(false))

	it("is true when multiple regions are selectable", () => {
		expect(regionChoiceRequired("us")).toBe(true)
	})

	it("is false when EU is experimental-gated and the configured region is the default", () => {
		setExperimentalFeaturesEnabled(false)
		expect(regionChoiceRequired("us")).toBe(false)
	})

	it("is true when EU is experimental-gated but already configured (user can switch back)", () => {
		setExperimentalFeaturesEnabled(false)
		expect(regionChoiceRequired("eu")).toBe(true)
	})

	it("is true when self-hosted is experimental-gated but already configured", () => {
		setExperimentalFeaturesEnabled(false)
		expect(regionChoiceRequired("self-hosted")).toBe(true)
	})
})

describe("promptSelfHostedBaseUrl", () => {
	it("normalizes a valid base URL", async () => {
		const { promptSelfHostedBaseUrl } = await import("./flow.js")
		const prompt = vi.fn().mockResolvedValueOnce(" https://kimchi.example.com/ ")
		const notifyError = vi.fn()

		const url = await promptSelfHostedBaseUrl({ prompt, notifyError })

		expect(url).toBe("https://kimchi.example.com")
		expect(prompt).toHaveBeenCalledWith("Self-hosted Kimchi base URL:", "https://your-kimchi-host.example.com")
		expect(notifyError).not.toHaveBeenCalled()
	})

	it("offers the stored URL as the Enter default", async () => {
		const { promptSelfHostedBaseUrl } = await import("./flow.js")
		const prompt = vi.fn().mockResolvedValueOnce("")

		const url = await promptSelfHostedBaseUrl({ prompt, notifyError: vi.fn(), storedUrl: "https://stored.example.com" })

		expect(url).toBe("https://stored.example.com")
		expect(prompt).toHaveBeenCalledWith("Self-hosted base URL (press Enter to use https://stored.example.com):", "")
	})

	it("re-prompts on invalid input until it parses", async () => {
		const { promptSelfHostedBaseUrl } = await import("./flow.js")
		const prompt = vi.fn().mockResolvedValueOnce("not a url").mockResolvedValueOnce("https://kimchi.example.com")
		const notifyError = vi.fn()

		const url = await promptSelfHostedBaseUrl({ prompt, notifyError })

		expect(url).toBe("https://kimchi.example.com")
		expect(prompt).toHaveBeenCalledTimes(2)
		expect(notifyError).toHaveBeenCalledWith(
			'Invalid base URL "not a url" (expected an http(s) URL, e.g. https://kimchi.example.com)',
		)
	})

	it("re-prompts when no stored URL exists and the input is blank", async () => {
		const { promptSelfHostedBaseUrl } = await import("./flow.js")
		const prompt = vi.fn().mockResolvedValueOnce("").mockResolvedValueOnce("https://kimchi.example.com")
		const notifyError = vi.fn()

		const url = await promptSelfHostedBaseUrl({ prompt, notifyError })

		expect(url).toBe("https://kimchi.example.com")
		expect(notifyError).toHaveBeenCalledWith(
			"A base URL is required for the self-hosted region, e.g. https://kimchi.example.com",
		)
	})

	it("returns undefined on Esc (cancel)", async () => {
		const { promptSelfHostedBaseUrl } = await import("./flow.js")
		const prompt = vi.fn().mockResolvedValueOnce(undefined)

		const url = await promptSelfHostedBaseUrl({ prompt, notifyError: vi.fn() })

		expect(url).toBeUndefined()
	})
})

describe("SwappableAuthComponent", () => {
	// Regression for https://github.com/getkimchi/kimchi/issues/616: the subscription
	// (GitHub Copilot) login path hosts a LoginDialogComponent inside SwappableAuthComponent.
	// Typing any non-Escape character forwards the byte to the hosted LoginDialogComponent,
	// whose handleInput dereferences `this.input`. If the forward drops the `this` binding,
	// that runs with `this === undefined` and crashes.
	it("forwards a typed character to the real login dialog without crashing", () => {
		const tui = createTui()
		const host = new SwappableAuthComponent(tui)
		const dialog = new LoginDialogComponent(tui, "github-copilot", () => {}, "GitHub Copilot")
		host.set(dialog)

		expect(() => host.handleInput("a")).not.toThrow()
	})

	// Pinpoints the root cause directly: the hosted component must be invoked as a method so
	// `this` stays bound to it. Fails loudly if the forward ever regresses to a detached bare call.
	it("invokes the hosted component with `this` bound to that component", () => {
		const tui = createTui()
		const host = new SwappableAuthComponent(tui)
		let receivedThis: unknown
		const child = {
			handleInput(this: unknown): void {
				receivedThis = this
			},
		}
		host.set(child)

		host.handleInput("a")

		expect(receivedThis).toBe(child)
	})
})
