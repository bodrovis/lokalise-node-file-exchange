import { LokaliseApi, LokaliseApiOAuth } from "@lokalise/node-api";
import { LokaliseFileExchange } from "../../lib/services/LokaliseFileExchange.js";
import { describe, expect, it } from "../setup.js";

describe("LokaliseFileExchange", () => {
	describe("Instance Creation", () => {
		it("should create an instance with valid parameters", () => {
			const exchange = new LokaliseFileExchange(
				{
					apiKey: "abc123",
				},
				{ projectId: "123.abc" },
			);
			expect(exchange).toBeInstanceOf(LokaliseFileExchange);
			expect(exchange.apiClient).toBeInstanceOf(LokaliseApi);
		});

		it("should create an OAuth2-based instance with valid parameters", () => {
			const exchange = new LokaliseFileExchange(
				{
					apiKey: "abc123",
				},
				{ projectId: "123.abc", useOAuth2: true },
			);
			expect(exchange).toBeInstanceOf(LokaliseFileExchange);
			expect(exchange.apiClient).toBeInstanceOf(LokaliseApiOAuth);
		});
	});

	describe("Error Handling", () => {
		describe("API Key Validation", () => {
			it("should throw an error if the API key is not provided", () => {
				expect(() => {
					new LokaliseFileExchange({ apiKey: "" }, { projectId: "123.abc" });
				}).toThrow("Invalid or missing API token.");
			});

			it("should throw an error if the API key is not a string", () => {
				expect(() => {
					new LokaliseFileExchange(
						{
							apiKey: 12345 as unknown as string,
						},
						{ projectId: "123.abc" },
					);
				}).toThrow("Invalid or missing API token.");
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
		});
	});
});
