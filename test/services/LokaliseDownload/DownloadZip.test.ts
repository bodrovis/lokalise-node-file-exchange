import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import type yauzl from "yauzl";
import { LokaliseError } from "../../../lib/errors/LokaliseError.js";
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
	MockAgent,
	setGlobalDispatcher,
	vi,
} from "../../setup.js";

type MockWriteStream = fs.WriteStream & {
	path: string;
	bytesWritten: number;
	pending: boolean;
};

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
			vi.spyOn(fs, "createWriteStream").mockImplementation(
				(filePath): fs.WriteStream => {
					const { Writable } = require("node:stream");
					const stream = new Writable({
						write(
							_chunk: unknown,
							_encoding: BufferEncoding,
							callback: (err?: Error | null) => void,
						) {
							callback(); // Simulate writing to the stream
						},
					});

					const mockStream: MockWriteStream = Object.assign(stream, {
						path: filePath,
						bytesWritten: 0,
						pending: false,
					});

					return mockStream;
				},
			);

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
				expect.stringMatching(/^lokalise-.*\.zip$/),
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
			await expect(downloader.downloadZip("invalid-url")).rejects.toThrow(
				"Invalid URL: invalid-url",
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
							_chunk: string,
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

		it("should throw a timeout error if the download takes too long", async () => {
			const pool = mockPool
				.intercept({
					path: "/download.zip",
					method: "GET",
				})
				.reply(200, "Mock ZIP content");

			pool.delay(1000);

			await expect(
				downloader.downloadZip("https://example.com/download.zip", 1),
			).rejects.toThrow(
				new LokaliseError("Request timed out after 1ms", 408, {
					reason: "timeout",
				}),
			);
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

describe("ZIP processing", () => {
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
		downloader = new FakeLokaliseDownload(
			{ apiKey: "123" },
			{ projectId: "abc" },
		);
		mockPool = mockAgent.get("https://example.com");
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("wraps non-timeout Error as network or fetch error", async () => {
		const url = new URL("https://example.com/download.zip");

		mockPool
			.intercept({
				path: "/download.zip",
				method: "GET",
			})
			.replyWithError(new Error("Network exploded"));

		const promise = downloader.fetchZipResponse(url, undefined, 5000);

		await expect(promise).rejects.toBeInstanceOf(LokaliseError);
		await expect(promise).rejects.toThrow("fetch failed");

		await expect(promise).rejects.toMatchObject({
			code: 500,
			details: { reason: "network or fetch error" },
		});
	});

	it("throws on malicious ZIP entry (path traversal)", () => {
		const outputDir = "/tmp/extract";
		const malicious = "../evil.txt";

		expect(() =>
			downloader.processZipEntryPath(outputDir, malicious),
		).toThrowError(LokaliseError);

		expect(() => downloader.processZipEntryPath(outputDir, malicious)).toThrow(
			/Malicious ZIP entry detected/,
		);
	});

	it("throws on malicious absolute path", () => {
		const outputDir = "/tmp/extract";
		const malicious = "/etc/passwd";

		expect(() =>
			downloader.processZipEntryPath(outputDir, malicious),
		).toThrowError(LokaliseError);
	});

	it("allows safe relative paths", () => {
		const outputDir = "/tmp/extract";
		const safe = "locales/en.json";
		const full = downloader.processZipEntryPath(outputDir, safe);
		expect(full).toBe(path.resolve(outputDir, safe));
	});

	it("rejects when zipfile.openReadStream returns an error", async () => {
		const entry: yauzl.Entry = {
			fileName: "file.txt",
		} as unknown as yauzl.Entry;

		const zipfile: yauzl.ZipFile = {
			openReadStream: vi.fn(
				(
					_: yauzl.Entry,
					cb: (err: Error | null, stream?: fs.ReadStream | null) => void,
				) => {
					cb(new Error("Stream error"), null);
				},
			),
		} as unknown as yauzl.ZipFile;

		await expect(
			downloader.handleZipEntry(entry, zipfile, "/tmp/out"),
		).rejects.toThrowError(LokaliseError);

		await expect(
			downloader.handleZipEntry(entry, zipfile, "/tmp/out"),
		).rejects.toThrow("Failed to read ZIP entry: file.txt");
	});

	it("uses fallback when crypto.randomUUID is unavailable", () => {
		type CryptoWithRandomUUID = typeof crypto & {
			randomUUID?: () => string | undefined;
		};

		type RandomBytesSync = (size: number) => Buffer;

		const cryptoWithUUID = crypto as CryptoWithRandomUUID;

		vi.spyOn(cryptoWithUUID, "randomUUID").mockReturnValue(undefined);

		vi.spyOn(crypto, "randomBytes").mockImplementation(((_: number) =>
			Buffer.from("3c31fabbfa33cdbf", "hex")) as RandomBytesSync);

		// mock Date.now
		vi.spyOn(Date, "now").mockReturnValue(1772125693443);

		const zipPath = downloader.buildTempZipPath();

		const expected = path.join(
			os.tmpdir(),
			`lokalise-${process.pid}-1772125693443-3c31fabbfa33cdbf.zip`,
		);

		expect(zipPath).toBe(expected);
	});
});
