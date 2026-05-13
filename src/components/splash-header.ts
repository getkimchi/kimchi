import type { Theme } from "@earendil-works/pi-coding-agent"
import type { Component } from "@earendil-works/pi-tui"
import { visibleWidth } from "@earendil-works/pi-tui"
import { buildLogoLines, buildPathLine, buildVersionLine } from "./logo-art.js"
import { clampLines, splashTopPadding } from "./splash-layout.js"

export class SplashHeader implements Component {
	private readonly theme: Theme
	private logoLines: string[]

	constructor(theme: Theme) {
		this.theme = theme
		this.logoLines = buildLogoLines(theme)
	}

	invalidate(): void {
		this.logoLines = buildLogoLines(this.theme)
	}

	render(width: number): string[] {
		const versionLine = buildVersionLine(this.theme)
		const versionWidth = visibleWidth(versionLine)

		const pathLine = buildPathLine(this.theme)
		const pathWidth = visibleWidth(pathLine)

		const topPad = splashTopPadding()

		const result: string[] = []
		for (let i = 0; i < topPad; i++) result.push("")

		const logoWidth = visibleWidth(this.logoLines[0])
		const logoLeftPad = Math.max(0, Math.floor((width - logoWidth) / 2))
		const logoPrefix = " ".repeat(logoLeftPad)
		for (const line of this.logoLines) {
			result.push(logoPrefix + line)
		}

		result.push("")
		result.push(`${" ".repeat(Math.max(0, Math.floor((width - versionWidth) / 2)))}${versionLine}`)
		result.push(`${" ".repeat(Math.max(0, Math.floor((width - pathWidth) / 2)))}${pathLine}`)

		return clampLines(result, width)
	}
}
