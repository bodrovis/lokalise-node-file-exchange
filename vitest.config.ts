import { defineConfig } from "vitest/config";

const isCI = !!process.env.CI;

export default defineConfig({
	esbuild: { target: "es2024" },
	test: {
		silent: isCI,
		reporters: isCI ? ["default"] : ["verbose"],
		sequence: {
			shuffle: { files: true, tests: true },
		},
		coverage: {
			enabled: true,
			provider: "v8",
			reporter: isCI ? ["lcov", "text-summary"] : ["text", "html"],
			include: ["lib/**/*.ts"],
			clean: true,
		},
		typecheck: {
			enabled: true,
			tsconfig: "./tsconfig.test.json",
		},
	},
});
