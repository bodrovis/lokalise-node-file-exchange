import { defineConfig } from "tsup";

export default defineConfig({
	entry: ["lib/index.ts"],
	outDir: "dist",
	format: ["esm"],
	dts: {
		entry: "lib/index.ts",
	},
	splitting: false,
	sourcemap: true,
	clean: true,
	minify: false,
	target: "node20",
});
