import type { DownloadBundle, DownloadFileParams } from "@lokalise/node-api";
import { LokaliseDownload } from "../../../lib/services/LokaliseDownload.js";
import {
	MockAgent,
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	setGlobalDispatcher,
} from "../../setup.js";
import type { Interceptable } from "../../setup.js";

describe("LokaliseDownload: download()", () => {
	const projectId = "803826145ba90b42d5d860.46800099";
	const apiKey = process.env.API_KEY as string;
	const mockParams: DownloadFileParams = {
		format: "json",
		original_filenames: true,
	};

	let downloader: LokaliseDownload;
	let mockAgent: MockAgent;
	let mockPool: Interceptable;

	beforeEach(() => {
		downloader = new LokaliseDownload({ apiKey, projectId });
		mockAgent = new MockAgent();
		setGlobalDispatcher(mockAgent);
		mockAgent.disableNetConnect();

		mockPool = mockAgent.get("https://api.lokalise.com");
	});

	afterEach(() => {
		mockAgent.close();
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

		const result = (await downloader.download(mockParams)) as DownloadBundle;

		expect(result.project_id).to.eq(projectId);
		expect(result.bundle_url).to.eq(mockResponse.bundle_url);
	});

	describe("error handling", () => {
		it("should handle known error responses", async () => {
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

			const result = await downloader.download(mockParams);

			expect(result).to.deep.eq(mockError);
		});

		it("should retry on 429 errors with exponential backoff", async () => {
			const mockResponse = {
				project_id: projectId,
				bundle_url: "https://example.com/fake-bundle-url",
			};

			let callCount = 0;
			const retries = 3;
			const sleepTime = 1;

			mockPool
				.intercept({
					path: `/api2/projects/${projectId}/files/download`,
					method: "POST",
					body: JSON.stringify(mockParams),
				})
				.reply(() => {
					callCount++;
					if (callCount < 3) {
						return {
							statusCode: 429,
							data: JSON.stringify({ message: "Too Many Requests", code: 429 }),
						};
					}
					// Return 200 for the third call
					return {
						statusCode: 200,
						data: JSON.stringify(mockResponse),
					};
				})
				.times(retries);

			const result = await downloader.download(mockParams, {
				maxRetries: retries,
				initialSleepTime: sleepTime,
			});

			expect(result).to.deep.eq(mockResponse);
			expect(callCount).to.equal(3);
		});

		it("should return an error after maximum retries for 429", async () => {
			const maxRetries = 2;
			const initialSleepTime = 2;

			mockPool
				.intercept({
					path: `/api2/projects/${projectId}/files/download`,
					method: "POST",
					body: JSON.stringify(mockParams),
				})
				.reply(429, { message: "Too Many Requests", code: 429 })
				.times(maxRetries);

			const result = await downloader.download(mockParams, {
				maxRetries,
				initialSleepTime,
			});

			expect(result).to.deep.eq({
				message: "Maximum retries reached",
				code: 429,
			});
		});

		it("should return unexpected error when a non-structured error is thrown", async () => {
			mockPool
				.intercept({
					path: `/api2/projects/${projectId}/files/download`,
					method: "POST",
					body: JSON.stringify(mockParams),
				})
				.replyWithError(new Error("Some unhandled exception"));

			const result = await downloader.download(mockParams);

			expect(result).toEqual({
				message: "An unexpected error occurred",
				code: 500,
			});
		});

		it("should throw 'Unexpected error handling logic' when maxRetries is negative", async () => {
			await expect(
				downloader.download(mockParams, { maxRetries: -1 }),
			).rejects.toThrow("Unexpected error handling logic");
		});
	});
});
