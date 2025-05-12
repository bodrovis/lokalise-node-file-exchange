import { LokaliseApi, LokaliseApiOAuth } from "@lokalise/node-api";
import type { QueuedProcess } from "@lokalise/node-api";
import { logWithColor, logWithLevel } from "kliedz";
import { LokaliseFileExchange } from "../../lib/services/LokaliseFileExchange.js";
import { FakeLokaliseFileExchange } from "../fixtures/fake_classes/FakeLokaliseExchange.js";
import {
	type Interceptable,
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
			let mockPool: Interceptable;

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

			it("should use queued status by default", async () => {
				const projectId = "123.abc";
				const processId = "123";

				const exchanger = new FakeLokaliseFileExchange(
					{
						apiKey: "abc123",
					},
					{ projectId },
				);

				mockPool
					.intercept({
						path: `/api2/projects/${projectId}/processes/${processId}`,
						method: "GET",
					})
					.reply(200, {
						project_id: projectId,
						process: {
							process_id: processId,
							type: "file-import",
						},
					});

				const process = await exchanger.getUpdatedProcess(processId);

				expect(process.process_id).toEqual(processId);
				expect(process.status).toEqual("queued");
			});
		});

		describe("pollProcesses", () => {
			it("should warn when process cannot be fetched", async () => {
				const exchanger = new FakeLokaliseFileExchange(
					{
						apiKey: "abc123",
					},
					{ projectId: "123.abc" },
				);

				const loggerSpy = vi.spyOn(exchanger, "logMsg").mockResolvedValue();

				const processId = "123";
				const fakeError = new Error("cannot get process");
				const process = {
					process_id: processId,
				} as QueuedProcess;

				const fakeDatetime = "2025-05-10T12:00:00.000Z";
				const mockDate = new Date(fakeDatetime);
				vi.useFakeTimers().setSystemTime(mockDate);

				const getProcessSpy = vi
					.spyOn(exchanger, "getUpdatedProcess")
					.mockImplementation(async () => {
						vi.advanceTimersByTime(1001);
						throw fakeError;
					});

				await exchanger.pollProcesses([process], 1, 1000);

				expect(getProcessSpy).toHaveBeenCalledWith(process.process_id);
				expect(loggerSpy).toHaveBeenCalledWith(
					"warn",
					`Failed to fetch process ${processId}:`,
					fakeError,
				);

				vi.useRealTimers();
			});
		});
	});
});
