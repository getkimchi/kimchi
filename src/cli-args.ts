export function getCliModeArg(args: string[]): string | undefined {
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i]
		if (arg === "--mode" && i + 1 < args.length) return args[i + 1]
		if (arg.startsWith("--mode=")) return arg.slice("--mode=".length)
	}
	return undefined
}
