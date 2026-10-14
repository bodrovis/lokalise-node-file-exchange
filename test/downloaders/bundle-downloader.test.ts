import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { getGlobalDispatcher } from "undici";
import { downloadBundleZip } from "../../lib/downloaders/bundle-downloader.js";
import { LokaliseError } from "../../lib/errors/LokaliseError.js";
import type { Interceptable } from "../setup.js";
import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	it,
	MockAgent,
	setGlobalDispatcher,
	vi,
} from "../setup.js";

describe("downloadBundleZip()", () => {
	const url = "https://example.com/download.zip";

	// Valid empty ZIP archive.
	const zipContent = Buffer.from(`504b0506${"00".repeat(18)}`, "hex");

	const originalDispatcher = getGlobalDispatcher();

	let mockAgent: MockAgent;
	let mockPool: Interceptable;

	beforeAll(() => {
		mockAgent = new MockAgent();
		mockAgent.disableNetConnect();
		mockPool = mockAgent.get("https://example.com");
		setGlobalDispatcher(mockAgent);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		mockAgent.assertNoPendingInterceptors();
	});

	afterAll(async () => {
		setGlobalDispatcher(originalDispatcher);
		await mockAgent.close();
	});

	it("downloads the response body to a temporary ZIP file", async () => {
		mockPool
			.intercept({
				path: "/download.zip",
				method: "GET",
			})
			.reply(200, zipContent, {
				headers: { "content-type": "application/zip" },
			});

		const zipPath = await downloadBundleZip(url);

		try {
			expect(path.dirname(zipPath)).toBe(tmpdir());
			expect(path.basename(zipPath)).toMatch(/^lokalise-.+\.zip$/);

			const downloaded = await readFile(zipPath);

			expect(downloaded).toEqual(zipContent);
		} finally {
			await rm(zipPath, { force: true });
		}
	});

	it("downloads without a timeout when timeout is zero", async () => {
		mockPool
			.intercept({
				path: "/download.zip",
				method: "GET",
			})
			.reply(200, zipContent);

		const zipPath = await downloadBundleZip(url, 0);

		try {
			expect(await readFile(zipPath)).toEqual(zipContent);
		} finally {
			await rm(zipPath, { force: true });
		}
	});

	it("rejects non-successful HTTP responses", async () => {
		mockPool
			.intercept({
				path: "/download.zip",
				method: "GET",
			})
			.reply(404, "Not Found");

		await expect(downloadBundleZip(url)).rejects.toMatchObject({
			code: 404,
		});
	});

	it("rejects responses without a body", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(null, { status: 200 }),
		);

		await expect(downloadBundleZip(url)).rejects.toThrow(
			"ZIP response body is missing.",
		);
	});

	it.each([
		"invalid-url",
		"file:///tmp/archive.zip",
		"ftp://example.com/download.zip",
	])("rejects invalid or unsupported URLs: %s", async (invalidUrl) => {
		await expect(downloadBundleZip(invalidUrl)).rejects.toBeInstanceOf(
			LokaliseError,
		);
	});

	it.each([-1, NaN, Infinity, 1.5])(
		"rejects invalid timeout: %s",
		async (timeout) => {
			await expect(downloadBundleZip(url, timeout)).rejects.toThrow(
				"bundleDownloadTimeout must be an integer",
			);
		},
	);

	it("fails when the HTTP request exceeds its timeout", async () => {
		mockPool
			.intercept({
				path: "/download.zip",
				method: "GET",
			})
			.reply(200, zipContent)
			.delay(200);

		await expect(downloadBundleZip(url, 20)).rejects.toMatchObject({
			code: 408,
			details: { reason: "timeout" },
		});
	});

	it("wraps network errors", async () => {
		mockPool
			.intercept({
				path: "/download.zip",
				method: "GET",
			})
			.replyWithError(new Error("Connection lost"));

		await expect(downloadBundleZip(url)).rejects.toMatchObject({
			code: 500,
			details: { reason: "download error" },
		});
	});

	it("handles failures while reading the response stream", async () => {
		let readCount = 0;

		const stream = new ReadableStream<Uint8Array>({
			pull(controller) {
				readCount++;

				if (readCount === 1) {
					controller.enqueue(zipContent);
					return;
				}

				controller.error(new Error("Stream interrupted"));
			},
		});

		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(stream, { status: 200 }),
		);

		await expect(downloadBundleZip(url)).rejects.toMatchObject({
			code: 500,
			details: { reason: "download error" },
		});
	});
});
