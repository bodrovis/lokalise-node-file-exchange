import { LokaliseApi, LokaliseApiOAuth } from "@lokalise/node-api";
import { type LogFunction, logWithColor, logWithLevel } from "kliedz";
import { LokaliseFileExchange } from "../../lib/services/LokaliseFileExchange.js";
import { FakeLokaliseFileExchange } from "../fixtures/fake_classes/FakeLokaliseExchange.js";
import { describe, expect, it } from "../setup.js";

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
	});
});
