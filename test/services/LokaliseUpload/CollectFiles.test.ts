import path from "node:path";
import mock from "mock-fs";
import { LokaliseUpload } from "../../../lib/services/LokaliseUpload.js";
import { afterEach, beforeEach, describe, expect, it } from "../../setup.js";

describe("collectFiles", () => {
	const projectId = "803826145ba90b42d5d860.46800099";
	const apiKey = process.env.API_KEY as string;
	let lokaliseUpload: LokaliseUpload;

	beforeEach(() => {
		lokaliseUpload = new LokaliseUpload({ apiKey }, { projectId });

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

	it("should filter files by fileNamePattern", async () => {
		const files = await lokaliseUpload.collectFiles({
			fileNamePattern: "^en.*",
		});
		const expectedFiles = [fullPath("./locales/en.json")];
		expect(files).toEqual(expect.arrayContaining(expectedFiles));
		expect(files).toHaveLength(expectedFiles.length);
	});
});
