import { defineConfig } from "tsup";

export default defineConfig({
	entry: ["lib/index.ts"],
	outDir: "dist",
	format: ["esm"],
	dts: true,
	splitting: false,
	shims: true,
	sourcemap: true,
	clean: true,
	minify: false,
});
