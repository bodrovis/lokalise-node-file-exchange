import { defineConfig } from "vitest/config";

const isCI = process.env.CI === "true";

export default defineConfig({
	esbuild: {
		target: "es2022",
	},
	test: {
		silent: isCI,
		reporters: isCI ? ["default"] : ["verbose"],
		sequence: {
			shuffle: true,
		},
		coverage: {
			provider: "istanbul",
			reporter: isCI ? ["lcov"] : ["html", "text"],
			include: ["lib/**"],
		},
		typecheck: {
			enabled: true,
		},
	},
});
