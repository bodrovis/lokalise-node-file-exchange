import { defineConfig } from "vitest/config";

const isCI = process.env.CI === "true";
// On some win systems coverage randomly causes timeouts
const isWindows = process.platform === "win32";

export default defineConfig({
	esbuild: {
		target: "es2024",
	},
	test: {
		silent: isCI,
		reporters: isCI ? ["default"] : ["verbose"],
		sequence: {
			shuffle: true,
		},
		coverage: {
			enabled: !isWindows,
			provider: "istanbul",
			reporter: isCI ? ["lcov", "text-summary"] : ["html", "text"],
			include: ["lib/**"],
		},
		typecheck: {
			enabled: true,
		},
	},
});
