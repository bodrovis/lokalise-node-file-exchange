import fs from "node:fs";
import path from "node:path";
import type { FileFormat } from "@lokalise/node-api";
import mockFs from "mock-fs";
import { LokaliseDownload } from "../../../lib/services/LokaliseDownload.js";
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

	let downloader: LokaliseDownload;
	const demoZipPath = path.resolve(
		__dirname,
		"../../fixtures/demo_archive.zip",
	);
	const invalidZipPath = path.resolve(
		__dirname,
		"../../fixtures/invalid_archive.zip",
	);

	beforeEach(() => {
		downloader = new LokaliseDownload({ apiKey }, { projectId });
		mockFs({
			[demoZipPath]: fs.readFileSync(demoZipPath),
			[invalidZipPath]: fs.readFileSync(invalidZipPath),
			"/output/dir": {},
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		mockFs.restore();
	});

	it("should download, extract, and clean up translations successfully", async () => {
		const mockGetTranslationsBundle = vi
			.spyOn(downloader, "getTranslationsBundle")
			.mockResolvedValue({
				bundle_url: "https://example.com/translations.zip",
				project_id: projectId,
			});

		const mockDownloadZip = vi
			.spyOn(downloader, "downloadZip")
			.mockResolvedValue(demoZipPath);

		const mockUnlink = vi
			.spyOn(fs.promises, "unlink")
			.mockResolvedValue(undefined);

		await expect(
			downloader.downloadTranslations({ downloadFileParams, extractParams }),
		).resolves.not.toThrow();

		expect(mockGetTranslationsBundle).toHaveBeenCalledWith(downloadFileParams);
		expect(mockDownloadZip).toHaveBeenCalledWith(
			"https://example.com/translations.zip",
		);
		expect(mockUnlink).toHaveBeenCalledWith(demoZipPath);

		expect(fs.existsSync("/output/dir/en/en.json")).toBe(true);
		expect(fs.existsSync("/output/dir/fr_CA/no_filename.json")).toBe(true);

		const jsonContent = JSON.parse(
			fs.readFileSync("/output/dir/fr_FR/fr_FR.json", "utf8"),
		);
		expect(jsonContent).toEqual({
			welcome: "Bienvenue!",
		});
	});

	it("should download, extract, and clean up translations successfully with mocked data", async () => {
		// Mock dependencies
		const mockGetTranslationsBundle = vi
			.spyOn(downloader, "getTranslationsBundle")
			.mockResolvedValue({
				bundle_url: "https://example.com/translations.zip",
				project_id: projectId,
			});

		const mockDownloadZip = vi
			.spyOn(downloader, "downloadZip")
			.mockResolvedValue("/mock/path/to/translations.zip");

		const mockUnpackZip = vi
			.spyOn(downloader, "unpackZip")
			.mockResolvedValue(undefined);

		const mockUnlink = vi
			.spyOn(fs.promises, "unlink")
			.mockResolvedValue(undefined);

		// Call the function under test
		await expect(
			downloader.downloadTranslations({ downloadFileParams }),
		).resolves.not.toThrow();

		// Assertions
		expect(mockGetTranslationsBundle).toHaveBeenCalledWith(downloadFileParams);
		expect(mockDownloadZip).toHaveBeenCalledWith(
			"https://example.com/translations.zip",
		);
		expect(mockUnpackZip).toHaveBeenCalledWith(
			"/mock/path/to/translations.zip",
			"./locales",
		);
		expect(mockUnlink).toHaveBeenCalledWith("/mock/path/to/translations.zip");
	});

	it("should clean up the ZIP file even if extraction fails", async () => {
		vi.spyOn(downloader, "getTranslationsBundle").mockResolvedValue({
			bundle_url: "https://example.com/translations.zip",
			project_id: projectId,
		});

		vi.spyOn(downloader, "downloadZip").mockResolvedValue(
			"/mock/path/to/translations.zip",
		);

		vi.spyOn(downloader, "unpackZip").mockRejectedValue(
			new Error("Extraction failed"),
		);

		const mockUnlink = vi
			.spyOn(fs.promises, "unlink")
			.mockResolvedValue(undefined);

		await expect(
			downloader.downloadTranslations({ downloadFileParams, extractParams }),
		).rejects.toThrow("Extraction failed");

		expect(mockUnlink).toHaveBeenCalledWith("/mock/path/to/translations.zip");
	});

	it("should throw an error if the archive does not exist", async () => {
		const mockGetTranslationsBundle = vi
			.spyOn(downloader, "getTranslationsBundle")
			.mockResolvedValue({
				bundle_url: "https://example.com/translations.zip",
				project_id: "test-project-id",
			});

		// Mock downloadZip to return a path to a non-existent file
		const nonexistentZipPath = "/nonexistent/path/to/translations.zip";
		const mockDownloadZip = vi
			.spyOn(downloader, "downloadZip")
			.mockResolvedValue(nonexistentZipPath);

		const mockUnlink = vi
			.spyOn(fs.promises, "unlink")
			.mockResolvedValue(undefined);

		// Call the function and expect it to throw an error
		await expect(
			downloader.downloadTranslations({
				downloadFileParams,
				extractParams,
			}),
		).rejects.toThrow(
			`ENOENT, no such file or directory '${nonexistentZipPath}'`,
		);

		// Verify interactions
		expect(mockGetTranslationsBundle).toHaveBeenCalledWith(downloadFileParams);
		expect(mockDownloadZip).toHaveBeenCalledWith(
			"https://example.com/translations.zip",
		);

		// Ensure cleanup was attempted
		expect(mockUnlink).toHaveBeenCalledWith(nonexistentZipPath);
	});

	it("should throw an error if the file is not a valid ZIP archive", async () => {
		const mockGetTranslationsBundle = vi
			.spyOn(downloader, "getTranslationsBundle")
			.mockResolvedValue({
				bundle_url: "https://example.com/translations.zip",
				project_id: "test-project-id",
			});

		const mockDownloadZip = vi
			.spyOn(downloader, "downloadZip")
			.mockResolvedValue(invalidZipPath);

		const mockUnlink = vi
			.spyOn(fs.promises, "unlink")
			.mockResolvedValue(undefined);

		// Call the function and expect it to throw a ZIP-specific error
		await expect(
			downloader.downloadTranslations({ downloadFileParams, extractParams }),
		).rejects.toThrow(
			"End of central directory record signature not found. Either not a zip file, or file is truncated.",
		);

		// Verify interactions
		expect(mockGetTranslationsBundle).toHaveBeenCalledWith(downloadFileParams);
		expect(mockDownloadZip).toHaveBeenCalledWith(
			"https://example.com/translations.zip",
		);

		// Ensure cleanup was performed
		expect(mockUnlink).toHaveBeenCalledWith(invalidZipPath);
	});
});
