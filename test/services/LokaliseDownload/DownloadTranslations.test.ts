import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DownloadFileParams } from "@lokalise/node-api";
import { getGlobalDispatcher } from "undici";
import { LokaliseDownload } from "../../../lib/services/LokaliseDownload.js";
import type { Interceptable } from "../../setup.js";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	MockAgent,
	setGlobalDispatcher,
} from "../../setup.js";

describe("LokaliseDownload: downloadTranslations()", () => {
	const projectId = "803826145ba90b42d5d860.46800099";
	const apiKey = "test-api-key";
	const archiveUrl = "https://example.com/download.zip";
	const processId = "74738ff5-5367-5958-9aee-98fffdcd1876";
	const downloadPath = `/api2/projects/${projectId}/files/download`;
	const asyncDownloadPath = `/api2/projects/${projectId}/files/async-download`;
	const processPath = `/api2/projects/${projectId}/processes/${processId}`;

	const downloadFileParams: DownloadFileParams = {
		format: "json",
		original_filenames: true,
	};

	// A real ZIP containing locales/en.json and locales/fr.json.
	const zipContent = Buffer.from(
		"UEsDBBQAAAAAAAAAIVgOcTz0EQAAABEAAAAPAAAAbG9jYWxlcy9lbi5qc29ueyJoZWxsbyI6Ikhl" +
			"bGxvIn1QSwMEFAAAAAAAAAAhWALV8GkTAAAAEwAAAA8AAABsb2NhbGVzL2ZyLmpzb257ImhlbGxv" +
			"IjoiQm9uam91ciJ9UEsBAhQDFAAAAAAAAAAhWA5xPPQRAAAAEQAAAA8AAAAAAAAAAAAAAIABAAAA" +
			"AGxvY2FsZXMvZW4uanNvblBLAQIUAxQAAAAAAAAAIVgC1fBpEwAAABMAAAAPAAAAAAAAAAAAAACA" +
			"AT4AAABsb2NhbGVzL2ZyLmpzb25QSwUGAAAAAAIAAgB6AAAAfgAAAAAA",
		"base64",
	);

	let mockAgent: MockAgent;
	let apiPool: Interceptable;
	let archivePool: Interceptable;
	let previousDispatcher: ReturnType<typeof getGlobalDispatcher>;
	let outputDir: string;

	beforeAll(() => {
		previousDispatcher = getGlobalDispatcher();
		mockAgent = new MockAgent();
		mockAgent.disableNetConnect();
		apiPool = mockAgent.get("https://api.lokalise.com");
		archivePool = mockAgent.get("https://example.com");
		setGlobalDispatcher(mockAgent);
	});

	beforeEach(async () => {
		outputDir = await mkdtemp(path.join(tmpdir(), "lokalise-download-test-"));
	});

	afterEach(async () => {
		try {
			mockAgent.assertNoPendingInterceptors();
		} finally {
			await rm(outputDir, { recursive: true, force: true });
		}
	});

	afterAll(async () => {
		setGlobalDispatcher(previousDispatcher);
		await mockAgent.close();
	});

	function mockArchive(content: Buffer = zipContent): void {
		archivePool
			.intercept({ method: "GET", path: "/download.zip" })
			.reply(200, content, {
				headers: { "content-type": "application/zip" },
			});
	}

	async function expectExtractedFiles(): Promise<void> {
		expect(
			await readFile(path.join(outputDir, "locales", "en.json"), "utf8"),
		).toBe('{"hello":"Hello"}');

		expect(
			await readFile(path.join(outputDir, "locales", "fr.json"), "utf8"),
		).toBe('{"hello":"Bonjour"}');
	}

	it("downloads and extracts a synchronous translation bundle", async () => {
		apiPool
			.intercept({
				method: "POST",
				path: downloadPath,
				body: JSON.stringify(downloadFileParams),
			})
			.reply(200, {
				project_id: projectId,
				bundle_url: archiveUrl,
				responseTooBig: false,
			});

		mockArchive();

		const downloader = new LokaliseDownload({ apiKey }, { projectId });

		await downloader.downloadTranslations({
			downloadFileParams,
			extractParams: { outputDir },
		});

		await expectExtractedFiles();
	});

	it("queues, polls, downloads and extracts an asynchronous bundle", async () => {
		apiPool
			.intercept({
				method: "POST",
				path: asyncDownloadPath,
				body: JSON.stringify(downloadFileParams),
			})
			.reply(200, { process_id: processId, status: "queued" });

		apiPool.intercept({ method: "GET", path: processPath }).reply(200, {
			process: {
				process_id: processId,
				type: "async-export",
				status: "finished",
				details: { download_url: archiveUrl },
			},
		});

		mockArchive();

		const downloader = new LokaliseDownload({ apiKey }, { projectId });

		await downloader.downloadTranslations({
			downloadFileParams,
			extractParams: { outputDir },
			processDownloadFileParams: {
				asyncDownload: true,
				pollInitialWaitTime: 1,
				pollMaximumWaitTime: 5_000,
			},
		});

		await expectExtractedFiles();
	});

	it("rejects a failed asynchronous export without downloading an archive", async () => {
		apiPool
			.intercept({
				method: "POST",
				path: asyncDownloadPath,
				body: JSON.stringify(downloadFileParams),
			})
			.reply(200, { process_id: processId, status: "queued" });

		apiPool.intercept({ method: "GET", path: processPath }).reply(200, {
			process: {
				process_id: processId,
				status: "failed",
				message: "Export failed",
			},
		});

		const downloader = new LokaliseDownload({ apiKey }, { projectId });

		await expect(
			downloader.downloadTranslations({
				downloadFileParams,
				extractParams: { outputDir },
				processDownloadFileParams: {
					asyncDownload: true,
					pollInitialWaitTime: 1,
					pollMaximumWaitTime: 5_000,
				},
			}),
		).rejects.toMatchObject({ code: 502 });
	});

	it("validates async polling settings before making API requests", async () => {
		const downloader = new LokaliseDownload({ apiKey }, { projectId });

		await expect(
			downloader.downloadTranslations({
				downloadFileParams,
				extractParams: { outputDir },
				processDownloadFileParams: {
					asyncDownload: true,
					pollInitialWaitTime: -1,
				},
			}),
		).rejects.toThrow("initialWaitTime");
	});

	it("rejects an invalid ZIP instead of silently succeeding", async () => {
		apiPool
			.intercept({
				method: "POST",
				path: downloadPath,
				body: JSON.stringify(downloadFileParams),
			})
			.reply(200, {
				project_id: projectId,
				bundle_url: archiveUrl,
				responseTooBig: false,
			});

		mockArchive(Buffer.from("not a ZIP archive"));

		const downloader = new LokaliseDownload({ apiKey }, { projectId });

		await expect(
			downloader.downloadTranslations({
				downloadFileParams,
				extractParams: { outputDir },
			}),
		).rejects.toThrow();
	});
});
