/** The linked-worktree directory the session's commands actually run in, shared across
 *  extensions and surfaces. Undefined while they run in the session's own directory. */
let activeAnchor: string | undefined

export function setActiveAnchor(directory: string | undefined): void {
	activeAnchor = directory
}

export function getActiveAnchor(): string | undefined {
	return activeAnchor
}
