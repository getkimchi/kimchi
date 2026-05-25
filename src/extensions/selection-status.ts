let selectionStatus: string | null = null

export function getSelectionStatus(): string | null {
	return selectionStatus
}

export function setSelectionStatus(status: string | null): void {
	selectionStatus = status
}
