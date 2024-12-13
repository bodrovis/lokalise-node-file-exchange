import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LokaliseError } from "../../../lib/errors/LokaliseError.js";
import { LokaliseDownload } from "../../../lib/services/LokaliseDownload.js";
import {
	MockAgent,
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	setGlobalDispatcher,
	vi,
} from "../../setup.js";
import type { Interceptable } from "../../setup.js";

describe("LokaliseDownload: downloadZip()", () => {
	const projectId = "803826145ba90b42d5d860.46800099";
	const apiKey = process.env.API_KEY as string;

	let downloader: LokaliseDownload;
	let mockAgent: MockAgent;
	let mockPool: Interceptable;

	beforeAll(() => {
		mockAgent = new MockAgent();
		setGlobalDispatcher(mockAgent);
		mockAgent.disableNetConnect();
	});

	afterAll(() => {
		mockAgent.close();
	});

	beforeEach(() => {
		downloader = new LokaliseDownload({ apiKey }, { projectId });
		mockPool = mockAgent.get("https://example.com");
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("should successfully download a ZIP file", async () => {
		const mockZipContent = "Mock ZIP file content";
		const mockTempPath = "/mock/temp/lokalise-translations.zip";

		const pathJoinSpy = vi.spyOn(path, "join").mockReturnValue(mockTempPath);

		const writeStreamSpy = vi
			.spyOn(fs, "createWriteStream")
			.mockImplementation((filePath) => {
				const mockStream = new (require("node:stream").Writable)({
					write(_chunk, _encoding, callback) {
						callback(); // Simulate writing to the stream
					},
				});
				mockStream.path = filePath;
				return mockStream;
			});

		mockPool
			.intercept({
				path: "/download.zip",
				method: "GET",
			})
			.reply(200, mockZipContent, {
				headers: { "Content-Type": "application/zip" },
			});

		const zipPath = await downloader.downloadZip(
			"https://example.com/download.zip",
		);

		expect(zipPath).toBe(mockTempPath);
		expect(pathJoinSpy).toHaveBeenCalledWith(
			os.tmpdir(),
			expect.stringMatching(/^lokalise-translations-.*\.zip$/),
		);
		expect(writeStreamSpy).toHaveBeenCalledWith(mockTempPath);

		pathJoinSpy.mockRestore();
		writeStreamSpy.mockRestore();
	});

	it("should throw an error if the response is not OK", async () => {
		mockPool
			.intercept({
				path: "/download.zip",
				method: "GET",
			})
			.reply(404, "Not Found");

		await expect(
			downloader.downloadZip("https://example.com/download.zip"),
		).rejects.toThrow(
			new LokaliseError("Failed to download ZIP file: Not Found"),
		);
	});

	it("should throw an error if the response body is null", async () => {
		global.fetch = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			statusText: "OK",
			body: null,
		});

		await expect(
			downloader.downloadZip("https://example.com/download.zip"),
		).rejects.toThrow(
			new LokaliseError(
				"Response body is null. Cannot download ZIP file from URL: https://example.com/download.zip",
			),
		);
	});
});
