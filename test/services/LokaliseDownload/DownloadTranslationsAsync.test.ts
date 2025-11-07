import fs from "node:fs";
import path from "node:path";
import type {
	DownloadedFileProcessDetails,
	FileFormat,
	QueuedProcess,
} from "@lokalise/node-api";
import mockFs from "mock-fs";
import { MockAgent, setGlobalDispatcher } from "undici";
import { LokaliseError } from "../../../lib/index.js";
import { FakeLokaliseDownload } from "../../fixtures/fake_classes/FakeLokaliseDownload.js";
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
	const extractParams = { outputDir: "/output/dir" };
	let downloader: FakeLokaliseDownload;
	const demoZipPath = path.resolve(
		__dirname,
		"../../fixtures/demo_archive.zip",
	);
	const mockOutputDir = "/output/dir";
	let mockAgent: MockAgent;
	let mockPool: Interceptable;
	const processId = "74738ff5-5367-5958-9aee-98fffdcd1876";

	beforeAll(() => {
		mockAgent = new MockAgent();
		setGlobalDispatcher(mockAgent);
		mockAgent.disableNetConnect();
	});

	beforeEach(() => {
		downloader = new FakeLokaliseDownload({ apiKey }, { projectId });
		mockFs({
			[demoZipPath]: fs.readFileSync(demoZipPath),
			[mockOutputDir]: {},
		});

		mockPool = mockAgent.get("https://api.lokalise.com");
	});

	afterEach(() => {
		vi.restoreAllMocks();
		mockFs.restore();
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

			const unlinkSpy = vi
				.spyOn(fs.promises, "unlink")
				.mockResolvedValue(undefined);

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

			expect(fs.existsSync("/output/dir/en/en.json")).toBe(true);
			expect(fs.existsSync("/output/dir/fr_CA/no_filename.json")).toBe(true);

			const jsonContent = JSON.parse(
				fs.readFileSync("/output/dir/fr_FR/fr_FR.json", "utf8"),
			);
			expect(jsonContent).toEqual({ welcome: "Bienvenue!" });

			expect(unlinkSpy).toHaveBeenCalledWith(demoZipPath);
			expect(downloadZipSpy).toHaveBeenCalledWith(fakeDownloadUrl, 10000);
		});
	});

	describe("Error Cases", () => {
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
				created_by: "20181",
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
				created_by: "20181",
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
				created_by: "20181",
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

		it("should throw an error if unpackZip fails but still attempt to clean up the ZIP file", async () => {
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
				created_by: "20181",
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
			const unlinkSpy = vi
				.spyOn(fs.promises, "unlink")
				.mockResolvedValue(undefined);

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

			expect(unlinkSpy).toHaveBeenCalledWith(demoZipPath);
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
				created_by: "20181",
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
