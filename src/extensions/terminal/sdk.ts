interface Agent {
	name: string
}

interface RemoteWorkspace {
	id: string
	url: string

	createAgent(): void
}
