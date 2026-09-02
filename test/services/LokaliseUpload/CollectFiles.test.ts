import { FakeLokaliseUpload } from "../../fixtures/fake_classes/FakeLokaliseUpload.js";
import { createTestFs, type TestFs } from "../../helpers/testFs.js";
import { afterEach, beforeEach, describe, expect, it } from "../../setup.js";

describe("LokaliseUpload: collectFiles()", () => {
	const projectId = "803826145ba90b42d5d860.46800099";
	const apiKey = process.env.API_KEY as string;

	let lokaliseUpload: FakeLokaliseUpload;
	let testFs: TestFs;
	let restoreCwd: () => void;

	beforeEach(async () => {
		testFs = await createTestFs({
			locales: {
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
			node_modules: {
				"module.js": "// This should be excluded",
			},
			dist: {
				"build.json": '{"build": true}',
			},
		});

		restoreCwd = testFs.useAsCwd();

		lokaliseUpload = new FakeLokaliseUpload({ apiKey }, { projectId });
	});

	afterEach(async () => {
		restoreCwd();
		await testFs.cleanup();
	});

	describe("General Behavior", () => {
		it("should collect all files recursively by default", async () => {
			const files = await lokaliseUpload.collectFiles();

			const expectedFiles = [
				testFs.path("locales", "en.json"),
				testFs.path("locales", "fr.json"),
				testFs.path("locales", "backup.txt"),
				testFs.path("locales", "subdir", "es.json"),
				testFs.path("locales", "subdir", "nested", "de.json"),
				testFs.path("locales", "subdir", "nested", "ignored.js"),
			];

			expect(files).toEqual(expect.arrayContaining(expectedFiles));
			expect(files).toHaveLength(expectedFiles.length);
		});

		it("should handle non-recursive mode", async () => {
			const files = await lokaliseUpload.collectFiles({
				recursive: false,
			});

			const expectedFiles = [
				testFs.path("locales", "en.json"),
				testFs.path("locales", "fr.json"),
				testFs.path("locales", "backup.txt"),
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
				testFs.path("locales", "en.json"),
				testFs.path("locales", "fr.json"),
				testFs.path("locales", "subdir", "es.json"),
				testFs.path("locales", "subdir", "nested", "de.json"),
			];

			expect(files).toEqual(expect.arrayContaining(expectedFiles));
			expect(files).toHaveLength(expectedFiles.length);
		});

		it("should handle mixed file extensions correctly", async () => {
			const files = await lokaliseUpload.collectFiles({
				extensions: [".json", "JS"],
			});

			const expectedFiles = [
				testFs.path("locales", "en.json"),
				testFs.path("locales", "fr.json"),
				testFs.path("locales", "subdir", "es.json"),
				testFs.path("locales", "subdir", "nested", "de.json"),
				testFs.path("locales", "subdir", "nested", "ignored.js"),
			];

			expect(files).toEqual(expect.arrayContaining(expectedFiles));
			expect(files).toHaveLength(expectedFiles.length);
		});

		it("should filter files by fileNamePattern", async () => {
			const files = await lokaliseUpload.collectFiles({
				fileNamePattern: "^en.*",
			});

			const expectedFiles = [testFs.path("locales", "en.json")];

			expect(files).toEqual(expect.arrayContaining(expectedFiles));
			expect(files).toHaveLength(expectedFiles.length);
		});

		it("should filter files by both fileNamePattern and extensions", async () => {
			const files = await lokaliseUpload.collectFiles({
				extensions: [".json"],
				fileNamePattern: /^en.*/,
			});

			const expectedFiles = [testFs.path("locales", "en.json")];

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
				testFs.path("locales", "en.json"),
				testFs.path("locales", "fr.json"),
				testFs.path("locales", "subdir", "es.json"),
			];

			expect(files).toEqual(expect.arrayContaining(expectedFiles));
			expect(files).toHaveLength(expectedFiles.length);
		});

		it("should exclude directories and apply file filters simultaneously", async () => {
			const files = await lokaliseUpload.collectFiles({
				excludePatterns: [/locales\\subdir/, /locales\/subdir/, /en\.json$/i],
				extensions: [".json"],
			});

			const expectedFiles = [testFs.path("locales", "fr.json")];

			expect(files).toEqual(expect.arrayContaining(expectedFiles));
			expect(files).toHaveLength(expectedFiles.length);
		});

		it("should consistently apply a global exclude pattern to multiple files", async () => {
			await testFs.write(
				{
					"one.json": "{}",
					"two.json": "{}",
					"three.txt": "text",
				},
				"global-exclude",
			);

			const files = await lokaliseUpload.collectFiles({
				inputDirs: [testFs.path("global-exclude")],
				excludePatterns: [/\.json$/g],
			});

			expect(files).toEqual([testFs.path("global-exclude", "three.txt")]);
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
			).rejects.toThrow(
				"Invalid excludePatterns: Invalid regular expression: /[invalid(/: Unterminated character class",
			);
		});

		it("should consistently apply a global filename pattern to multiple files", async () => {
			await testFs.write(
				{
					"one.json": "{}",
					"two.json": "{}",
					"three.json": "{}",
					"ignored.txt": "text",
				},
				"global-regex",
			);

			const files = await lokaliseUpload.collectFiles({
				inputDirs: [testFs.path("global-regex")],
				fileNamePattern: /\.json$/g,
			});

			expect(files).toEqual([
				testFs.path("global-regex", "one.json"),
				testFs.path("global-regex", "three.json"),
				testFs.path("global-regex", "two.json"),
			]);
		});

		it("should throw an error for excludePatterns when a non-Error is thrown", async () => {
			const badPattern = {
				toString() {
					throw "NON_ERROR";
				},
			} as unknown as RegExp;

			await expect(
				lokaliseUpload.collectFiles({
					excludePatterns: [badPattern],
				}),
			).rejects.toThrow("Invalid excludePatterns: NON_ERROR");
		});

		it("should handle invalid directories gracefully", async () => {
			const files = await lokaliseUpload.collectFiles({
				inputDirs: [testFs.path("does-not-exist")],
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
			await testFs.write({
				additional_locales: {
					"fr.json": '{"clé": "valeur"}',
				},
			});

			const files = await lokaliseUpload.collectFiles({
				inputDirs: ["./locales", "./additional_locales"],
			});

			const expectedFiles = [
				testFs.path("locales", "en.json"),
				testFs.path("locales", "fr.json"),
				testFs.path("locales", "backup.txt"),
				testFs.path("locales", "subdir", "es.json"),
				testFs.path("locales", "subdir", "nested", "de.json"),
				testFs.path("locales", "subdir", "nested", "ignored.js"),
				testFs.path("additional_locales", "fr.json"),
			];

			expect(files).toEqual(expect.arrayContaining(expectedFiles));
			expect(files).toHaveLength(expectedFiles.length);
		});
	});
});
