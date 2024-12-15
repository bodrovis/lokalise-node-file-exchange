import fs from "node:fs";
import path from "node:path";
import type { FileFormat } from "@lokalise/node-api";
import mockFs from "mock-fs";
import { FakeLokaliseDownload } from "../../fixtures/fake_classes/FakeLokaliseDownload.js";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "../../setup.js";

describe("LokaliseDownload: downloadTranslations()", () => {
	const projectId = "803826145ba90b42d5d860.46800099";
	const apiKey = process.env.API_KEY as string;
	const downloadFileParams = { format: "json" as FileFormat };
	const extractParams = { outputDir: "/output/dir" };

	let downloader: FakeLokaliseDownload;
	const demoZipPath = path.resolve(
		__dirname,
		"../../fixtures/demo_archive.zip",
	);
	const invalidZipPath = path.resolve(
		__dirname,
		"../../fixtures/invalid_archive.zip",
	);
	const mockOutputDir = "/output/dir";

	beforeEach(() => {
		downloader = new FakeLokaliseDownload({ apiKey }, { projectId });
		mockFs({
			[demoZipPath]: fs.readFileSync(demoZipPath),
			[invalidZipPath]: fs.readFileSync(invalidZipPath),
			[mockOutputDir]: {},
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		mockFs.restore();
	});

	describe("Success Cases", () => {
		it("should download, extract, and clean up translations successfully", async () => {
			vi.spyOn(downloader, "getTranslationsBundle").mockResolvedValue({
				bundle_url: "https://example.com/translations.zip",
				project_id: projectId,
			});
			vi.spyOn(downloader, "downloadZip").mockResolvedValue(demoZipPath);
			const unlinkSpy = vi
				.spyOn(fs.promises, "unlink")
				.mockResolvedValue(undefined);

			await expect(
				downloader.downloadTranslations({ downloadFileParams, extractParams }),
			).resolves.not.toThrow();

			expect(fs.existsSync("/output/dir/en/en.json")).toBe(true);
			expect(fs.existsSync("/output/dir/fr_CA/no_filename.json")).toBe(true);

			const jsonContent = JSON.parse(
				fs.readFileSync("/output/dir/fr_FR/fr_FR.json", "utf8"),
			);
			expect(jsonContent).toEqual({ welcome: "Bienvenue!" });

			expect(unlinkSpy).toHaveBeenCalledWith(demoZipPath);
		});
	});

	describe("Error Cases", () => {
		it("should clean up the ZIP file even if extraction fails", async () => {
			vi.spyOn(downloader, "getTranslationsBundle").mockResolvedValue({
				bundle_url: "https://example.com/translations.zip",
				project_id: projectId,
			});
			vi.spyOn(downloader, "downloadZip").mockResolvedValue(demoZipPath);
			vi.spyOn(downloader, "unpackZip").mockRejectedValue(
				new Error("Extraction failed"),
			);

			const unlinkSpy = vi
				.spyOn(fs.promises, "unlink")
				.mockResolvedValue(undefined);

			await expect(
				downloader.downloadTranslations({ downloadFileParams, extractParams }),
			).rejects.toThrow("Extraction failed");

			expect(unlinkSpy).toHaveBeenCalledWith(demoZipPath);
		});

		it("should throw an error if the file is not a valid ZIP archive", async () => {
			vi.spyOn(downloader, "getTranslationsBundle").mockResolvedValue({
				bundle_url: "https://example.com/translations.zip",
				project_id: "test-project-id",
			});
			vi.spyOn(downloader, "downloadZip").mockResolvedValue(invalidZipPath);

			await expect(
				downloader.downloadTranslations({ downloadFileParams, extractParams }),
			).rejects.toThrow(
				"End of central directory record signature not found. Either not a zip file, or file is truncated.",
			);
		});
	});

	describe("Edge Cases", () => {
		it("should throw an error if the archive does not exist", async () => {
			vi.spyOn(downloader, "getTranslationsBundle").mockResolvedValue({
				bundle_url: "https://example.com/translations.zip",
				project_id: projectId,
			});
			const nonexistentZipPath = "/nonexistent/path/to/translations.zip";
			vi.spyOn(downloader, "downloadZip").mockResolvedValue(nonexistentZipPath);

			await expect(
				downloader.downloadTranslations({ downloadFileParams, extractParams }),
			).rejects.toThrow(
				`ENOENT, no such file or directory '${nonexistentZipPath}'`,
			);
		});

		it("should handle missing extractParams gracefully", async () => {
			vi.spyOn(downloader, "getTranslationsBundle").mockResolvedValue({
				bundle_url: "https://example.com/translations.zip",
				project_id: projectId,
			});
			vi.spyOn(downloader, "downloadZip").mockResolvedValue(demoZipPath);

			await expect(
				downloader.downloadTranslations({ downloadFileParams }),
			).resolves.not.toThrow();

			expect(fs.existsSync("./en/en.json")).toBe(true); // Default outputDir "./"
		});
	});
});
