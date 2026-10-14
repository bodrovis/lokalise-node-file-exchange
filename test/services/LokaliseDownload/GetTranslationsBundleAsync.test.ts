import type { DownloadFileParams } from "@lokalise/node-api";
import { FakeLokaliseDownload } from "../../fixtures/fake-classes/FakeLokaliseDownload.js";
import type { Interceptable } from "../../setup.js";
import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	it,
	MockAgent,
	setGlobalDispatcher,
} from "../../setup.js";

describe("LokaliseDownload: getTranslationsBundleAsync()", () => {
	const projectId = "803826145ba90b42d5d860.46800099";
	const apiKey = "test-api-key";
	const downloadPath = `/api2/projects/${projectId}/files/async-download`;

	const mockParams: DownloadFileParams = {
		format: "json",
		original_filenames: true,
	};

	const mockProcess = {
		process_id: "74738ff5-5367-5958-9aee-98fffdcd1876",
	};

	let mockAgent: MockAgent;
	let mockPool: Interceptable;

	beforeAll(() => {
		mockAgent = new MockAgent();
		mockAgent.disableNetConnect();
		mockPool = mockAgent.get("https://api.lokalise.com");
		setGlobalDispatcher(mockAgent);
	});

	afterEach(() => {
		mockAgent.assertNoPendingInterceptors();
	});

	afterAll(async () => {
		await mockAgent.close();
	});

	const interceptDownload = () =>
		mockPool.intercept({
			path: downloadPath,
			method: "POST",
			body: JSON.stringify(mockParams),
		});

	it("returns the queued download process", async () => {
		interceptDownload().reply(200, mockProcess);

		const downloader = new FakeLokaliseDownload({ apiKey }, { projectId });

		await expect(
			downloader.getTranslationsBundleAsync(mockParams),
		).resolves.toEqual(mockProcess);
	});

	it("makes one request when maxRetries is zero", async () => {
		interceptDownload().reply(200, mockProcess);

		const downloader = new FakeLokaliseDownload(
			{ apiKey },
			{ projectId, retryParams: { maxRetries: 0 } },
		);

		await expect(
			downloader.getTranslationsBundleAsync(mockParams),
		).resolves.toEqual(mockProcess);
	});

	it.each([408, 429])(
		"retries HTTP %i and eventually succeeds",
		async (statusCode) => {
			const maxRetries = 2;
			let attempts = 0;

			interceptDownload()
				.reply(() => {
					attempts++;

					if (attempts <= maxRetries) {
						return {
							statusCode,
							data: JSON.stringify({
								message: "Temporary API error",
								code: statusCode,
							}),
						};
					}

					return {
						statusCode: 200,
						data: JSON.stringify(mockProcess),
					};
				})
				.times(maxRetries + 1);

			const downloader = new FakeLokaliseDownload(
				{ apiKey },
				{
					projectId,
					retryParams: {
						maxRetries,
						initialSleepTime: 1,
						jitterRatio: 0,
					},
				},
			);

			const result = await downloader.getTranslationsBundleAsync(mockParams);

			expect(result).toEqual(mockProcess);
			expect(attempts).toBe(maxRetries + 1);
		},
	);

	it("throws after exhausting retries", async () => {
		const maxRetries = 2;
		let attempts = 0;

		interceptDownload()
			.reply(() => {
				attempts++;

				return {
					statusCode: 429,
					data: JSON.stringify({
						message: "Too Many Requests",
						code: 429,
					}),
				};
			})
			.times(maxRetries + 1);

		const downloader = new FakeLokaliseDownload(
			{ apiKey },
			{
				projectId,
				retryParams: {
					maxRetries,
					initialSleepTime: 1,
					jitterRatio: 0,
				},
			},
		);

		await expect(
			downloader.getTranslationsBundleAsync(mockParams),
		).rejects.toThrow("Maximum retries reached: Too Many Requests");

		expect(attempts).toBe(maxRetries + 1);
	});

	it("does not retry non-retryable API errors", async () => {
		const mockError = {
			message: "Invalid request",
			code: 406,
		};

		let attempts = 0;

		interceptDownload().reply(() => {
			attempts++;

			return {
				statusCode: 406,
				data: JSON.stringify(mockError),
			};
		});

		const downloader = new FakeLokaliseDownload({ apiKey }, { projectId });

		await expect(
			downloader.getTranslationsBundleAsync(mockParams),
		).rejects.toMatchObject({
			message: mockError.message,
			code: mockError.code,
		});

		expect(attempts).toBe(1);
	});

	it("handles network failures", async () => {
		interceptDownload().replyWithError(new Error("Connection lost"));

		const downloader = new FakeLokaliseDownload({ apiKey }, { projectId });

		await expect(
			downloader.getTranslationsBundleAsync(mockParams),
		).rejects.toMatchObject({
			code: 500,
			details: {
				reason: "network or fetch error",
			},
		});
	});
});
