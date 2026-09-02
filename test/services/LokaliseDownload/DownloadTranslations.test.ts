import fs from "node:fs";
import path from "node:path";

import type { FileFormat, QueuedProcess } from "@lokalise/node-api";

import { LokaliseError } from "../../../lib/errors/LokaliseError.js";
import { FakeLokaliseDownload } from "../../fixtures/fake_classes/FakeLokaliseDownload.js";
import { createTestFs, type TestFs } from "../../helpers/testFs.js";
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

	const demoZipFixturePath = path.resolve(
		__dirname,
		"../../fixtures/demo_archive.zip",
	);

	const invalidZipFixturePath = path.resolve(
		__dirname,
		"../../fixtures/invalid_archive.zip",
	);

	let downloader: FakeLokaliseDownload;
	let testFs: TestFs;
	let restoreCwd: () => void;
	let demoZipPath: string;
	let invalidZipPath: string;
	let extractParams: { outputDir: string };

	beforeEach(async () => {
		testFs = await createTestFs({
			archives: {
				"demo_archive.zip": fs.readFileSync(demoZipFixturePath),
				"invalid_archive.zip": fs.readFileSync(invalidZipFixturePath),
			},
			output: {
				dir: {},
			},
		});

		restoreCwd = testFs.useAsCwd();

		demoZipPath = testFs.path("archives", "demo_archive.zip");
		invalidZipPath = testFs.path("archives", "invalid_archive.zip");
		extractParams = {
			outputDir: testFs.path("output", "dir"),
		};

		downloader = new FakeLokaliseDownload({ apiKey }, { projectId });
	});

	afterEach(async () => {
		vi.restoreAllMocks();

		restoreCwd();
		await testFs.cleanup();
	});

	describe("Success Cases", () => {
		it("should download, extract, and clean up translations successfully", async () => {
			vi.spyOn(downloader, "getTranslationsBundle").mockResolvedValue({
				bundle_url: "https://example.com/translations.zip",
				project_id: projectId,
			});

			vi.spyOn(downloader, "downloadZip").mockResolvedValue(demoZipPath);

			await expect(
				downloader.downloadTranslations({ downloadFileParams, extractParams }),
			).resolves.not.toThrow();

			expect(fs.existsSync(testFs.path("output", "dir", "en", "en.json"))).toBe(
				true,
			);

			expect(
				fs.existsSync(
					testFs.path("output", "dir", "fr_CA", "no_filename.json"),
				),
			).toBe(true);

			const jsonContent = JSON.parse(
				fs.readFileSync(
					testFs.path("output", "dir", "fr_FR", "fr_FR.json"),
					"utf8",
				),
			);

			expect(jsonContent).toEqual({ welcome: "Bienvenue!" });

			expect(fs.existsSync(demoZipPath)).toBe(false);
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

			await expect(
				downloader.downloadTranslations({ downloadFileParams, extractParams }),
			).rejects.toThrow("Extraction failed");

			expect(fs.existsSync(demoZipPath)).toBe(false);
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

			expect(fs.existsSync(invalidZipPath)).toBe(false);
		});

		it("should throw if async download process is not found after polling", async () => {
			const downloader = new FakeLokaliseDownload({ apiKey }, { projectId });

			const downloadProcess = {
				process_id: "proc-123",
				status: "queued",
				type: "file-import",
			} as unknown as QueuedProcess;

			vi.spyOn(downloader, "getTranslationsBundleAsync").mockResolvedValue(
				downloadProcess,
			);

			vi.spyOn(downloader, "pollProcesses").mockResolvedValue([
				{
					process_id: "another-id",
					status: "finished",
					type: "file-import",
				} as unknown as QueuedProcess,
			]);

			const downloadZipSpy = vi.spyOn(downloader, "downloadZip");

			await expect(
				downloader.downloadTranslations({
					downloadFileParams,
					extractParams,
					processDownloadFileParams: {
						asyncDownload: true,
						pollInitialWaitTime: 100,
						pollMaximumWaitTime: 1_000,
					},
				}),
			).rejects.toThrow(
				new LokaliseError(
					`Process ${downloadProcess.process_id} not found after polling`,
					500,
				),
			);

			expect(downloadZipSpy).not.toHaveBeenCalled();
		});

		it("should throw LokaliseError when async download process failed with message", async () => {
			const downloader = new FakeLokaliseDownload({ apiKey }, { projectId });

			const downloadProcess = {
				process_id: "proc-failed",
				status: "queued",
				type: "file-import",
			} as unknown as QueuedProcess;

			vi.spyOn(downloader, "getTranslationsBundleAsync").mockResolvedValue(
				downloadProcess,
			);

			vi.spyOn(downloader, "pollProcesses").mockResolvedValue([
				{
					process_id: "proc-failed",
					status: "failed",
					type: "file-import",
					message: "Something went wrong",
				} as unknown as QueuedProcess,
			]);

			const downloadZipSpy = vi.spyOn(downloader, "downloadZip");

			await expect(
				downloader.downloadTranslations({
					downloadFileParams,
					extractParams,
					processDownloadFileParams: {
						asyncDownload: true,
						pollInitialWaitTime: 100,
						pollMaximumWaitTime: 1000,
					},
				}),
			).rejects.toThrow(
				new LokaliseError(
					"Process proc-failed ended with status=failed: Something went wrong",
					502,
				),
			);

			expect(downloadZipSpy).not.toHaveBeenCalled();
		});

		it("should throw LokaliseError when async download process is cancelled without message", async () => {
			const downloader = new FakeLokaliseDownload({ apiKey }, { projectId });

			const downloadProcess = {
				process_id: "proc-cancelled",
				status: "queued",
				type: "file-import",
			} as unknown as QueuedProcess;

			vi.spyOn(downloader, "getTranslationsBundleAsync").mockResolvedValue(
				downloadProcess,
			);

			vi.spyOn(downloader, "pollProcesses").mockResolvedValue([
				{
					process_id: "proc-cancelled",
					status: "cancelled",
					type: "file-import",
				} as unknown as QueuedProcess,
			]);

			const downloadZipSpy = vi.spyOn(downloader, "downloadZip");

			await expect(
				downloader.downloadTranslations({
					downloadFileParams,
					extractParams,
					processDownloadFileParams: {
						asyncDownload: true,
						pollInitialWaitTime: 100,
						pollMaximumWaitTime: 1000,
					},
				}),
			).rejects.toThrow(
				new LokaliseError(
					"Process proc-cancelled ended with status=cancelled",
					502,
				),
			);

			expect(downloadZipSpy).not.toHaveBeenCalled();
		});
	});

	describe("Edge Cases", () => {
		it("should throw an error if the archive does not exist", async () => {
			vi.spyOn(downloader, "getTranslationsBundle").mockResolvedValue({
				bundle_url: "https://example.com/translations.zip",
				project_id: projectId,
			});

			const nonexistentZipPath = testFs.path("nonexistent", "translations.zip");

			vi.spyOn(downloader, "downloadZip").mockResolvedValue(nonexistentZipPath);

			await expect(
				downloader.downloadTranslations({ downloadFileParams, extractParams }),
			).rejects.toThrow(/ENOENT/);
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

			expect(fs.existsSync(testFs.path("en", "en.json"))).toBe(true);

			expect(fs.existsSync(demoZipPath)).toBe(false);
		});
	});
});
