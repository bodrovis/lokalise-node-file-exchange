import { ApiError as LokaliseApiError } from "@lokalise/node-api";
import { getGlobalDispatcher } from "undici";
import { FakeLokaliseUpload } from "../../fixtures/fake-classes/FakeLokaliseUpload.js";
import type { Interceptable } from "../../setup.js";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	MockAgent,
	setGlobalDispatcher,
} from "../../setup.js";

describe("LokaliseUpload: uploadSingleFile()", () => {
	const projectId = "803826145ba90b42d5d860.46800099";
	const apiKey = "test-api-key";

	const mockParams = {
		filename: "test.json",
		lang_iso: "en",
		data: "base64encodedcontent",
	};

	const mockProcess = {
		process_id: "123abc",
		type: "file-import",
		status: "queued",
		message: "",
		created_by: 20181,
		created_by_email: "test@example.com",
		created_at: "2023-09-21 11:33:19 (Etc/UTC)",
		created_at_timestamp: 1695295999,
	};

	const request = {
		path: `/api2/projects/${projectId}/files/upload`,
		method: "POST" as const,
		body: JSON.stringify(mockParams),
	};

	const successResponse = {
		project_id: projectId,
		branch: "master",
		process: mockProcess,
	};

	const originalDispatcher = getGlobalDispatcher();

	let mockAgent: MockAgent;
	let mockPool: Interceptable;

	beforeAll(() => {
		mockAgent = new MockAgent();
		setGlobalDispatcher(mockAgent);
		mockAgent.disableNetConnect();
	});

	afterAll(async () => {
		setGlobalDispatcher(originalDispatcher);
		await mockAgent.close();
	});

	beforeEach(() => {
		mockPool = mockAgent.get("https://api.lokalise.com");
	});

	describe("Successful Upload", () => {
		it("uploads a file and returns a queued process", async () => {
			mockPool.intercept(request).reply(200, successResponse);

			const uploader = new FakeLokaliseUpload({ apiKey }, { projectId });

			const process = await uploader.uploadSingleFile(mockParams);

			expect(process).toEqual(mockProcess);
		});
	});

	describe("Retry Logic", () => {
		it("retries on 429 errors until the upload succeeds", async () => {
			const maxRetries = 3;
			let attempts = 0;

			const uploader = new FakeLokaliseUpload(
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

			mockPool
				.intercept(request)
				.reply(() => {
					attempts++;

					if (attempts < 3) {
						return {
							statusCode: 429,
							data: JSON.stringify({
								message: "Too Many Requests",
								code: 429,
							}),
						};
					}

					return {
						statusCode: 200,
						data: JSON.stringify(successResponse),
					};
				})
				.times(3);

			const result = await uploader.uploadSingleFile(mockParams);

			expect(result).toEqual(mockProcess);
			expect(attempts).toBe(3);
		});

		it("attempts an upload when maxRetries is zero", async () => {
			const uploader = new FakeLokaliseUpload(
				{ apiKey },
				{ projectId, retryParams: { maxRetries: 0 } },
			);

			mockPool.intercept(request).reply(200, successResponse);

			const result = await uploader.uploadSingleFile(mockParams);

			expect(result.process_id).toBe(mockProcess.process_id);
		});

		it("does not retry failed requests when maxRetries is zero", async () => {
			const uploader = new FakeLokaliseUpload(
				{ apiKey },
				{ projectId, retryParams: { maxRetries: 0 } },
			);

			let attempts = 0;

			mockPool.intercept(request).reply(() => {
				attempts++;

				return {
					statusCode: 429,
					data: JSON.stringify({
						message: "Too Many Requests",
						code: 429,
					}),
				};
			});

			await expect(uploader.uploadSingleFile(mockParams)).rejects.toMatchObject(
				{
					code: 429,
					message: "Maximum retries reached: Too Many Requests",
				},
			);

			expect(attempts).toBe(1);
		});

		it("throws after exhausting retries on 408 errors", async () => {
			const maxRetries = 3;
			let attempts = 0;

			const uploader = new FakeLokaliseUpload(
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

			mockPool
				.intercept(request)
				.reply(() => {
					attempts++;

					return {
						statusCode: 408,
						data: JSON.stringify({
							message: "Request Timeout",
							code: 408,
						}),
					};
				})
				.times(maxRetries + 1);

			await expect(uploader.uploadSingleFile(mockParams)).rejects.toMatchObject(
				{
					message: "Maximum retries reached: Request Timeout",
					code: 408,
					cause: expect.any(LokaliseApiError),
				},
			);

			expect(attempts).toBe(maxRetries + 1);
		});
	});

	describe("Error Handling", () => {
		it("wraps non-retryable API errors without retrying", async () => {
			const uploader = new FakeLokaliseUpload({ apiKey }, { projectId });

			let attempts = 0;

			mockPool.intercept(request).reply(() => {
				attempts++;

				return {
					statusCode: 403,
					data: JSON.stringify({
						message: "Forbidden",
						code: 403,
					}),
				};
			});

			await expect(uploader.uploadSingleFile(mockParams)).rejects.toMatchObject(
				{
					message: "Forbidden",
					code: 403,
					cause: expect.any(LokaliseApiError),
				},
			);

			expect(attempts).toBe(1);
		});
	});
});
