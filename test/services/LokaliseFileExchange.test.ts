import { LokaliseApi, LokaliseApiOAuth } from "@lokalise/node-api";
import { logWithColor, logWithLevel } from "kliedz";
import { DEFAULT_RETRY_PARAMS } from "../../lib/constants.js";
import { LokaliseError } from "../../lib/errors/LokaliseError.js";
import type { RetryParams } from "../../lib/interfaces/index.js";
import { LokaliseFileExchange } from "../../lib/services/LokaliseFileExchange.js";
import { FakeLokaliseFileExchange } from "../fixtures/fake-classes/FakeLokaliseExchange.js";
import { describe, expect, it } from "../setup.js";

const clientConfig = { apiKey: "abc123" };
const projectId = "123.abc";

describe("LokaliseFileExchange", () => {
	describe("Instance Creation", () => {
		it("creates an instance with default configuration", () => {
			const exchange = new FakeLokaliseFileExchange(clientConfig, {
				projectId,
			});

			expect(exchange).toBeInstanceOf(LokaliseFileExchange);
			expect(exchange.getApiClient()).toBeInstanceOf(LokaliseApi);
			expect(exchange.getLogger()).toBe(logWithColor);
			expect(exchange.getLogThreshold()).toBe("info");
			expect(exchange.getRetryParams()).toEqual(DEFAULT_RETRY_PARAMS);
		});

		it("creates an OAuth2 client", () => {
			const exchange = new FakeLokaliseFileExchange(clientConfig, {
				projectId,
				useOAuth2: true,
			});

			expect(exchange.getApiClient()).toBeInstanceOf(LokaliseApiOAuth);
		});

		it("creates a logger without colors", () => {
			const exchange = new FakeLokaliseFileExchange(clientConfig, {
				projectId,
				logColor: false,
			});

			expect(exchange.getLogger()).toBe(logWithLevel);
		});

		it("supports silent mode", () => {
			const exchange = new FakeLokaliseFileExchange(clientConfig, {
				projectId,
				logThreshold: "silent",
			});

			expect(exchange.getLogger()).toBe(logWithColor);
			expect(exchange.getApiClient().clientData.silent).toBe(true);
			expect(exchange.getLogThreshold()).toBe("silent");
		});

		it("preserves explicitly configured SDK silent mode", () => {
			const exchange = new FakeLokaliseFileExchange(
				{ ...clientConfig, silent: true },
				{ projectId, logThreshold: "debug" },
			);

			expect(exchange.getApiClient().clientData.silent).toBe(true);
			expect(exchange.getLogThreshold()).toBe("debug");
		});

		it("does not mutate the original client configuration", () => {
			const config = { ...clientConfig, silent: false };

			new FakeLokaliseFileExchange(config, {
				projectId,
				logThreshold: "silent",
			});

			expect(config.silent).toBe(false);
		});

		it("resolves custom retry parameters", () => {
			const rng = () => 0.5;

			const exchange = new FakeLokaliseFileExchange(clientConfig, {
				projectId,
				retryParams: {
					maxRetries: 0,
					initialSleepTime: 1500,
					maxSleepTime: 5000,
					jitterRatio: 0,
					rng,
				},
			});

			expect(exchange.getRetryParams()).toEqual({
				maxRetries: 0,
				initialSleepTime: 1500,
				maxSleepTime: 5000,
				jitterRatio: 0,
				rng,
			});
		});

		it("uses defaults for omitted retry parameters", () => {
			const exchange = new FakeLokaliseFileExchange(clientConfig, {
				projectId,
				retryParams: { maxRetries: 2 },
			});

			expect(exchange.getRetryParams()).toEqual({
				...DEFAULT_RETRY_PARAMS,
				maxRetries: 2,
			});
		});
	});

	describe("Error Handling", () => {
		describe("API Key Validation", () => {
			it.each([
				["empty", ""],
				["incorrect type", 12345],
			])("rejects an %s API key", (_description, apiKey) => {
				expect(
					() =>
						new FakeLokaliseFileExchange(
							{ apiKey: apiKey as unknown as string },
							{ projectId },
						),
				).toThrow(/non-empty API key or JWT/);
			});
		});

		describe("Project ID Validation", () => {
			it.each([
				["empty", ""],
				["whitespace-only", "  \n  "],
				["incorrect type", 67890],
			])("rejects a %s project ID", (_description, invalidId) => {
				expect(
					() =>
						new FakeLokaliseFileExchange(clientConfig, {
							projectId: invalidId as unknown as string,
						}),
				).toThrow("Invalid or missing Project ID.");
			});
		});

		describe("Retry Parameter Validation", () => {
			const invalidCases: Array<[string, Partial<RetryParams>]> = [
				["negative maxRetries", { maxRetries: -1 }],
				["fractional maxRetries", { maxRetries: 1.5 }],
				["non-positive initialSleepTime", { initialSleepTime: 0 }],
				["non-finite initialSleepTime", { initialSleepTime: Infinity }],
				["negative maxSleepTime", { maxSleepTime: -1 }],
				["negative jitterRatio", { jitterRatio: -0.1 }],
				["jitterRatio greater than 1", { jitterRatio: 1.1 }],
				["invalid rng", { rng: 123 as unknown as () => number }],
			];

			it.each(invalidCases)("rejects %s", (_description, retryParams) => {
				expect(
					() =>
						new FakeLokaliseFileExchange(clientConfig, {
							projectId,
							retryParams,
						}),
				).toThrow(LokaliseError);
			});
		});
	});
});
