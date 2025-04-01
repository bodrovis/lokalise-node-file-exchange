import fs from "node:fs";
import path from "node:path";
import mock from "mock-fs";
import { FakeLokaliseUpload } from "../../fixtures/fake_classes/FakeLokaliseUpload.js";
import { afterEach, beforeEach, describe, expect, it } from "../../setup.js";

describe("LokaliseUpload: processFile()", () => {
	const projectId = "803826145ba90b42d5d860.46800099";
	const apiKey = process.env.API_KEY as string;
	let lokaliseUpload: FakeLokaliseUpload;

	beforeEach(() => {
		mock({
			"/project/locales": {
				"en.json": '{"key": "value"}',
				"weird.fake_json": '{"en_GB": {"key": "value"}}',
				"fr_FR.json": '{"clé": "valeur"}',
				nested: {
					"es.json": '{"clave": "valor"}',
				},
			},
			"/project/other": {
				"de-DE.json": '{"schlüssel": "wert"}',
			},
		});

		lokaliseUpload = new FakeLokaliseUpload({ apiKey }, { projectId });
	});

	afterEach(() => {
		mock.restore();
	});

	describe("Basic Behavior", () => {
		it("should process a file and return correct ProcessedFile object for en.json", async () => {
			const result = await lokaliseUpload.processFile(
				"/project/locales/en.json",
				"/project",
			);
			expect(result).toEqual({
				data: Buffer.from('{"key": "value"}').toString("base64"),
				filename: path.posix.join("locales", "en.json"),
				lang_iso: "en",
			});
		});

		it("should process a file with complex filename and return correct ProcessedFile object", async () => {
			const result = await lokaliseUpload.processFile(
				"/project/locales/fr_FR.json",
				"/project",
			);
			expect(result).toEqual({
				data: Buffer.from('{"clé": "valeur"}').toString("base64"),
				filename: path.posix.join("locales", "fr_FR.json"),
				lang_iso: "fr_FR",
			});
		});

		it("should process a nested file and return correct ProcessedFile object", async () => {
			const result = await lokaliseUpload.processFile(
				"/project/locales/nested/es.json",
				"/project",
			);
			expect(result).toEqual({
				data: Buffer.from('{"clave": "valor"}').toString("base64"),
				filename: path.posix.join("locales", "nested", "es.json"),
				lang_iso: "es",
			});
		});

		it("should process a file from another directory and return correct ProcessedFile object", async () => {
			const result = await lokaliseUpload.processFile(
				"/project/other/de-DE.json",
				"/project",
			);
			expect(result).toEqual({
				data: Buffer.from('{"schlüssel": "wert"}').toString("base64"),
				filename: path.posix.join("other", "de-DE.json"),
				lang_iso: "de-DE",
			});
		});
	});

	describe("Filename Inferer", () => {
		it("should allow to set filename inferer", async () => {
			const result = await lokaliseUpload.processFile(
				"/project/locales/nested/es.json",
				"/project",
				undefined,
				(filePath) => {
					return filePath.split("/").at(-1) as string;
				},
			);
			expect(result).toEqual({
				data: Buffer.from('{"clave": "valor"}').toString("base64"),
				filename: "es.json",
				lang_iso: "es",
			});
		});

		it("should use default filename if the inferer throws", async () => {
			const result = await lokaliseUpload.processFile(
				"/project/locales/nested/es.json",
				"/project",
				undefined,
				(_filePath) => {
					throw Error();
				},
			);
			expect(result).toEqual({
				data: Buffer.from('{"clave": "valor"}').toString("base64"),
				filename: "locales/nested/es.json",
				lang_iso: "es",
			});
		});

		it("should use default filename if the inferer return an empty string", async () => {
			const result = await lokaliseUpload.processFile(
				"/project/locales/nested/es.json",
				"/project",
				undefined,
				(_filePath) => {
					return " ";
				},
			);
			expect(result).toEqual({
				data: Buffer.from('{"clave": "valor"}').toString("base64"),
				filename: "locales/nested/es.json",
				lang_iso: "es",
			});
		});
	});

	describe("Language Inferer", () => {
		it("should allow to set language inferer", async () => {
			const result = await lokaliseUpload.processFile(
				"/project/locales/weird.fake_json",
				"/project",
				async (filePath) => {
					const fileData = await fs.promises.readFile(filePath);
					const jsonContent = JSON.parse(fileData.toString());
					return Object.keys(jsonContent)[0];
				},
			);
			expect(result).toEqual({
				data: Buffer.from('{"en_GB": {"key": "value"}}').toString("base64"),
				filename: path.posix.join("locales", "weird.fake_json"),
				lang_iso: "en_GB",
			});
		});

		it("should use basename as the locale if the inferer throws", async () => {
			const result = await lokaliseUpload.processFile(
				"/project/locales/en.json",
				"/project",
				(_filePath) => {
					throw Error();
				},
			);
			expect(result).toEqual({
				data: Buffer.from('{"key": "value"}').toString("base64"),
				filename: path.posix.join("locales", "en.json"),
				lang_iso: "en",
			});
		});

		it("should use basename as the locale if the inferer returns an empty string", async () => {
			const result = await lokaliseUpload.processFile(
				"/project/locales/en.json",
				"/project",
				(_filePath) => {
					return "    ";
				},
			);
			expect(result).toEqual({
				data: Buffer.from('{"key": "value"}').toString("base64"),
				filename: path.posix.join("locales", "en.json"),
				lang_iso: "en",
			});
		});
	});
});
