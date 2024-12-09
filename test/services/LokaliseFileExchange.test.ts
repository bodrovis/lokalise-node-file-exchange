import { LokaliseFileExchange } from "../../lib/services/LokaliseFileExchange.js";
import { describe, expect, it } from "../setup.js";

describe("LokaliseFileExchange", () => {
	it("should create an instance with valid parameters", () => {
		const exchange = new LokaliseFileExchange(
			{
				apiKey: "abc123",
			},
			{ projectId: "123.abc" },
		);
		expect(exchange).toBeInstanceOf(LokaliseFileExchange);
	});

	describe("error handling", () => {
		it("should throw an error if the API key is not provided", () => {
			expect(() => {
				new LokaliseFileExchange({ apiKey: "" }, { projectId: "123.abc" });
			}).toThrow("Invalid or missing API token.");
		});

		it("should throw an error if the project ID is not provided", () => {
			expect(() => {
				new LokaliseFileExchange({ apiKey: "abc123" }, { projectId: "" });
			}).toThrow("Invalid or missing Project ID.");
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

		it("should throw an error when maxRetries is negative", async () => {
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
