import path from "node:path";
import mock from "mock-fs";
import { FakeLokaliseUpload } from "../../fixtures/fake_classes/FakeLokaliseUpload.js";
import { afterEach, beforeEach, describe, expect, it } from "../../setup.js";

describe("LokaliseUpload: collectFiles()", () => {
	const projectId = "803826145ba90b42d5d860.46800099";
	const apiKey = process.env.API_KEY as string;
	let lokaliseUpload: FakeLokaliseUpload;

	beforeEach(() => {
		lokaliseUpload = new FakeLokaliseUpload({ apiKey }, { projectId });

		mock({
			"./locales": {
				"en.json": '{"key": "value"}',
				"fr.json": '{"clé": "valeur"}',
				"backup.txt": "Not a JSON file",
				subdir: {
					"es.json": '{"clave": "valor"}',
					nested: {
						"de.json": '{"schlüssel": "wert"}',
						"ignored.js": "// Some JS code",
					},
				},
			},
			"./node_modules": {
				"module.js": "// This should be excluded",
			},
			"./dist": {
				"build.json": '{"build": true}',
			},
		});
	});

	afterEach(() => {
		mock.restore();
	});

	const fullPath = (p: string) => path.resolve(p);

	describe("General Behavior", () => {
		it("should collect all JSON files recursively by default", async () => {
			const files = await lokaliseUpload.collectFiles();
			const expectedFiles = [
				fullPath("./locales/en.json"),
				fullPath("./locales/fr.json"),
				fullPath("./locales/backup.txt"),
				fullPath("./locales/subdir/es.json"),
				fullPath("./locales/subdir/nested/de.json"),
				fullPath("./locales/subdir/nested/ignored.js"),
			];
			expect(files).toEqual(expect.arrayContaining(expectedFiles));
			expect(files).toHaveLength(expectedFiles.length);
		});

		it("should handle non-recursive mode", async () => {
			const files = await lokaliseUpload.collectFiles({
				recursive: false,
			});
			const expectedFiles = [
				fullPath("./locales/en.json"),
				fullPath("./locales/fr.json"),
				fullPath("./locales/backup.txt"),
			];
			expect(files).toEqual(expect.arrayContaining(expectedFiles));
			expect(files).toHaveLength(expectedFiles.length);
		});

		it("should return an empty array when inputDirs is empty", async () => {
			const files = await lokaliseUpload.collectFiles({
				inputDirs: [],
			});
			expect(files).toEqual([]);
			expect(files).toHaveLength(0);
		});
	});

	describe("Filtering", () => {
		it("should filter files by extensions", async () => {
			const files = await lokaliseUpload.collectFiles({
				extensions: [".json"],
			});
			const expectedFiles = [
				fullPath("./locales/en.json"),
				fullPath("./locales/fr.json"),
				fullPath("./locales/subdir/es.json"),
				fullPath("./locales/subdir/nested/de.json"),
			];
			expect(files).toEqual(expect.arrayContaining(expectedFiles));
			expect(files).toHaveLength(expectedFiles.length);
		});

		it("should handle mixed file extensions correctly", async () => {
			const files = await lokaliseUpload.collectFiles({
				extensions: [".json", "JS"],
			});
			const expectedFiles = [
				fullPath("./locales/en.json"),
				fullPath("./locales/fr.json"),
				fullPath("./locales/subdir/es.json"),
				fullPath("./locales/subdir/nested/de.json"),
				fullPath("./locales/subdir/nested/ignored.js"),
			];
			expect(files).toEqual(expect.arrayContaining(expectedFiles));
			expect(files).toHaveLength(expectedFiles.length);
		});

		it("should filter files by fileNamePattern", async () => {
			const files = await lokaliseUpload.collectFiles({
				fileNamePattern: "^en.*",
			});
			const expectedFiles = [fullPath("./locales/en.json")];
			expect(files).toEqual(expect.arrayContaining(expectedFiles));
			expect(files).toHaveLength(expectedFiles.length);
		});

		it("should filter files by both fileNamePattern and extensions", async () => {
			const files = await lokaliseUpload.collectFiles({
				extensions: [".json"],
				fileNamePattern: /^en.*/,
			});
			const expectedFiles = [fullPath("./locales/en.json")];
			expect(files).toEqual(expect.arrayContaining(expectedFiles));
			expect(files).toHaveLength(expectedFiles.length);
		});
	});

	describe("Exclusions", () => {
		it("should respect the excludePatterns option", async () => {
			const files = await lokaliseUpload.collectFiles({
				excludePatterns: ["nested", "backup"],
			});
			const expectedFiles = [
				fullPath("./locales/en.json"),
				fullPath("./locales/fr.json"),
				fullPath("./locales/subdir/es.json"),
			];
			expect(files).toEqual(expect.arrayContaining(expectedFiles));
			expect(files).toHaveLength(expectedFiles.length);
		});

		it("should exclude directories and apply file filters simultaneously", async () => {
			const files = await lokaliseUpload.collectFiles({
				excludePatterns: [/locales\\subdir/, /locales\/subdir/, /en\.json$/i],
				extensions: [".json"],
			});
			const expectedFiles = [fullPath("./locales/fr.json")];

			expect(files).toEqual(expect.arrayContaining(expectedFiles));
			expect(files).toHaveLength(expectedFiles.length);
		});
	});

	describe("Edge Cases", () => {
		it("should throw an error for invalid fileNamePattern", async () => {
			await expect(
				lokaliseUpload.collectFiles({
					fileNamePattern: "[invalid(",
				}),
			).rejects.toThrow("Invalid fileNamePattern");
		});

		it("should throw an error for invalid excludePatterns", async () => {
			await expect(
				lokaliseUpload.collectFiles({
					excludePatterns: ["[invalid("],
				}),
			).rejects.toThrow("Invalid excludePatterns: SyntaxError");
		});

		it("should handle invalid or inaccessible directories gracefully", async () => {
			mock({
				"./locales": mock.directory({
					mode: 0o000, // No read permissions
				}),
			});

			const files = await lokaliseUpload.collectFiles({
				inputDirs: ["./locales"],
			});
			expect(files).toEqual([]);
			expect(files).toHaveLength(0);
		});

		it("should return an empty array when no files match filters", async () => {
			const files = await lokaliseUpload.collectFiles({
				extensions: [".txt"],
				fileNamePattern: "^nonexistent.*",
			});
			expect(files).toEqual([]);
			expect(files).toHaveLength(0);
		});

		it("should process multiple input directories", async () => {
			mock({
				"./locales": {
					"en.json": '{"key": "value"}',
				},
				"./additional_locales": {
					"fr.json": '{"clé": "valeur"}',
				},
			});

			const files = await lokaliseUpload.collectFiles({
				inputDirs: ["./locales", "./additional_locales"],
			});
			const expectedFiles = [
				fullPath("./locales/en.json"),
				fullPath("./additional_locales/fr.json"),
			];
			expect(files).toEqual(expect.arrayContaining(expectedFiles));
			expect(files).toHaveLength(expectedFiles.length);
		});
	});
});
