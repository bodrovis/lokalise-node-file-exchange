import fs from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
	DownloadBundle,
	DownloadFileParams,
	QueuedProcess,
} from "@lokalise/node-api";
import { type Mock, vi } from "vitest";
import { downloadBundleZip } from "../../../lib/downloaders/bundle-downloader.js";
import type { LokaliseError } from "../../../lib/errors/LokaliseError.js";
import { unpackZip } from "../../../lib/extractors/zip-extractor.js";
import { pollLokaliseProcesses } from "../../../lib/processes/poll-lokalise-processes.js";
import { LokaliseDownload } from "../../../lib/services/LokaliseDownload.js";
import { afterEach, beforeEach, describe, expect, it } from "../../setup.js";

type LogFn = (level: string, message: string, error?: unknown) => void;

let logSpy: Mock<LogFn>;

vi.mock(
	"../../../lib/downloaders/bundle-downloader.js",
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import("../../../lib/downloaders/bundle-downloader.js")
		>()),
		downloadBundleZip: vi.fn(),
	}),
);

vi.mock(
	"../../../lib/processes/poll-lokalise-processes.js",
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import("../../../lib/processes/poll-lokalise-processes.js")
		>()),
		pollLokaliseProcesses: vi.fn(),
	}),
);

vi.mock("../../../lib/extractors/zip-extractor.js", () => ({
	unpackZip: vi.fn(),
}));

const apiKey = "test-api-key";
const projectId = "803826145ba90b42d5d860.46800099";
const processId = "download-process-123";
const archiveUrl = "https://example.com/download.zip";
const downloadFileParams: DownloadFileParams = { format: "json" };

const queued = {
	process_id: processId,
	type: "async-export",
	status: "queued",
} as QueuedProcess;

class TestDownload extends LokaliseDownload {
	protected override async getTranslationsBundle(
		_params: DownloadFileParams,
	): Promise<DownloadBundle> {
		return {
			project_id: projectId,
			bundle_url: archiveUrl,
			responseTooBig: false,
		} as DownloadBundle;
	}

	protected override async getTranslationsBundleAsync(
		_params: DownloadFileParams,
	): Promise<QueuedProcess> {
		return queued;
	}

	// Protected method exposed solely for targeted branch tests.
	pollForTest(process: QueuedProcess): Promise<QueuedProcess> {
		return this.pollAsyncDownload(process, 1, 1_000);
	}
}

type LoggableDownload = {
	logMsg: (level: string, message: string, error?: unknown) => void;
};

