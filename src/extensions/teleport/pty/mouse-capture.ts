export function enableMouseCapture(): void {
	process.stdout.write("\x1b[?1000h\x1b[?1006h")
}

export function disableMouseCapture(): void {
	process.stdout.write("\x1b[?1000l\x1b[?1006l")
}
