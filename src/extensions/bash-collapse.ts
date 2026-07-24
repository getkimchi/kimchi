/**
 * Collapses multiple newlines in a command string into a single space with a return symbol (⏎).
 * @param command - The command string to collapse, which may be undefined.
 * @returns The collapsed string with newlines replaced by ' ⏎ '.
 */
export function collapseCommand(command: string | undefined): string {
	return (command ?? "").replace(/\n+/g, " ⏎ ")
}
