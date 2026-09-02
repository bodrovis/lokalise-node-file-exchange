import fs from "node:fs";
import path from "node:path";

import type {
	DownloadedFileProcessDetails,
	FileFormat,
	QueuedProcess,
} from "@lokalise/node-api";
import { MockAgent, setGlobalDispatcher } from "undici";

import { LokaliseError } from "../../../lib/index.js";
import { FakeLokaliseDownload } from "../../fixtures/fake_classes/FakeLokaliseDownload.js";
import { createTestFs, type TestFs } from "../../helpers/testFs.js";
import type { Interceptable } from "../../setup.js";
import {
	afterAll,
	afterEach,
	beforeAll,
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

	let downloader: FakeLokaliseDownload;
	let testFs: TestFs;
	let demoZipPath: string;
	let extractParams: { outputDir: string };

	let mockAgent: MockAgent;
	let mockPool: Interceptable;

	const processId = "74738ff5-5367-5958-9aee-98fffdcd1876";

	beforeAll(() => {
		mockAgent = new MockAgent();
		setGlobalDispatcher(mockAgent);
		mockAgent.disableNetConnect();
	});

	beforeEach(async () => {
		testFs = await createTestFs({
			archives: {
				"demo_archive.zip": fs.readFileSync(demoZipFixturePath),
			},
			output: {
				dir: {},
			},
		});

		demoZipPath = testFs.path("archives", "demo_archive.zip");

		extractParams = {
			outputDir: testFs.path("output", "dir"),
		};

		downloader = new FakeLokaliseDownload({ apiKey }, { projectId });

		mockPool = mockAgent.get("https://api.lokalise.com");
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await testFs.cleanup();
	});

	afterAll(() => {
		mockAgent.close();
	});

	describe("Success Cases", () => {
		it("should download, extract, and clean up translations successfully", async () => {
			const mockResponse = {
				process_id: processId,
			};

			const fakeDownloadUrl = "https://example.com/fake.zip";

			mockPool
				.intercept({
					path: `/api2/projects/${projectId}/files/async-download`,
					method: "POST",
					body: JSON.stringify(downloadFileParams),
				})
				.reply(200, mockResponse);

			mockPool
				.intercept({
					method: "GET",
					path: `/api2/projects/${projectId}/processes/${processId}`,
				})
				.reply(() => {
					return {
						statusCode: 200,
						data: {
							process: {
								process_id: processId,
								status: "finished",
								details: {
									download_url: fakeDownloadUrl,
								},
							},
						},
					};
				})
				.times(1);

			const downloadZipSpy = vi
				.spyOn(downloader, "downloadZip")
				.mockResolvedValue(demoZipPath);

			await downloader.downloadTranslations({
				downloadFileParams,
				extractParams,
				processDownloadFileParams: {
					asyncDownload: true,
					pollInitialWaitTime: 500,
					pollMaximumWaitTime: 5000,
					bundleDownloadTimeout: 10000,
				},
			});

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

			expect(downloadZipSpy).toHaveBeenCalledWith(fakeDownloadUrl, 10000);
		});
	});

	describe("Error Cases", () => {
		it("should handle unknown statuses for async processes", async () => {
			const finishedProcess: QueuedProcess = {
				process_id: processId,
				status: "invalid",
				details: {
					download_url: "",
					file_size_kb: 0,
					total_number_of_keys: 0,
				},
				type: "file-import",
				message: "",
				created_by: 20181,
				created_by_email: "bodrovis@protonmail.com",
				created_at: "2023-09-19 13:26:18 (Etc/UTC)",
				created_at_timestamp: 1695129978,
			};
			vi.spyOn(downloader, "getTranslationsBundleAsync").mockResolvedValue(
				finishedProcess,
			);
			vi.spyOn(downloader, "pollAsyncDownload").mockResolvedValue(
				finishedProcess,
			);
			const loggerSpy = vi.spyOn(downloader, "logMsg").mockResolvedValue();

			await expect(
				downloader.fetchBundleURLAsync(
					{ format: "json" },
					{
						asyncDownload: false,
						pollInitialWaitTime: 1000,
						pollMaximumWaitTime: 120_000,
						bundleDownloadTimeout: 0,
					},
				),
			).rejects.toThrow(
				"Download process did not finish within 120000ms (last status=invalid)",
			);

			expect(loggerSpy).toHaveBeenCalledWith(
				"debug",
				`Download process status is invalid`,
			);
		});

		it("should return the matching process when status is missing", async () => {
			const exchanger = new FakeLokaliseDownload(
				{ apiKey: "abc123" },
				{ projectId: "123.abc" },
			);

			const downloadProcess = {
				process_id: "proc-123",
				status: "queued",
			} as QueuedProcess;

			const polledProcess = {
				process_id: "proc-123",
			} as QueuedProcess;

			vi.spyOn(exchanger, "pollProcesses").mockResolvedValue([polledProcess]);

			await expect(
				exchanger.pollAsyncDownload(downloadProcess, 100, 1000),
			).resolves.toBe(polledProcess);
		});

		it("should throw when download process status is missing after polling", async () => {
			const exchanger = new FakeLokaliseDownload(
				{ apiKey: "abc123" },
				{ projectId: "123.abc" },
			);

			const downloadProcess = {
				process_id: "proc-123",
				status: "queued",
			} as QueuedProcess;

			const polledProcess = {
				process_id: "proc-123",
			} as QueuedProcess;

			vi.spyOn(exchanger, "getTranslationsBundleAsync").mockResolvedValue(
				downloadProcess,
			);

			vi.spyOn(exchanger, "pollAsyncDownload").mockResolvedValue(polledProcess);

			await expect(
				exchanger.fetchBundleURLAsync(
					{ format: "json" },
					{
						asyncDownload: true,
						pollInitialWaitTime: 100,
						pollMaximumWaitTime: 1000,
						bundleDownloadTimeout: 0,
					},
				),
			).rejects.toThrow(
				"Download process did not finish within 1000ms (status missing)",
			);
		});

		it("should throw an error if the async download process does not finish in time", async () => {
			const mockResponse = {
				process_id: processId,
			};

			mockPool
				.intercept({
					path: `/api2/projects/${projectId}/files/async-download`,
					method: "POST",
					body: JSON.stringify(downloadFileParams),
				})
				.reply(200, mockResponse);

			const incompleteProcess: QueuedProcess = {
				process_id: processId,
				status: "running",
				details: {} as DownloadedFileProcessDetails,
				type: "file-import",
				message: "",
				created_by: 20181,
				created_by_email: "bodrovis@protonmail.com",
				created_at: "2023-09-19 13:26:18 (Etc/UTC)",
				created_at_timestamp: 1695129978,
			};

			vi.spyOn(downloader, "pollProcesses").mockResolvedValue([
				incompleteProcess,
			]);

			const pollMaximumWaitTime = 100;

			await expect(
				downloader.downloadTranslations({
					downloadFileParams,
					extractParams,
					processDownloadFileParams: {
						asyncDownload: true,
						pollInitialWaitTime: 1,
						pollMaximumWaitTime,
					},
				}),
			).rejects.toThrow(
				`Download process did not finish within ${pollMaximumWaitTime}ms (last status=running)`,
			);
		});

		it("should throw an error if async download process finishes without a download URL", async () => {
			const mockResponse = {
				process_id: processId,
			};

			mockPool
				.intercept({
					path: `/api2/projects/${projectId}/files/async-download`,
					method: "POST",
					body: JSON.stringify(downloadFileParams),
				})
				.reply(200, mockResponse);

			const finishedNoUrlProcess = {
				process_id: processId,
				status: "finished",
				details: {} as DownloadedFileProcessDetails, // missing download_url
				type: "file-import",
				message: "",
				created_by: 20181,
				created_by_email: "bodrovis@protonmail.com",
				created_at: "2023-09-19 13:26:18 (Etc/UTC)",
				created_at_timestamp: 1695129978,
			};
			vi.spyOn(downloader, "pollProcesses").mockResolvedValue([
				finishedNoUrlProcess,
			]);

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
				"Lokalise returned finished process without a valid download_url",
			);
		});

		it("should throw an error if downloadZip fails", async () => {
			const mockResponse = {
				process_id: processId,
			};

			mockPool
				.intercept({
					path: `/api2/projects/${projectId}/files/async-download`,
					method: "POST",
					body: JSON.stringify(downloadFileParams),
				})
				.reply(200, mockResponse);

			const finishedProcess = {
				process_id: processId,
				status: "finished",
				details: {
					download_url: "https://example.com/fake.zip",
					file_size_kb: 1,
					total_number_of_keys: 3,
				},
				type: "file-import",
				message: "",
				created_by: 20181,
				created_by_email: "bodrovis@protonmail.com",
				created_at: "2023-09-19 13:26:18 (Etc/UTC)",
				created_at_timestamp: 1695129978,
			};
			vi.spyOn(downloader, "pollProcesses").mockResolvedValue([
				finishedProcess,
			]);
			vi.spyOn(downloader, "downloadZip").mockRejectedValue(
				new LokaliseError("Download failed", 500),
			);

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
			).rejects.toThrow("Download failed");
		});

		it("should clean up the ZIP file if unpackZip fails", async () => {
			const mockResponse = {
				process_id: processId,
			};

			mockPool
				.intercept({
					path: `/api2/projects/${projectId}/files/async-download`,
					method: "POST",
					body: JSON.stringify(downloadFileParams),
				})
				.reply(200, mockResponse);

			const finishedProcess = {
				process_id: processId,
				status: "finished",
				details: {
					download_url: "https://example.com/fake.zip",
					file_size_kb: 1,
					total_number_of_keys: 3,
				},
				type: "file-import",
				message: "",
				created_by: 20181,
				created_by_email: "bodrovis@protonmail.com",
				created_at: "2023-09-19 13:26:18 (Etc/UTC)",
				created_at_timestamp: 1695129978,
			};

			vi.spyOn(downloader, "pollProcesses").mockResolvedValue([
				finishedProcess,
			]);

			vi.spyOn(downloader, "downloadZip").mockResolvedValue(demoZipPath);

			vi.spyOn(downloader, "unpackZip").mockRejectedValue(
				new LokaliseError("Extraction failed", 500),
			);

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
			).rejects.toThrow("Extraction failed");

			expect(fs.existsSync(demoZipPath)).toBe(false);
		});

		it("should throw an error if the download URL is invalid", async () => {
			const mockResponse = {
				process_id: processId,
			};

			const url = "ftp://example.com/fake.zip";

			mockPool
				.intercept({
					path: `/api2/projects/${projectId}/files/async-download`,
					method: "POST",
					body: JSON.stringify(downloadFileParams),
				})
				.reply(200, mockResponse);

			const finishedProcess = {
				process_id: processId,
				status: "finished",
				details: {
					download_url: url,
					file_size_kb: 1,
					total_number_of_keys: 3,
				},
				type: "file-import",
				message: "",
				created_by: 20181,
				created_by_email: "bodrovis@protonmail.com",
				created_at: "2023-09-19 13:26:18 (Etc/UTC)",
				created_at_timestamp: 1695129978,
			};
			vi.spyOn(downloader, "pollProcesses").mockResolvedValue([
				finishedProcess,
			]);

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
			).rejects.toThrow(`Unsupported protocol in URL: ${url}`);
		});
	});
});