describe("LokaliseDownload: warning forwarding and defensive branches", () => {
	let directory: string;
	let zipPath: string;
	let downloader: TestDownload;

	beforeEach(async () => {
		vi.mocked(downloadBundleZip).mockReset();
		vi.mocked(pollLokaliseProcesses).mockReset();
		vi.mocked(unpackZip).mockReset().mockResolvedValue(undefined);

		directory = await mkdtemp(
			path.join(tmpdir(), "lokalise-download-warning-"),
		);

		zipPath = path.join(directory, "bundle.zip");
		await writeFile(zipPath, "mock archive contents");

		downloader = new TestDownload({ apiKey }, { projectId });

		logSpy = vi.fn<LogFn>();

		vi.spyOn(
			downloader as unknown as LoggableDownload,
			"logMsg",
		).mockImplementation(logSpy);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await rm(directory, { recursive: true, force: true });
	});

	describe("Extraction output directory", () => {
		it.each([
			["omitted", undefined],
			["empty", {}],
		])(
			"should use the current working directory when extractParams is %s",
			async (_scenario, extractParams) => {
				vi.mocked(downloadBundleZip).mockResolvedValue(zipPath);

				await downloader.downloadTranslations({
					downloadFileParams,
					...(extractParams === undefined ? {} : { extractParams }),
				});

				expect(unpackZip).toHaveBeenCalledExactlyOnceWith(
					zipPath,
					process.cwd(),
				);
			},
		);

		it("should resolve a relative output directory to an absolute path", async () => {
			vi.mocked(downloadBundleZip).mockResolvedValue(zipPath);

			await downloader.downloadTranslations({
				downloadFileParams,
				extractParams: {
					outputDir: path.join("locales", "translations"),
				},
			});

			expect(unpackZip).toHaveBeenCalledExactlyOnceWith(
				zipPath,
				path.join(process.cwd(), "locales", "translations"),
			);
		});

		it("should preserve an absolute output directory", async () => {
			vi.mocked(downloadBundleZip).mockResolvedValue(zipPath);

			const outputDir = path.join(directory, "translations");

			await downloader.downloadTranslations({
				downloadFileParams,
				extractParams: { outputDir },
			});

			expect(unpackZip).toHaveBeenCalledExactlyOnceWith(zipPath, outputDir);
		});
	});

	it("forwards bundle downloader cleanup warnings to logMsg()", async () => {
		const cleanupError = new Error("Cleanup denied");

		vi.mocked(downloadBundleZip).mockImplementation(
			async (_url, _timeout, onWarning) => {
				onWarning?.("Failed to remove temporary ZIP: test.zip", cleanupError);
				return zipPath;
			},
		);

		await downloader.downloadTranslations({
			downloadFileParams,
			extractParams: { outputDir: directory },
		});

		expect(logSpy).toHaveBeenCalledWith(
			"warn",
			"Failed to remove temporary ZIP: test.zip",
			cleanupError,
		);
		expect(unpackZip).toHaveBeenCalledWith(zipPath, directory);
	});

	it("warns if removal of the downloaded ZIP fails after extraction", async () => {
		const unlinkError = Object.assign(new Error("Permission denied"), {
			code: "EACCES",
		});
		vi.mocked(downloadBundleZip).mockResolvedValue(zipPath);
		vi.spyOn(fs.promises, "unlink").mockRejectedValue(unlinkError);

		await expect(
			downloader.downloadTranslations({
				downloadFileParams,
				extractParams: { outputDir: directory },
			}),
		).resolves.toBeUndefined();

		expect(logSpy).toHaveBeenCalledWith(
			"warn",
			`Unable to remove temporary archive ${zipPath}`,
			unlinkError,
		);
	});

	it("forwards recoverable polling warnings to logMsg()", async () => {
		const apiError = Object.assign(new Error("Too Many Requests"), {
			code: 429,
		});
		const finished = { ...queued, status: "finished" } as QueuedProcess;

		vi.mocked(pollLokaliseProcesses).mockImplementation(async (options) => {
			options.onWarning?.(processId, apiError);
			return [finished];
		});

		await expect(downloader.pollForTest(queued)).resolves.toEqual(finished);
		expect(logSpy).toHaveBeenCalledWith(
			"warn",
			`Failed to fetch process ${processId}:`,
			apiError,
		);
	});

	it.each([
		{ scenario: "missing", results: [] as QueuedProcess[] },
		{
			scenario: "mismatched",
			results: [{ ...queued, process_id: "different-id" } as QueuedProcess],
		},
	])("rejects a $scenario process result from polling", async ({ results }) => {
		vi.mocked(pollLokaliseProcesses).mockResolvedValue(results);

		await expect(downloader.pollForTest(queued)).rejects.toMatchObject({
			code: 500,
			message: `Process ${processId} not found after polling`,
		} satisfies Partial<LokaliseError>);
	});

	it.each([
		["missing", undefined],
		["empty", ""],
		["whitespace", "   "],
		["non-string", 123],
	])(
		"rejects a finished process with %s download URL",
		async (_scenario, downloadUrl) => {
			vi.mocked(pollLokaliseProcesses).mockResolvedValue([
				{
					...queued,
					status: "finished",
					details: { download_url: downloadUrl },
				} as unknown as QueuedProcess,
			]);

			await expect(
				downloader.downloadTranslations({
					downloadFileParams,
					processDownloadFileParams: {
						asyncDownload: true,
						pollInitialWaitTime: 1,
						pollMaximumWaitTime: 1_000,
					},
				}),
			).rejects.toMatchObject({
				code: 502,
				message: `Process ${processId} finished without a valid download_url`,
			});

			expect(downloadBundleZip).not.toHaveBeenCalled();
		},
	);

	it.each([
		["queued", "queued"],
		[undefined, "missing"],
	])(
		"rejects an unfinished process with status %s",
		async (status, expectedStatus) => {
			vi.mocked(pollLokaliseProcesses).mockResolvedValue([
				{
					...queued,
					status,
				} as QueuedProcess,
			]);

			await expect(
				downloader.downloadTranslations({
					downloadFileParams,
					processDownloadFileParams: {
						asyncDownload: true,
						pollInitialWaitTime: 1,
						pollMaximumWaitTime: 1_000,
					},
				}),
			).rejects.toMatchObject({
				code: 504,
				message:
					`Download process ${processId} did not finish within 1000ms` +
					` (last status=${expectedStatus})`,
			});

			expect(downloadBundleZip).not.toHaveBeenCalled();
		},
	);
});
