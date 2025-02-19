import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { LokaliseError } from "../../../lib/errors/LokaliseError.js";
import { FakeLokaliseDownload } from "../../fixtures/fake_classes/FakeLokaliseDownload.js";
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

	let downloader: FakeLokaliseDownload;
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
		downloader = new FakeLokaliseDownload({ apiKey }, { projectId });
		mockPool = mockAgent.get("https://example.com");
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe("Success Cases", () => {
		it("should successfully download a ZIP file", async () => {
			const mockZipContent = "Mock ZIP file content";
			const mockTempPath = "/mock/temp/lokalise-translations.zip";

			vi.spyOn(path, "join").mockReturnValue(mockTempPath);
			vi.spyOn(fs, "createWriteStream").mockImplementation((filePath) => {
				const mockStream = new (require("node:stream").Writable)({
					write(_chunk, _encoding, callback) {
						callback(); // Simulate writing to the stream
					},
				});

				(mockStream as any).path = filePath;
				(mockStream as any).bytesWritten = 0;
				(mockStream as any).pending = false;

				return mockStream as fs.WriteStream;
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
			expect(path.join).toHaveBeenCalledWith(
				os.tmpdir(),
				expect.stringMatching(/^lokalise-translations-.*\.zip$/),
			);
			expect(fs.createWriteStream).toHaveBeenCalledWith(mockTempPath);
		});
	});

	describe("Error Cases", () => {
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
				new LokaliseError("Failed to download ZIP file: Not Found (404)"),
			);
		});

		it("should throw an error if the response body is null", async () => {
			// Save the original fetch
			const originalFetch = global.fetch;

			// Mock fetch
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

			// Restore the original fetch
			global.fetch = originalFetch;
		});

		it("should throw an error for a malformed URL", async () => {
			await expect(downloader.downloadZip("htp://invalid-url")).rejects.toThrow(
				"A valid URL must start with 'http' or 'https', got htp://invalid-url",
			);
		});

		it("should throw an error if the stream fails during download", async () => {
			const mockTempPath = "/mock/temp/lokalise-translations.zip";

			vi.spyOn(path, "join").mockReturnValue(mockTempPath);
			vi.spyOn(fs, "createWriteStream").mockImplementation(
				(filePath: fs.PathLike) => {
					// Ensure filePath is strictly of type string or Buffer
					const normalizedPath =
						typeof filePath === "string" ? filePath : filePath.toString();

					class MockWriteStream extends Writable {
						path: string | Buffer;
						bytesWritten: number;
						pending: boolean;

						constructor(path: string | Buffer) {
							super();
							this.path = path;
							this.bytesWritten = 0;
							this.pending = false;
						}

						close() {
							// Simulate close functionality
						}

						_write(
							_chunk: any,
							_encoding: string,
							callback: (error?: Error | null) => void,
						) {
							// Simulate a stream write error
							callback(new Error("Stream write error"));
						}
					}

					return new MockWriteStream(normalizedPath);
				},
			);

			mockPool
				.intercept({
					path: "/download.zip",
					method: "GET",
				})
				.reply(200, "Mock ZIP content");

			await expect(
				downloader.downloadZip("https://example.com/download.zip"),
			).rejects.toThrow("Stream write error");
		});
	});

	describe("Edge Cases", () => {
		it("should handle a slow response gracefully", async () => {
			const mockZipContent = "Mock ZIP file content";
			const mockTempPath = "/mock/temp/lokalise-translations.zip";

			vi.spyOn(path, "join").mockReturnValue(mockTempPath);
			vi.spyOn(fs, "createWriteStream").mockImplementation(
				(filePath: fs.PathLike) => {
					// Ensure filePath is strictly of type string or Buffer
					const normalizedPath =
						typeof filePath === "string" ? filePath : filePath.toString();

					class MockWriteStream extends Writable {
						path: string | Buffer;
						bytesWritten: number;
						pending: boolean;

						constructor(path: string | Buffer) {
							super();
							this.path = path;
							this.bytesWritten = 0;
							this.pending = false;
						}

						close() {
							// Simulate closing the stream
						}
					}

					// Simulate slow writes
					const slowStream = new MockWriteStream(normalizedPath);
					slowStream._write = (_chunk, _encoding, callback) => {
						setTimeout(callback, 100); // Simulate a slow write
					};

					return slowStream as fs.WriteStream;
				},
			);

			mockPool
				.intercept({
					path: "/download.zip",
					method: "GET",
				})
				.reply(200, mockZipContent);

			await expect(
				downloader.downloadZip("https://example.com/download.zip"),
			).resolves.not.toThrow();
		});
	});
});
