import path from "node:path";
import mock from "mock-fs";
import { FakeLokaliseUpload } from "../../fixtures/fake_classes/FakeLokaliseUpload.js";
import { afterEach, beforeEach, describe, expect, it } from "../../setup.js";

describe("collectFiles", () => {
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

	it("should collect all JSON files recursively by default", async () => {
		const files = await lokaliseUpload.fakeCollectFiles();
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

	it("should respect the excludePatterns option", async () => {
		const files = await lokaliseUpload.fakeCollectFiles({
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

	it("should filter files by extensions", async () => {
		const files = await lokaliseUpload.fakeCollectFiles({
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

	it("should handle non-recursive mode", async () => {
		const files = await lokaliseUpload.fakeCollectFiles({
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

	it("should filter files by fileNamePattern", async () => {
		const files = await lokaliseUpload.fakeCollectFiles({
			fileNamePattern: "^en.*",
		});
		const expectedFiles = [fullPath("./locales/en.json")];
		expect(files).toEqual(expect.arrayContaining(expectedFiles));
		expect(files).toHaveLength(expectedFiles.length);
	});

	it("should filter files by both fileNamePattern and extensions", async () => {
		const files = await lokaliseUpload.fakeCollectFiles({
			extensions: [".json"],
			fileNamePattern: "^en.*",
		});
		const expectedFiles = [fullPath("./locales/en.json")];
		expect(files).toEqual(expect.arrayContaining(expectedFiles));
		expect(files).toHaveLength(expectedFiles.length);
	});

	it("should exclude directories and apply file filters simultaneously", async () => {
		const excludePattern = fullPath("./locales/subdir");
		const files = await lokaliseUpload.fakeCollectFiles({
			excludePatterns: [excludePattern],
			extensions: [".json"],
		});
		const expectedFiles = [
			fullPath("./locales/en.json"),
			fullPath("./locales/fr.json"),
		];

		expect(files).toEqual(expect.arrayContaining(expectedFiles));
		expect(files).toHaveLength(expectedFiles.length);
	});

	it("should return an empty array when no files match filters", async () => {
		const files = await lokaliseUpload.fakeCollectFiles({
			extensions: [".txt"],
			fileNamePattern: "^nonexistent.*",
		});
		expect(files).toEqual([]);
		expect(files).toHaveLength(0);
	});

	it("should handle invalid or inaccessible directories gracefully", async () => {
		mock({
			"./locales": mock.directory({
				mode: 0o000, // No read permissions
			}),
		});

		const files = await lokaliseUpload.fakeCollectFiles({
			inputDirs: ["./locales"],
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

		const files = await lokaliseUpload.fakeCollectFiles({
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