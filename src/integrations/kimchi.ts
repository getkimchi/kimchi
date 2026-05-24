import { register } from "./registry.js"
register({
	id: "kimchi",
	name: "Kimchi",
	description: "AI coding agent harness",
	configPath: "",
	binaryName: "kimchi",
	isInstalled: () => true,
	write: async () => {},
})
