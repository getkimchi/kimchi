import { describe, expect, it } from "vitest"
import { selectRuntime } from "./select.js"

describe("selectRuntime", () => {
	it("selectRuntime('docker').name === 'docker'", () => {
		expect(selectRuntime("docker").name).toBe("docker")
	})

	it("selectRuntime('orbstack').name === 'orbstack'", () => {
		expect(selectRuntime("orbstack").name).toBe("orbstack")
	})

	it("selectRuntime('podman').name === 'podman'", () => {
		expect(selectRuntime("podman").name).toBe("podman")
	})

	it("throws with /Unknown runtime/i for an unrecognized name", () => {
		expect(() => selectRuntime("nope")).toThrow(/Unknown runtime/i)
	})

	it("throws for k8s/kubernetes (no longer supported)", () => {
		expect(() => selectRuntime("k8s")).toThrow(/Unknown runtime/i)
		expect(() => selectRuntime("kubernetes")).toThrow(/Unknown runtime/i)
	})

	it("throws for another unrecognized name 'minikube'", () => {
		expect(() => selectRuntime("minikube")).toThrow(/Unknown runtime/i)
	})

	it("is case-insensitive: 'DOCKER' resolves to docker runtime", () => {
		expect(selectRuntime("DOCKER").name).toBe("docker")
	})

	it("is case-insensitive: 'ORBSTACK' resolves to orbstack runtime", () => {
		expect(selectRuntime("ORBSTACK").name).toBe("orbstack")
	})

	it("is case-insensitive: 'PODMAN' resolves to podman runtime", () => {
		expect(selectRuntime("PODMAN").name).toBe("podman")
	})

	it("returns a runtime with a run() method for every known variant", () => {
		for (const name of ["docker", "orbstack", "podman"]) {
			const rt = selectRuntime(name)
			expect(typeof rt.run).toBe("function")
		}
	})
})
