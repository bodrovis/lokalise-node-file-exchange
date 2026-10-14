import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { processUploadFile } from "../../lib/processors/upload-file.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "../setup.js";

describe("processUploadFile()", () => {
	let projectRoot: string;

	beforeEach(async () => {
		projectRoot = await fs.mkdtemp(
			path.join(os.tmpdir(), "lokalise-upload-file-"),
		);
	});

	afterEach(async () => {
		await fs.rm(projectRoot, { recursive: true, force: true });
	});

	async function fixture(
		name: string,
		content: string | Buffer = "{}",
	): Promise<string> {
		const file = path.join(projectRoot, name);
		await fs.mkdir(path.dirname(file), { recursive: true });
		await fs.writeFile(file, content);
		return file;
	}

	describe("default inference and encoding", () => {
		it("returns a base64-encoded file with its relative name and language", async () => {
			const content = '{"message":"Привет 🌍"}';
			const file = await fixture("translations.en.json", content);

			await expect(processUploadFile(file, projectRoot)).resolves.toEqual({
				data: Buffer.from(content).toString("base64"),
				filename: "translations.en.json",
				lang_iso: "en",
			});
		});

		it("preserves nested paths with forward slashes", async () => {
			const file = await fixture(
				path.join("nested", "ui", "messages.pt-BR.json"),
			);

			const result = await processUploadFile(file, projectRoot);

			expect(result.filename).toBe("nested/ui/messages.pt-BR.json");
			expect(result.lang_iso).toBe("pt-BR");
		});

		it("infers the language from the segment before the final extension", async () => {
			const file = await fixture("messages.extra.fr.JSON");

			const result = await processUploadFile(file, projectRoot);

			expect(result.lang_iso).toBe("fr");
		});

		it("encodes binary bytes without UTF-8 conversion", async () => {
			const bytes = Buffer.from([0x00, 0xff, 0x80, 0x01, 0x0a]);
			const file = await fixture("asset.en.bin", bytes);

			const result = await processUploadFile(file, projectRoot);

			expect(result.data).toBe(bytes.toString("base64"));
			expect(Buffer.from(result.data, "base64")).toEqual(bytes);
		});

		it("handles an empty file", async () => {
			const file = await fixture("empty.en.json", "");

			const result = await processUploadFile(file, projectRoot);

			expect(result.data).toBe("");
			expect(result.filename).toBe("empty.en.json");
			expect(result.lang_iso).toBe("en");
		});
	});

	describe("custom inferers", () => {
		it("awaits the filename inferer and normalizes backslashes", async () => {
			const file = await fixture("source.en.json");
			const filenameInferer = vi.fn(
				async (_file: string) => "virtual\\labels.de.json",
			);

			const result = await processUploadFile(file, projectRoot, {
				filenameInferer,
			});

			expect(filenameInferer).toHaveBeenCalledTimes(1);
			expect(filenameInferer).toHaveBeenCalledWith(file);
			expect(result.filename).toBe("virtual/labels.de.json");
			expect(result.lang_iso).toBe("de");
		});

		it("awaits both inferers and uses an explicitly inferred language", async () => {
			const file = await fixture("source.en.json");
			const filenameInferer = vi.fn(async () => "custom/name.json");
			const languageInferer = vi.fn(async (_file: string) => "zh-Hant");

			const result = await processUploadFile(file, projectRoot, {
				filenameInferer,
				languageInferer,
			});

			expect(filenameInferer).toHaveBeenCalledTimes(1);
			expect(filenameInferer).toHaveBeenCalledWith(file);
			expect(languageInferer).toHaveBeenCalledTimes(1);
			expect(languageInferer).toHaveBeenCalledWith(file);
			expect(result.filename).toBe("custom/name.json");
			expect(result.lang_iso).toBe("zh-Hant");
		});

		it("uses the fallback filename when the custom filename is blank", async () => {
			const file = await fixture(path.join("nested", "messages.es.json"));

			const result = await processUploadFile(file, projectRoot, {
				filenameInferer: () => "  ",
			});

			expect(result.filename).toBe("nested/messages.es.json");
			expect(result.lang_iso).toBe("es");
		});

		it("uses the fallback language when the custom language is blank", async () => {
			const file = await fixture("messages.it.json");

			const result = await processUploadFile(file, projectRoot, {
				languageInferer: () => " \t ",
			});

			expect(result.lang_iso).toBe("it");
		});

		it("supports files without extensions when a custom language is supplied", async () => {
			const file = await fixture("README", "readme content");

			const result = await processUploadFile(file, projectRoot, {
				languageInferer: async () => "en",
			});

			expect(result.filename).toBe("README");
			expect(result.lang_iso).toBe("en");
			expect(result.data).toBe(
				Buffer.from("readme content").toString("base64"),
			);
		});

		it.each([42, null, false])(
			"rejects an invalid filenameInferer result (%s)",
			async (value) => {
				const file = await fixture("messages.en.json");

				await expect(
					processUploadFile(file, projectRoot, {
						filenameInferer: () => value as unknown as string,
					}),
				).rejects.toThrow("filenameInferer must return a string.");
			},
		);

		it.each([42, null, false])(
			"rejects an invalid languageInferer result (%s)",
			async (value) => {
				const file = await fixture("messages.en.json");

				await expect(
					processUploadFile(file, projectRoot, {
						languageInferer: () => value as unknown as string,
					}),
				).rejects.toThrow("languageInferer must return a string.");
			},
		);

		it("propagates filename inferer errors without calling the language inferer", async () => {
			const file = await fixture("messages.en.json");
			const error = new Error("Filename inference failed");
			const languageInferer = vi.fn(() => "en");

			await expect(
				processUploadFile(file, projectRoot, {
					filenameInferer: () => Promise.reject(error),
					languageInferer,
				}),
			).rejects.toBe(error);

			expect(languageInferer).not.toHaveBeenCalled();
		});

		it("propagates language inferer errors", async () => {
			const file = await fixture("messages.en.json");
			const error = new Error("Language inference failed");

			await expect(
				processUploadFile(file, projectRoot, {
					languageInferer: () => Promise.reject(error),
				}),
			).rejects.toBe(error);
		});
	});

	describe("invalid paths and files", () => {
		it.each(["messages", ".json", "messages..json"])(
			"rejects a filename without an inferable language: %s",
			async (name) => {
				const file = await fixture(name);

				await expect(processUploadFile(file, projectRoot)).rejects.toThrow(
					`Cannot infer language code from filename: ${name}`,
				);
			},
		);

		it("rejects a file outside the project root", async () => {
			const outsideDir = await fs.mkdtemp(
				path.join(os.tmpdir(), "lokalise-upload-outside-"),
			);

			try {
				const file = path.join(outsideDir, "messages.en.json");
				await fs.writeFile(file, "outside");

				await expect(processUploadFile(file, projectRoot)).rejects.toThrow(
					"File is outside the project root:",
				);
			} finally {
				await fs.rm(outsideDir, { recursive: true, force: true });
			}
		});

		it("rejects using the project root itself as a file", async () => {
			await expect(processUploadFile(projectRoot, projectRoot)).rejects.toThrow(
				"File is outside the project root:",
			);
		});

		it("propagates filesystem errors when a file disappears", async () => {
			const file = path.join(projectRoot, "missing.en.json");

			await expect(processUploadFile(file, projectRoot)).rejects.toMatchObject({
				code: "ENOENT",
			});
		});
	});
});
