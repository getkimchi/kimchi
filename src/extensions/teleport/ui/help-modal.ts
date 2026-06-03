import type { ExtensionCommandContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent"
import { type Component, Container, Key, Spacer, type TUI, Text, matchesKey } from "@earendil-works/pi-tui"

const TIPS: ReadonlyArray<{ keys: string; label: string }> = [
	{ keys: "Ctrl+B then n / p / 1-9", label: "Cycle between remote sessions (next / prev / jump)" },
	{ keys: "Ctrl+D", label: "Leave remote sessions running and return to local kimchi" },
	{ keys: "/sync", label: "Sync files between your machine and the remote workspace" },
	{ keys: "/terminal", label: "SSH into the remote workspace" },
	{ keys: "/sessions, /workspaces", label: "List remote sessions or manage workspaces" },
]

class TeleportHelpComponent extends Container {
	private static readonly rail = " ▍ "

	private readonly theme: Theme
	private readonly done: (result: undefined) => void

	constructor(_tui: TUI, theme: Theme, _keybindings: KeybindingsManager, done: (result: undefined) => void) {
		super()
		this.theme = theme
		this.done = done
		this.buildContent()
	}

	override render(width: number): string[] {
		const contentWidth = Math.max(0, width - TeleportHelpComponent.rail.length)
		return this.withFrame(super.render(contentWidth), width)
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.enter) || matchesKey(data, Key.return) || matchesKey(data, Key.escape)) {
			this.done(undefined)
		}
	}

	private buildContent(): void {
		this.addChild(new Text(this.theme.fg("toolTitle", this.theme.bold("Continue your work remotely")), 0, 0))
		this.addChild(new Spacer(1))
		this.addChild(
			new Text(
				this.theme.fg(
					"text",
					"/teleport syncs your repo to a remote workspace and opens a session you can reattach to from anywhere.",
				),
				0,
				0,
			),
		)
		this.addChild(new Spacer(1))
		this.addChild(new Text(this.theme.fg("text", this.theme.bold("Topbar")), 0, 0))
		this.addChild(new Text(this.theme.fg("muted", "Each session is a tab — the active one is highlighted."), 0, 0))
		this.addChild(new Spacer(1))
		const bar = [
			this.mockTab(" 1:fix-auth", { active: true }),
			this.mockTab("•2:run-tests"),
			this.mockTab("○3:lost-conn", { muted: true }),
			this.mockTab("⚠4:retrying", { warning: true }),
		].join(this.mockSep())
		this.addChild(new Text(`    ${bar}`, 0, 0))
		this.addChild(new Spacer(1))
		const legend =
			`    ${this.theme.fg("muted", "•")}  unread output` +
			`     ${this.theme.fg("dim", "○")}  disconnected` +
			`     ${this.theme.fg("warning", "⚠")}  reconnecting / failed`
		this.addChild(new Text(legend, 0, 0))
		this.addChild(new Spacer(1))
		this.addChild(new Text(this.theme.fg("text", this.theme.bold("Tips")), 0, 0))
		for (const tip of TIPS) {
			const keys = this.theme.fg("accent", tip.keys)
			const label = this.theme.fg("text", tip.label)
			this.addChild(new Text(`  ${keys} ${this.theme.fg("muted", "—")} ${label}`, 0, 0))
		}
		this.addChild(new Spacer(1))
		this.addChild(new Text(this.theme.fg("dim", "Press Enter or Esc to continue"), 0, 0))
	}

	private withFrame(lines: string[], width: number): string[] {
		const rule = this.theme.fg("borderMuted", "─".repeat(Math.max(0, width)))
		const rail = this.theme.fg("muted", TeleportHelpComponent.rail)
		return [rule, ...lines.map((line) => `${rail}${line}`), rule]
	}

	private mockTab(text: string, opts: { active?: boolean; muted?: boolean; warning?: boolean } = {}): string {
		const padded = ` ${text} `
		if (opts.active) return this.theme.inverse(padded)
		if (opts.muted) return this.theme.fg("dim", padded)
		if (opts.warning) return this.theme.fg("warning", padded)
		return this.theme.fg("muted", padded)
	}

	private mockSep(): string {
		return this.theme.fg("dim", "│")
	}
}

export async function promptTeleportHelp(ui: ExtensionCommandContext["ui"]): Promise<void> {
	await ui.custom<undefined>(
		(tui, theme, keybindings, done): Component => new TeleportHelpComponent(tui, theme as Theme, keybindings, done),
	)
}
