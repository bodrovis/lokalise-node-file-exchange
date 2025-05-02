import type { DownloadFileParams } from "@lokalise/node-api";
import { LokaliseFileExchange } from "../../../lib/services/LokaliseFileExchange.js";
import { FakeLokaliseDownload } from "../../fixtures/fake_classes/FakeLokaliseDownload.js";
import type { TestableLokaliseFileExchange } from "../../fixtures/fake_interfaces/TestableLokaliseFileExchange.js";
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

describe("LokaliseDownload: getTranslationsBundleAsync()", () => {
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

	describe("Success Cases", () => {
		it("should perform background file download successfully", async () => {
			const mockResponse = {
				process_id: "74738ff5-5367-5958-9aee-98fffdcd1876",
			};

			mockPool
				.intercept({
					path: `/api2/projects/${projectId}/files/async-download`,
					method: "POST",
					body: JSON.stringify(mockParams),
				})
				.reply(200, mockResponse);

			const downloader = new FakeLokaliseDownload({ apiKey }, { projectId });
			const result = await downloader.getTranslationsBundleAsync(mockParams);

			expect(result).toEqual(mockResponse);
		});

		it("should attempt the download at least once when maxRetries is zero", async () => {
			const mockResponse = {
				process_id: "74738ff5-5367-5958-9aee-98fffdcd1876",
			};

			mockPool
				.intercept({
					path: `/api2/projects/${projectId}/files/async-download`,
					method: "POST",
					body: JSON.stringify(mockParams),
				})
				.reply(200, mockResponse);

			const downloader = new FakeLokaliseDownload(
				{ apiKey },
				{ projectId, retryParams: { maxRetries: 0 } },
			);
			const result = await downloader.getTranslationsBundleAsync(mockParams);

			expect(result).toEqual(mockResponse);
		});
	});

	describe("Retry Logic", () => {
		it("should retry on 429 errors with exponential backoff", async () => {
			const mockResponse = {
				process_id: "74738ff5-5367-5958-9aee-98fffdcd1876",
			};

			const retries = 3;
			const sleepTime = 1;
			const downloader = new FakeLokaliseDownload(
				{ apiKey },
				{
					projectId,
					retryParams: { maxRetries: retries, initialSleepTime: sleepTime },
				},
			);
			const sleepSpy = vi
				.spyOn(
					LokaliseFileExchange as unknown as TestableLokaliseFileExchange,
					"sleep",
				)
				.mockResolvedValue(undefined);

			let callCount = 0;

			mockPool
				.intercept({
					path: `/api2/projects/${projectId}/files/async-download`,
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

			const result = await downloader.getTranslationsBundleAsync(mockParams);

			expect(result).toEqual(mockResponse);
			expect(callCount).toBe(retries);
			expect(sleepSpy).toHaveBeenCalledTimes(retries - 1);
			expect(sleepSpy).toHaveBeenNthCalledWith(1, sleepTime * 2 ** 0);
			expect(sleepSpy).toHaveBeenNthCalledWith(2, sleepTime * 2 ** 1);
		});

		it("should retry on 408 errors with exponential backoff", async () => {
			const mockResponse = {
				process_id: "74738ff5-5367-5958-9aee-98fffdcd1876",
			};

			const retries = 3;
			const sleepTime = 1;
			const downloader = new FakeLokaliseDownload(
				{ apiKey },
				{
					projectId,
					retryParams: { maxRetries: retries, initialSleepTime: sleepTime },
				},
			);
			const sleepSpy = vi
				.spyOn(
					LokaliseFileExchange as unknown as TestableLokaliseFileExchange,
					"sleep",
				)
				.mockResolvedValue(undefined);

			let callCount = 0;

			mockPool
				.intercept({
					path: `/api2/projects/${projectId}/files/async-download`,
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

			const result = await downloader.getTranslationsBundleAsync(mockParams);

			expect(result).toEqual(mockResponse);
			expect(callCount).toBe(retries);
			expect(sleepSpy).toHaveBeenCalledTimes(retries - 1);
			expect(sleepSpy).toHaveBeenNthCalledWith(1, sleepTime * 2 ** 0);
			expect(sleepSpy).toHaveBeenNthCalledWith(2, sleepTime * 2 ** 1);
		});
	});

	describe("Error Handling", () => {
		it("should throw a LokaliseError after maximum retries for 429", async () => {
			const maxRetries = 2;
			const initialSleepTime = 2;
			const downloader = new FakeLokaliseDownload(
				{ apiKey },
				{ projectId, retryParams: { maxRetries, initialSleepTime } },
			);
			mockPool
				.intercept({
					path: `/api2/projects/${projectId}/files/async-download`,
					method: "POST",
					body: JSON.stringify(mockParams),
				})
				.reply(429, { message: "Too Many Requests", code: 429 })
				.times(maxRetries + 1);

			await expect(
				downloader.getTranslationsBundleAsync(mockParams),
			).rejects.toThrow("Maximum retries reached: Too Many Requests");
		});

		it("should throw a LokaliseError for unexpected errors", async () => {
			mockPool
				.intercept({
					path: `/api2/projects/${projectId}/files/async-download`,
					method: "POST",
					body: JSON.stringify(mockParams),
				})
				.replyWithError(new Error());

			const downloader = new FakeLokaliseDownload({ apiKey }, { projectId });
			await expect(
				downloader.getTranslationsBundleAsync(mockParams),
			).rejects.toMatchObject({
				message: "fetch failed",
				code: 500,
				details: { reason: "network or fetch error" },
			});
		});
	});

	describe("Edge Cases", () => {
		it("should handle mixed errors and eventually succeed", async () => {
			const mockResponse = {
				process_id: "74738ff5-5367-5958-9aee-98fffdcd1876",
			};

			const retries = 3;
			const sleepTime = 1;
			const downloader = new FakeLokaliseDownload(
				{ apiKey },
				{
					projectId,
					retryParams: { maxRetries: retries, initialSleepTime: sleepTime },
				},
			);
			const sleepSpy = vi
				.spyOn(
					LokaliseFileExchange as unknown as TestableLokaliseFileExchange,
					"sleep",
				)
				.mockResolvedValue(undefined);

			let callCount = 0;

			mockPool
				.intercept({
					path: `/api2/projects/${projectId}/files/async-download`,
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

			const result = await downloader.getTranslationsBundleAsync(mockParams);

			expect(result).toEqual(mockResponse);
			expect(callCount).toBe(3);
			expect(sleepSpy).toHaveBeenCalledTimes(2);
		});

		it("should rethrow non-ApiError exceptions as is", async () => {
			const invalidDownloader = new FakeLokaliseDownload(
				{ apiKey },
				{ projectId },
			);
			Object.defineProperty(invalidDownloader, "projectId", {
				get: () => null,
				configurable: true,
			});

			await expect(
				invalidDownloader.getTranslationsBundleAsync(mockParams),
			).rejects.toThrow("Missing required parameter: project_id");
		});
	});
});
