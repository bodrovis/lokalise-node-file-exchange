import type { DownloadFileParams } from "@lokalise/node-api";
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

describe("LokaliseDownload: getTranslationsBundle()", () => {
	const projectId = "803826145ba90b42d5d860.46800099";
	const apiKey = process.env.API_KEY as string;
	const mockParams: DownloadFileParams = {
		format: "json",
		original_filenames: true,
	};

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
		mockPool = mockAgent.get("https://api.lokalise.com");
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("should download the file bundle successfully", async () => {
		const mockResponse = {
			project_id: projectId,
			bundle_url: "https://example.com/fake-bundle-url",
		};

		mockPool
			.intercept({
				path: `/api2/projects/${projectId}/files/download`,
				method: "POST",
				body: JSON.stringify(mockParams),
			})
			.reply(200, mockResponse);

		const downloader = new LokaliseDownload({ apiKey }, { projectId });
		const result = await downloader.getTranslationsBundle(mockParams);

		expect(result).toEqual(mockResponse);
	});

	describe("error handling", () => {
		it("should throw a LokaliseError for known error responses", async () => {
			const mockError = {
				message: "No keys for export with current export settings",
				code: 406,
			};

			mockPool
				.intercept({
					path: `/api2/projects/${projectId}/files/download`,
					method: "POST",
					body: JSON.stringify(mockParams),
				})
				.reply(406, mockError);

			const downloader = new LokaliseDownload({ apiKey }, { projectId });
			await expect(
				downloader.getTranslationsBundle(mockParams),
			).rejects.toThrow(new LokaliseError(mockError.message, mockError.code));
		});

		it("should retry on 429 errors with exponential backoff", async () => {
			const mockResponse = {
				project_id: projectId,
				bundle_url: "https://example.com/fake-bundle-url",
			};

			const retries = 3;
			const sleepTime = 1;
			const downloader = new LokaliseDownload(
				{ apiKey },
				{
					projectId,
					retryParams: { maxRetries: retries, initialSleepTime: sleepTime },
				},
			);
			const sleepSpy = vi
				.spyOn(downloader as any, "sleep")
				.mockResolvedValue(undefined);

			let callCount = 0;

			mockPool
				.intercept({
					path: `/api2/projects/${projectId}/files/download`,
					method: "POST",
					body: JSON.stringify(mockParams),
				})
				.reply(() => {
					callCount++;
					if (callCount < retries) {
						return {
							statusCode: 429,
							data: JSON.stringify({ message: "Too Many Requests", code: 429 }),
						};
					}
					return {
						statusCode: 200,
						data: JSON.stringify(mockResponse),
					};
				})
				.times(retries);

			const result = await downloader.getTranslationsBundle(mockParams);

			expect(result).toEqual(mockResponse);
			expect(callCount).toBe(retries);
			expect(sleepSpy).toHaveBeenCalledTimes(retries - 1);
			expect(sleepSpy).toHaveBeenNthCalledWith(1, sleepTime * 2 ** 0);
			expect(sleepSpy).toHaveBeenNthCalledWith(2, sleepTime * 2 ** 1);
		});

		it("should throw a LokaliseError after maximum retries for 429", async () => {
			const maxRetries = 2;
			const initialSleepTime = 2;
			const downloader = new LokaliseDownload(
				{ apiKey },
				{ projectId, retryParams: { maxRetries, initialSleepTime } },
			);
			mockPool
				.intercept({
					path: `/api2/projects/${projectId}/files/download`,
					method: "POST",
					body: JSON.stringify(mockParams),
				})
				.reply(429, { message: "Too Many Requests", code: 429 })
				.times(maxRetries + 1);

			try {
				await downloader.getTranslationsBundle(mockParams);
			} catch (e) {
				expect(e).toBeInstanceOf(LokaliseError);
				expect(e.message).toEqual("Maximum retries reached: Too Many Requests");
				expect(e.code).toEqual(429);
				expect(e.details).toEqual({ reason: "server error without details" });
			}
		});

		it("should throw a LokaliseError for unexpected errors", async () => {
			mockPool
				.intercept({
					path: `/api2/projects/${projectId}/files/download`,
					method: "POST",
					body: JSON.stringify(mockParams),
				})
				.replyWithError(new Error());

			const downloader = new LokaliseDownload({ apiKey }, { projectId });
			await expect(
				downloader.getTranslationsBundle(mockParams),
			).rejects.toMatchObject({
				message: "fetch failed",
				code: 500,
				details: { reason: "network or fetch error" },
			});
		});

		it("should attempt the download at least once when maxRetries is zero", async () => {
			const mockResponse = {
				project_id: projectId,
				bundle_url: "https://example.com/fake-bundle-url",
			};

			mockPool
				.intercept({
					path: `/api2/projects/${projectId}/files/download`,
					method: "POST",
					body: JSON.stringify(mockParams),
				})
				.reply(200, mockResponse);

			const downloader = new LokaliseDownload(
				{ apiKey },
				{ projectId, retryParams: { maxRetries: 0 } },
			);
			const result = await downloader.getTranslationsBundle(mockParams);

			expect(result).toEqual(mockResponse);
		});

		it("should retry on 408 errors with exponential backoff", async () => {
			const mockResponse = {
				project_id: projectId,
				bundle_url: "https://example.com/fake-bundle-url",
			};

			const retries = 3;
			const sleepTime = 1;
			const downloader = new LokaliseDownload(
				{ apiKey },
				{
					projectId,
					retryParams: { maxRetries: retries, initialSleepTime: sleepTime },
				},
			);
			const sleepSpy = vi
				.spyOn(downloader as any, "sleep")
				.mockResolvedValue(undefined);

			let callCount = 0;

			mockPool
				.intercept({
					path: `/api2/projects/${projectId}/files/download`,
					method: "POST",
					body: JSON.stringify(mockParams),
				})
				.reply(() => {
					callCount++;
					if (callCount < retries) {
						return {
							statusCode: 408,
							data: JSON.stringify({ message: "Request Timeout", code: 408 }),
						};
					}
					return {
						statusCode: 200,
						data: JSON.stringify(mockResponse),
					};
				})
				.times(retries);

			const result = await downloader.getTranslationsBundle(mockParams);

			expect(result).toEqual(mockResponse);
			expect(callCount).toBe(retries);
			expect(sleepSpy).toHaveBeenCalledTimes(retries - 1);
			expect(sleepSpy).toHaveBeenNthCalledWith(1, sleepTime * 2 ** 0);
			expect(sleepSpy).toHaveBeenNthCalledWith(2, sleepTime * 2 ** 1);
		});

		it("should handle mixed errors and eventually succeed", async () => {
			const mockResponse = {
				project_id: projectId,
				bundle_url: "https://example.com/fake-bundle-url",
			};

			const retries = 3;
			const sleepTime = 1;
			const downloader = new LokaliseDownload(
				{ apiKey },
				{
					projectId,
					retryParams: { maxRetries: retries, initialSleepTime: sleepTime },
				},
			);
			const sleepSpy = vi
				.spyOn(downloader as any, "sleep")
				.mockResolvedValue(undefined);

			let callCount = 0;

			mockPool
				.intercept({
					path: `/api2/projects/${projectId}/files/download`,
					method: "POST",
					body: JSON.stringify(mockParams),
				})
				.reply(() => {
					callCount++;
					if (callCount === 1) {
						return {
							statusCode: 429,
							data: JSON.stringify({ message: "Too Many Requests", code: 429 }),
						};
					}
					if (callCount === 2) {
						return {
							statusCode: 408,
							data: JSON.stringify({ message: "Request Timeout", code: 408 }),
						};
					}
					return {
						statusCode: 200,
						data: JSON.stringify(mockResponse),
					};
				})
				.times(3);

			const result = await downloader.getTranslationsBundle(mockParams);

			expect(result).toEqual(mockResponse);
			expect(callCount).toBe(3);
			expect(sleepSpy).toHaveBeenCalledTimes(2);
		});

		it("should rethrow non-ApiError exceptions as is", async () => {
			const invalidDownloader = new LokaliseDownload({ apiKey }, { projectId });
			(invalidDownloader as any).projectId = null;

			await expect(
				invalidDownloader.getTranslationsBundle(mockParams),
			).rejects.toThrow("Missing required parameter: project_id");
		});
	});
});
