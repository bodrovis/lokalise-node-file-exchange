import { LokaliseError } from "../../../lib/errors/LokaliseError.js";
import { LokaliseUpload } from "../../../lib/services/LokaliseUpload.js";
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

describe("LokaliseUpload: uploadSingleFile()", () => {
	const projectId = "803826145ba90b42d5d860.46800099";
	const apiKey = process.env.API_KEY as string;
	let mockAgent: MockAgent;
	let mockPool: Interceptable;

	const mockParams = {
		filename: "test.json",
		lang_iso: "en",
		data: "base64encodedcontent",
	};

	beforeAll(() => {
		mockAgent = new MockAgent();
		setGlobalDispatcher(mockAgent);
		mockAgent.disableNetConnect();
	});

	afterAll(() => {
		mockAgent.close();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	beforeEach(() => {
		mockPool = mockAgent.get("https://api.lokalise.com");
	});

	it("should successfully upload a file and return a queued process", async () => {
		const uploader = new LokaliseUpload({ apiKey }, { projectId });
		const processId = "123abc";

		mockPool
			.intercept({
				path: `/api2/projects/${projectId}/files/upload`,
				method: "POST",
				body: JSON.stringify(mockParams),
			})
			.reply(200, {
				project_id: projectId,
				branch: "master",
				process: {
					process_id: processId,
					type: "file-import",
					status: "queued",
					message: "",
					created_by: 20181,
					created_by_email: "test@example.com",
					created_at: "2023-09-21 11:33:19 (Etc/UTC)",
					created_at_timestamp: 1695295999,
				},
			});
		const process = await uploader.uploadSingleFile(mockParams);

		expect(process.process_id).toEqual(processId);
		expect(process.status).toEqual("queued");
	});

	it("should retry on 429 errors with exponential backoff", async () => {
		const processId = "123abc";
		const mockResponse = {
			process_id: processId,
			type: "file-import",
			status: "queued",
			message: "",
			created_by: 20181,
			created_by_email: "test@example.com",
			created_at: "2023-09-21 11:33:19 (Etc/UTC)",
			created_at_timestamp: 1695295999,
		};

		const retries = 3;
		const sleepTime = 1;
		const uploader = new LokaliseUpload(
			{ apiKey },
			{
				projectId,
				retryParams: { maxRetries: retries, initialSleepTime: sleepTime },
			},
		);
		const sleepSpy = vi
			.spyOn(uploader as any, "sleep")
			.mockResolvedValue(undefined);

		let callCount = 0;

		mockPool
			.intercept({
				path: `/api2/projects/${projectId}/files/upload`,
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
					data: JSON.stringify({ process: mockResponse }),
				};
			})
			.times(retries);

		const result = await uploader.uploadSingleFile(mockParams);

		expect(result).toEqual(mockResponse);
		expect(callCount).toBe(retries);
		expect(sleepSpy).toHaveBeenCalledTimes(retries - 1);
		expect(sleepSpy).toHaveBeenNthCalledWith(1, sleepTime * 2 ** 0);
		expect(sleepSpy).toHaveBeenNthCalledWith(2, sleepTime * 2 ** 1);
	});

	it("should throw a LokaliseError for known error responses", async () => {
		const mockError = {
			message: "Unauthorized",
			code: 403,
		};

		mockPool
			.intercept({
				path: `/api2/projects/${projectId}/files/upload`,
				method: "POST",
				body: JSON.stringify(mockParams),
			})
			.reply(403, mockError);

		const uploader = new LokaliseUpload({ apiKey }, { projectId });
		await expect(uploader.uploadSingleFile(mockParams)).rejects.toThrow(
			new LokaliseError(mockError.message, mockError.code),
		);
	});

	it("should throw a LokaliseError after exceeding retries on 408 errors", async () => {
		const retries = 3;
		const sleepTime = 1;
		const uploader = new LokaliseUpload(
			{ apiKey },
			{
				projectId,
				retryParams: { maxRetries: retries, initialSleepTime: sleepTime },
			},
		);

		const sleepSpy = vi
			.spyOn(uploader as any, "sleep")
			.mockResolvedValue(undefined);

		mockPool
			.intercept({
				path: `/api2/projects/${projectId}/files/upload`,
				method: "POST",
				body: JSON.stringify(mockParams),
			})
			.reply(408, { message: "Request Timeout", code: 408 })
			.times(retries + 1);

		try {
			await uploader.uploadSingleFile(mockParams);
		} catch (e) {
			expect(e).toBeInstanceOf(LokaliseError);
			expect(e.message).toEqual("Maximum retries reached: Request Timeout");
			expect(e.code).toEqual(408);
			expect(e.details).toEqual({ reason: "server error without details" });
		}

		expect(sleepSpy).toHaveBeenCalledTimes(retries);
		expect(sleepSpy).toHaveBeenNthCalledWith(1, sleepTime * 2 ** 0);
		expect(sleepSpy).toHaveBeenNthCalledWith(2, sleepTime * 2 ** 1);
		expect(sleepSpy).toHaveBeenNthCalledWith(3, sleepTime * 2 ** 2);
	});
});
