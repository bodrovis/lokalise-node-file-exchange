import type { QueuedProcess } from "@lokalise/node-api";
import { LokaliseApi, LokaliseApiOAuth } from "@lokalise/node-api";
import { logWithColor, logWithLevel } from "kliedz";
import { LokaliseFileExchange } from "../../lib/services/LokaliseFileExchange.js";
import { FakeLokaliseFileExchange } from "../fixtures/fake_classes/FakeLokaliseExchange.js";
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

describe("LokaliseFileExchange", () => {
	describe("Instance Creation", () => {
		it("should create an instance with valid parameters", () => {
			const exchange = new FakeLokaliseFileExchange(
				{
					apiKey: "abc123",
				},
				{ projectId: "123.abc" },
			);
			expect(exchange).toBeInstanceOf(LokaliseFileExchange);
			expect(exchange.getApiClient()).toBeInstanceOf(LokaliseApi);
			expect(exchange.getLogger()).toEqual(logWithColor);
			expect(exchange.getLogThreshold()).toEqual("info");
		});

		it("should create an OAuth2-based FakeLokaliseFileExchange with valid parameters", () => {
			const exchange = new FakeLokaliseFileExchange(
				{
					apiKey: "abc123",
				},
				{ projectId: "123.abc", useOAuth2: true },
			);
			expect(exchange).toBeInstanceOf(LokaliseFileExchange);
			expect(exchange.getApiClient()).toBeInstanceOf(LokaliseApiOAuth);
		});

		it("should create a logger without colors", () => {
			const exchange = new FakeLokaliseFileExchange(
				{
					apiKey: "abc123",
				},
				{ projectId: "123.abc", logColor: false },
			);

			expect(exchange.getLogger()).toEqual(logWithLevel);
		});

		it("should support silent mode", () => {
			const exchange = new FakeLokaliseFileExchange(
				{
					apiKey: "abc123",
				},
				{ projectId: "123.abc", logThreshold: "silent" },
			);

			expect(exchange.getLogger()).toEqual(logWithColor);
			expect(exchange.getApiClient().clientData.silent).toBe(true);
			expect(exchange.getLogThreshold()).toEqual("silent");
		});
	});

	describe("Error Handling", () => {
		describe("API Key Validation", () => {
			it("should throw an error if the API key is not provided", () => {
				expect(() => {
					new LokaliseFileExchange({ apiKey: "" }, { projectId: "123.abc" });
				}).toThrow(
					"Instantiation failed: A non-empty API key or JWT must be provided.",
				);
			});

			it("should throw an error if the API key is not a string", () => {
				expect(() => {
					new LokaliseFileExchange(
						{
							apiKey: 12345 as unknown as string,
						},
						{ projectId: "123.abc" },
					);
				}).toThrow(
					"Instantiation failed: A non-empty API key or JWT must be provided.",
				);
			});
		});

		describe("Project ID Validation", () => {
			it("should throw an error if the project ID is not provided", () => {
				expect(() => {
					new LokaliseFileExchange({ apiKey: "abc123" }, { projectId: "" });
				}).toThrow("Invalid or missing Project ID.");
			});

			it("should throw an error if the project ID is not a string", () => {
				expect(() => {
					new LokaliseFileExchange(
						{
							apiKey: "abc123",
						},
						{ projectId: 67890 as unknown as string },
					);
				}).toThrow("Invalid or missing Project ID.");
			});
		});

		describe("Retry Parameter Validation", () => {
			it("should throw an error when maxRetries is negative", () => {
				expect(() => {
					new LokaliseFileExchange(
						{
							apiKey: "abc123",
						},
						{ projectId: "123.abc", retryParams: { maxRetries: -1 } },
					);
				}).toThrow("maxRetries must be greater than or equal to zero.");
			});

			it("should throw an error when initialSleepTime is non-positive", () => {
				expect(() => {
					new LokaliseFileExchange(
						{
							apiKey: "abc123",
						},
						{ projectId: "123.abc", retryParams: { initialSleepTime: -1 } },
					);
				}).toThrow("initialSleepTime must be a positive value.");
			});

			it("should throw an error when jitterRatio is negative or greater than 1", () => {
				expect(() => {
					new LokaliseFileExchange(
						{
							apiKey: "abc123",
						},
						{ projectId: "123.abc", retryParams: { jitterRatio: -1 } },
					);
				}).toThrow("jitterRatio must be between 0 and 1.");
			});
		});

		describe("withExponentialBackoff", () => {
			it("should reach unreachable throw without using any", async () => {
				const exchanger = new FakeLokaliseFileExchange(
					{
						apiKey: "abc123",
					},
					{ projectId: "123.abc" },
				);

				Object.defineProperty(exchanger, "retryParams", {
					value: {
						maxRetries: -1,
						initialSleepTime: 0,
					},
				});

				await expect(
					exchanger.withExponentialBackoff(() => {
						throw new Error("this should never happen");
					}),
				).rejects.toThrow("Unexpected error during operation.");
			});
		});

		describe("getUpdatedProcess", () => {
			let mockAgent: MockAgent;

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

			it("should handle case when status is missing", async () => {
				const projectId = "123.abc";
				const processId = "123";

				const exchanger = new FakeLokaliseFileExchange(
					{
						apiKey: "abc123",
					},
					{ projectId },
				);

				const apiClient = exchanger.getApiClient();

				const getMock = vi.fn().mockResolvedValue({
					project_id: projectId,
					process_id: processId,
					type: "file-import",
				});

				vi.spyOn(apiClient, "queuedProcesses").mockReturnValue({
					get: getMock,
				} as unknown as ReturnType<typeof apiClient.queuedProcesses>);

				const process = await exchanger.getUpdatedProcess(processId);

				expect(getMock).toHaveBeenCalledWith(processId, {
					project_id: projectId,
				});

				expect(process.process_id).toEqual(processId);
				expect(process.status).toBeUndefined();
			});
		});

		describe("pollProcesses", () => {
			it("should warn when process cannot be fetched", async () => {
				const exchanger = new FakeLokaliseFileExchange(
					{ apiKey: "abc123" },
					{ projectId: "123.abc" },
				);

				const loggerSpy = vi.spyOn(exchanger, "logMsg").mockResolvedValue();

				const processId = "123";
				const fakeError = new Error("cannot get process");
				const process = { process_id: processId } as QueuedProcess;

				const fakeDatetime = "2025-05-10T12:00:00.000Z";
				vi.useFakeTimers().setSystemTime(new Date(fakeDatetime));

				const getProcessSpy = vi
					.spyOn(exchanger, "getUpdatedProcess")
					.mockImplementation(async () => {
						vi.advanceTimersByTime(1001);
						throw fakeError;
					});

				const pollPromise = exchanger.pollProcesses([process], 1, 1000);

				await vi.advanceTimersByTimeAsync(200);

				await pollPromise;

				expect(getProcessSpy).toHaveBeenCalledWith(processId);
				expect(loggerSpy).toHaveBeenCalledWith(
					"warn",
					`Failed to fetch process ${processId}:`,
					fakeError,
				);

				vi.useRealTimers();
			});

			it("should log status when it is present on process", async () => {
				const exchanger = new FakeLokaliseFileExchange(
					{ apiKey: "abc123" },
					{ projectId: "123.abc" },
				);

				const loggerSpy = vi.spyOn(exchanger, "logMsg").mockResolvedValue();

				const processId = "proc-1";
				const processes: QueuedProcess[] = [
					{
						process_id: processId,
						status: "finished",
					} as unknown as QueuedProcess,
				];

				const result = await exchanger.pollProcesses(processes, 1000, 1000);

				expect(result).toEqual(processes);

				expect(loggerSpy).toHaveBeenCalledWith(
					"debug",
					`Process ID: ${processId}, status: finished`,
				);

				expect(loggerSpy).not.toHaveBeenCalledWith(
					"debug",
					`Process ID: ${processId}, status is missing`,
				);
			});

			it("should throw if items array has missing entries", async () => {
				const exchanger = new FakeLokaliseFileExchange(
					{ apiKey: "abc123" },
					{ projectId: "123.abc" },
				);

				const ids: string[] = new Array(2);
				ids[1] = "123";

				await expect(exchanger.fetchProcessesBatch(ids, 2)).rejects.toThrow(
					"Missing item at index 0",
				);
			});

			it("should use final batch to update processes when pending remain", async () => {
				const exchanger = new FakeLokaliseFileExchange(
					{ apiKey: "abc123" },
					{ projectId: "123.abc" },
				);

				const pendingId = "proc-1";

				const initialProcesses: QueuedProcess[] = [
					{
						process_id: pendingId,
						status: "queued",
					} as unknown as QueuedProcess,
				];

				const finalProcess: QueuedProcess = {
					process_id: pendingId,
					status: "finished",
					type: "file-import",
				} as unknown as QueuedProcess;

				const fetchSpy = vi
					.spyOn(exchanger, "fetchProcessesBatch")
					.mockResolvedValue([{ id: pendingId, process: finalProcess }]);

				const result = await exchanger.pollProcesses(
					initialProcesses,
					1000,
					0, // maxWaitTime = 0 => while is ignored
				);

				expect(fetchSpy).toHaveBeenCalledTimes(1);
				expect(fetchSpy).toHaveBeenCalledWith([pendingId], expect.any(Number));

				expect(result).toHaveLength(1);
				expect(result[0]).toEqual(finalProcess);
			});
		});
	});
});
