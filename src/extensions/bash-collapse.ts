export function collapseCommand(command: string | undefined): string {
	return (command ?? "").replace(/\n+/g, " ⏎ ")
}
