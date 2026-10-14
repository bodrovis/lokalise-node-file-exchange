import type { DownloadFileParams } from "@lokalise/node-api";
import { LokaliseError } from "../../../lib/errors/LokaliseError.js";
import { FakeLokaliseDownload } from "../../fixtures/fake-classes/FakeLokaliseDownload.js";
import type { Interceptable } from "../../setup.js";
import {
	afterAll,
	beforeAll,
	describe,
	expect,
	it,
	MockAgent,
	setGlobalDispatcher,
} from "../../setup.js";

describe("LokaliseDownload: getTranslationsBundle()", () => {
	const projectId = "803826145ba90b42d5d860.46800099";
	const apiKey = "test-api-key";

	const mockParams: DownloadFileParams = {
		format: "json",
		original_filenames: true,
	};

	const mockBundle = {
		project_id: projectId,
		bundle_url: "https://example.com/fake-bundle-url",
		responseTooBig: false,
	};

	const downloadPath = `/api2/projects/${projectId}/files/download`;

	let mockAgent: MockAgent;
	let mockPool: Interceptable;

	beforeAll(() => {
		mockAgent = new MockAgent();
		mockAgent.disableNetConnect();
		mockPool = mockAgent.get("https://api.lokalise.com");
		setGlobalDispatcher(mockAgent);
	});

	afterAll(async () => {
		await mockAgent.close();
	});

	it("returns translation bundle metadata", async () => {
		mockPool
			.intercept({
				path: downloadPath,
				method: "POST",
				body: JSON.stringify(mockParams),
			})
			.reply(200, mockBundle);

		const downloader = new FakeLokaliseDownload({ apiKey }, { projectId });

		const result = await downloader.getTranslationsBundle(mockParams);

		expect(result).toEqual(mockBundle);
	});

	it("makes one request when maxRetries is zero", async () => {
		mockPool
			.intercept({
				path: downloadPath,
				method: "POST",
				body: JSON.stringify(mockParams),
			})
			.reply(200, mockBundle);

		const downloader = new FakeLokaliseDownload(
			{ apiKey },
			{ projectId, retryParams: { maxRetries: 0 } },
		);

		await expect(downloader.getTranslationsBundle(mockParams)).resolves.toEqual(
			mockBundle,
		);
	});

	it.each([408, 429])(
		"retries HTTP %i and eventually succeeds",
		async (statusCode) => {
			const maxRetries = 2;
			let attempts = 0;

			mockPool
				.intercept({
					path: downloadPath,
					method: "POST",
					body: JSON.stringify(mockParams),
				})
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
						data: JSON.stringify(mockBundle),
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

			const result = await downloader.getTranslationsBundle(mockParams);

			expect(result).toEqual(mockBundle);
			expect(attempts).toBe(maxRetries + 1);
		},
	);

	it("stops retrying after maxRetries is exhausted", async () => {
		const maxRetries = 2;
		let attempts = 0;

		mockPool
			.intercept({
				path: downloadPath,
				method: "POST",
				body: JSON.stringify(mockParams),
			})
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
			downloader.getTranslationsBundle(mockParams),
		).rejects.toBeInstanceOf(LokaliseError);

		expect(attempts).toBe(maxRetries + 1);
	});

	it("does not retry non-retryable API errors", async () => {
		const mockError = {
			message: "No keys for export with current export settings",
			code: 406,
		};

		let attempts = 0;

		mockPool
			.intercept({
				path: downloadPath,
				method: "POST",
				body: JSON.stringify(mockParams),
			})
			.reply(() => {
				attempts++;
				return {
					statusCode: 406,
					data: JSON.stringify(mockError),
				};
			});

		const downloader = new FakeLokaliseDownload({ apiKey }, { projectId });

		await expect(
			downloader.getTranslationsBundle(mockParams),
		).rejects.toMatchObject({
			message: mockError.message,
			code: mockError.code,
		});

		expect(attempts).toBe(1);
	});

	it("handles network failures", async () => {
		mockPool
			.intercept({
				path: downloadPath,
				method: "POST",
				body: JSON.stringify(mockParams),
			})
			.replyWithError(new Error("Connection lost"));

		const downloader = new FakeLokaliseDownload({ apiKey }, { projectId });

		await expect(
			downloader.getTranslationsBundle(mockParams),
		).rejects.toMatchObject({
			code: 500,
			details: { reason: "network or fetch error" },
		});
	});
});
