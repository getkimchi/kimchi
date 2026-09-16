import type { Theme } from "@earendil-works/pi-coding-agent"
import type { Text } from "@earendil-works/pi-tui"
import { describe, expect, it } from "vitest"
import { createExtensionApi } from "../__mocks__/extension-api.js"
import { DIFF_MESSAGE_CAP_LINES, REMOTE_DIFF_ENTRY_TYPE, renderRemoteRunDiff } from "./diff-entry.js"
import remoteRunExtension from "./index.js"

/** Marker theme: colors render as visible tags so tests assert semantics. */
const theme = {
	fg: (color: string, text: string) => `[${color}]${text}[/${color}]`,
	bold: (text: string) => `[b]${text}[/b]`,
} as unknown as Theme

const DETAILS = {
	title: "kimchi/fix-login — 2 files (+3/-1)",
	stat: "2 files changed, 3 insertions(+), 1 deletion(-)",
	patch: [
		"diff --git a/src/a.ts b/src/a.ts",
		"--- a/src/a.ts",
		"+++ b/src/a.ts",
		"@@ -1 +1 @@",
		"-old",
		"+new",
		" context",
	].join("\n"),
	patchPath: "/tmp/out/remote-diff.patch",
}

function rendered(details: unknown, expanded: boolean): string {
	const component = renderRemoteRunDiff({ data: details as never }, { expanded }, theme)
	expect(component).toBeDefined()
	return (component as Text).render(200).join("\n")
}

describe("remote_run:diff entry registration", () => {
	it("remoteRunExtension registers the remote_run:diff entry renderer", () => {
		const { api, registerEntryRenderer } = createExtensionApi()

		remoteRunExtension(api)

		expect(registerEntryRenderer).toHaveBeenCalledWith(REMOTE_DIFF_ENTRY_TYPE, expect.any(Function))
	})
})

describe("renderRemoteRunDiff", () => {
	it("renders collapsed by default: header, stat, patch path and a 3-line preview", () => {
		const out = rendered(DETAILS, false)

		expect(out).toContain("[b]kimchi/fix-login — 2 files (+3/-1)[/b]")
		expect(out).toContain("2 files changed, 3 insertions(+), 1 deletion(-)")
		expect(out).toContain("patch: /tmp/out/remote-diff.patch")
		expect(out).toContain("[b]diff --git a/src/a.ts b/src/a.ts[/b]")
		expect(out).toContain("[muted]+++ b/src/a.ts[/muted]")
		// Beyond the 3-line preview — collapsed hides these.
		expect(out).not.toContain("-old")
		expect(out).not.toContain("+new")
		expect(out).toContain("4 more lines")
	})

	it("expanded renders the full colored patch", () => {
		const out = rendered(DETAILS, true)

		expect(out).toContain("[error]-old[/error]")
		expect(out).toContain("[success]+new[/success]")
		expect(out).toContain("[muted] context[/muted]")
		expect(out).toContain("[b]@@ -1 +1 @@[/b]")
	})

	it("expanded notes the cap when the persisted patch was capped", () => {
		const out = rendered({ ...DETAILS, capped: true }, true)

		expect(out).toContain(`capped at ${DIFF_MESSAGE_CAP_LINES} lines — full patch: /tmp/out/remote-diff.patch`)
	})

	it("renders identically from entry data alone (survives transcript reload)", () => {
		expect(rendered(DETAILS, true)).toBe(rendered(DETAILS, true))
	})

	it("returns undefined for entries without data", () => {
		expect(renderRemoteRunDiff({ data: undefined }, { expanded: false }, theme)).toBeUndefined()
	})
})
