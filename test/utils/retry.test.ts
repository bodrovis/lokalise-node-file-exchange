import { ApiError as LokaliseApiError } from "@lokalise/node-api";
import { DEFAULT_RETRY_PARAMS } from "../../lib/constants.js";
import { LokaliseError } from "../../lib/errors/LokaliseError.js";
import type { RetryParams } from "../../lib/interfaces/index.js";
import {
	calculateSleepMs,
	resolveRetryParams,
	validateRetryParams,
	withExponentialBackoff,
} from "../../lib/utils/retry.js";
import { describe, expect, it, vi } from "../setup.js";

const MAX_TIMEOUT_MS = 2_147_483_647;

function params(overrides: Partial<RetryParams> = {}): RetryParams {
	return { ...DEFAULT_RETRY_PARAMS, ...overrides };
}

describe("validateRetryParams()", () => {
	it("accepts valid settings, including boundary values", () => {
		expect(() => validateRetryParams(params())).not.toThrow();
		expect(() =>
			validateRetryParams(
				params({
					maxRetries: 0,
					initialSleepTime: 1,
					maxSleepTime: 1,
					jitterRatio: 0,
				}),
			),
		).not.toThrow();
		expect(() =>
			validateRetryParams(
				params({
					maxRetries: 10,
					maxSleepTime: MAX_TIMEOUT_MS,
					jitterRatio: 1,
				}),
			),
		).not.toThrow();
	});

	it.each([
		{
			name: "negative retries",
			changes: { maxRetries: -1 },
			message: "maxRetries",
		},
		{
			name: "fractional retries",
			changes: { maxRetries: 1.5 },
			message: "maxRetries",
		},
		{
			name: "too many retries",
			changes: { maxRetries: 11 },
			message: "maxRetries",
		},
		{
			name: "NaN retries",
			changes: { maxRetries: NaN },
			message: "maxRetries",
		},
		{
			name: "infinite retries",
			changes: { maxRetries: Infinity },
			message: "maxRetries",
		},
		{
			name: "zero initial delay",
			changes: { initialSleepTime: 0 },
			message: "initialSleepTime",
		},
		{
			name: "negative initial delay",
			changes: { initialSleepTime: -1 },
			message: "initialSleepTime",
		},
		{
			name: "NaN initial delay",
			changes: { initialSleepTime: NaN },
			message: "initialSleepTime",
		},
		{
			name: "infinite initial delay",
			changes: { initialSleepTime: Infinity },
			message: "initialSleepTime",
		},
		{
			name: "maximum below initial",
			changes: { maxSleepTime: 0 },
			message: "maxSleepTime",
		},
		{
			name: "NaN maximum",
			changes: { maxSleepTime: NaN },
			message: "maxSleepTime",
		},
		{
			name: "infinite maximum",
			changes: { maxSleepTime: Infinity },
			message: "maxSleepTime",
		},
		{
			name: "maximum above Node timer limit",
			changes: { maxSleepTime: MAX_TIMEOUT_MS + 1 },
			message: "maxSleepTime",
		},
		{
			name: "negative jitter",
			changes: { jitterRatio: -0.1 },
			message: "jitterRatio",
		},
		{
			name: "jitter greater than one",
			changes: { jitterRatio: 1.1 },
			message: "jitterRatio",
		},
		{
			name: "NaN jitter",
			changes: { jitterRatio: NaN },
			message: "jitterRatio",
		},
		{
			name: "infinite jitter",
			changes: { jitterRatio: Infinity },
			message: "jitterRatio",
		},
	])("rejects $name", ({ changes, message }) => {
		expect(() => validateRetryParams(params(changes))).toThrow(message);
	});

	it("rejects an rng that is not a function", () => {
		const invalid = params({ rng: null as unknown as RetryParams["rng"] });
		expect(() => validateRetryParams(invalid)).toThrow(
			"rng must be a function",
		);
	});
});

describe("calculateSleepMs()", () => {
	it("calculates exponential delays starting from retry number one", () => {
		const config = params({
			initialSleepTime: 100,
			maxSleepTime: 250,
			jitterRatio: 0,
		});

		expect(
			[1, 2, 3, 4].map((retry) => calculateSleepMs(config, retry)),
		).toEqual([100, 200, 250, 250]);
	});

	it("does not call rng when jitter is disabled", () => {
		const rng = vi.fn(() => NaN);
		expect(
			calculateSleepMs(
				params({ initialSleepTime: 25, jitterRatio: 0, rng }),
				1,
			),
		).toBe(25);
		expect(rng).not.toHaveBeenCalled();
	});

	it.each([
		{ random: 0, expected: 50 },
		{ random: 0.5, expected: 100 },
		{ random: 0.99, expected: 149 },
	])("applies symmetric jitter for rng=$random", ({ random, expected }) => {
		const rng = vi.fn(() => random);
		const config = params({
			initialSleepTime: 100,
			maxSleepTime: 300,
			jitterRatio: 0.5,
			rng,
		});

		expect(calculateSleepMs(config, 1)).toBe(expected);
		expect(rng).toHaveBeenCalledOnce();
	});

	it("caps positive jitter at maxSleepTime", () => {
		const config = params({
			initialSleepTime: 100,
			maxSleepTime: 150,
			jitterRatio: 1,
			rng: () => 0.99,
		});

		expect(calculateSleepMs(config, 2)).toBe(150);
	});

	it("never returns less than one millisecond", () => {
		const config = params({
			initialSleepTime: 1,
			maxSleepTime: 10,
			jitterRatio: 1,
			rng: () => 0,
		});
		expect(calculateSleepMs(config, 1)).toBe(1);
	});

	it.each([0, -1, 1.5, NaN, Infinity])(
		"rejects invalid retry number %s",
		(retryNumber) => {
			expect(() => calculateSleepMs(params(), retryNumber)).toThrow(
				"retryNumber must be a positive integer",
			);
		},
	);

	it.each([-0.1, 1, NaN, Infinity, -Infinity])(
		"rejects invalid rng result %s when jitter is enabled",
		(random) => {
			const config = params({ jitterRatio: 0.5, rng: () => random });
			expect(() => calculateSleepMs(config, 1)).toThrow(
				"rng must return a finite number",
			);
		},
	);
});

describe("withExponentialBackoff()", () => {
	const quick = (): RetryParams =>
		params({
			maxRetries: 2,
			initialSleepTime: 1,
			maxSleepTime: 4,
			jitterRatio: 0,
		});

	it("returns the first successful result without retries", async () => {
		const result = { ok: true };
		const operation = vi.fn(async () => result);

		await expect(withExponentialBackoff(operation, quick())).resolves.toBe(
			result,
		);
		expect(operation).toHaveBeenCalledOnce();
	});

	it("tries exactly once with maxRetries=0", async () => {
		const operation = vi.fn(async () => {
			throw new LokaliseApiError("Rate limited", 429);
		});

		await expect(
			withExponentialBackoff(operation, params({ maxRetries: 0 })),
		).rejects.toThrow("Maximum retries reached: Rate limited");
		expect(operation).toHaveBeenCalledOnce();
	});

	it.each([408, 429])(
		"retries SDK error %i until the operation succeeds",
		async (code) => {
			let attempts = 0;
			const operation = vi.fn(async () => {
				attempts++;
				if (attempts <= 2)
					throw new LokaliseApiError("Temporary failure", code);
				return "completed";
			});

			await expect(withExponentialBackoff(operation, quick())).resolves.toBe(
				"completed",
			);
			expect(operation).toHaveBeenCalledTimes(3);
		},
	);

	it("preserves the last SDK error as cause when retries are exhausted", async () => {
		let lastError: LokaliseApiError | undefined;
		const operation = vi.fn(async (): Promise<void> => {
			lastError = new LokaliseApiError("Too Many Requests", 429, {
				reason: "rate limit",
			});
			throw lastError;
		});

		let thrown: unknown;
		try {
			await withExponentialBackoff(operation, quick());
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBeInstanceOf(LokaliseError);
		if (!(thrown instanceof LokaliseError)) return;

		expect(thrown.message).toBe("Maximum retries reached: Too Many Requests");
		expect(thrown.code).toBe(429);
		expect(thrown.details).toEqual({ reason: "rate limit" });
		expect(thrown.cause).toBe(lastError);
		expect(operation).toHaveBeenCalledTimes(3);
	});

	it("wraps non-retryable SDK errors without retrying", async () => {
		const original = new LokaliseApiError("Invalid request", 400, {
			field: "format",
		});
		const operation = vi.fn(async (): Promise<void> => {
			throw original;
		});

		let thrown: unknown;
		try {
			await withExponentialBackoff(operation, quick());
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBeInstanceOf(LokaliseError);
		if (!(thrown instanceof LokaliseError)) return;

		expect(thrown.message).toBe("Invalid request");
		expect(thrown.code).toBe(400);
		expect(thrown.details).toEqual({ field: "format" });
		expect(thrown.cause).toBe(original);
		expect(operation).toHaveBeenCalledOnce();
	});

	it("propagates non-SDK errors unchanged", async () => {
		const original = new Error("Connection failed");
		const operation = vi.fn(async (): Promise<void> => {
			throw original;
		});

		await expect(withExponentialBackoff(operation, quick())).rejects.toBe(
			original,
		);
		expect(operation).toHaveBeenCalledOnce();
	});

	it("propagates synchronous exceptions from the operation unchanged", async () => {
		const original = new Error("Synchronous failure");
		const operation = vi.fn((): Promise<void> => {
			throw original;
		});

		await expect(withExponentialBackoff(operation, quick())).rejects.toBe(
			original,
		);
		expect(operation).toHaveBeenCalledOnce();
	});

	it("rejects invalid parameters before invoking the operation", async () => {
		const operation = vi.fn(async () => "should not execute");

		await expect(
			withExponentialBackoff(operation, params({ maxRetries: -1 })),
		).rejects.toBeInstanceOf(LokaliseError);
		expect(operation).not.toHaveBeenCalled();
	});

	it("does not start an operation when the signal is already aborted", async () => {
		const controller = new AbortController();
		const reason = new Error("Cancelled before start");
		controller.abort(reason);
		const operation = vi.fn(async () => "should not execute");

		await expect(
			withExponentialBackoff(operation, quick(), {
				signal: controller.signal,
			}),
		).rejects.toBe(reason);
		expect(operation).not.toHaveBeenCalled();
	});

	it("does not retry when the signal aborts during a failed operation", async () => {
		const controller = new AbortController();
		const reason = new Error("Cancelled during operation");
		const operation = vi.fn(async (): Promise<void> => {
			controller.abort(reason);
			throw new LokaliseApiError("Temporary failure", 429);
		});

		await expect(
			withExponentialBackoff(operation, quick(), {
				signal: controller.signal,
			}),
		).rejects.toBe(reason);
		expect(operation).toHaveBeenCalledOnce();
	});

	it("interrupts the backoff sleep when the signal aborts", async () => {
		const controller = new AbortController();
		const operation = vi.fn(async (): Promise<void> => {
			throw new LokaliseApiError("Rate limited", 429);
		});
		const onDebug = vi.fn((message: string) => {
			if (message.startsWith("Retryable error")) controller.abort();
		});

		await expect(
			withExponentialBackoff(
				operation,
				params({
					maxRetries: 2,
					initialSleepTime: 1000,
					maxSleepTime: 1000,
					jitterRatio: 0,
				}),
				{ signal: controller.signal, onDebug },
			),
		).rejects.toMatchObject({ name: "AbortError" });

		expect(operation).toHaveBeenCalledOnce();
		expect(onDebug).toHaveBeenCalledWith(
			"Retryable error (429). Waiting 1000ms before retry...",
		);
	});

	it("logs the capped backoff delays", async () => {
		let attempts = 0;
		const messages: string[] = [];
		const operation = vi.fn(async () => {
			attempts++;
			if (attempts < 3) throw new LokaliseApiError("Temporary failure", 408);
			return "ok";
		});

		await expect(
			withExponentialBackoff(
				operation,
				params({
					maxRetries: 2,
					initialSleepTime: 2,
					maxSleepTime: 3,
					jitterRatio: 0,
				}),
				{ onDebug: (message) => messages.push(message) },
			),
		).resolves.toBe("ok");

		expect(messages).toContain("Attempt #1...");
		expect(messages).toContain("Attempt #2...");
		expect(messages).toContain("Attempt #3...");
		expect(messages).toContain(
			"Retryable error (408). Waiting 2ms before retry...",
		);
		expect(messages).toContain(
			"Retryable error (408). Waiting 3ms before retry...",
		);
	});
});

describe("resolveRetryParams()", () => {
	it("returns a new configuration with all defaults", () => {
		const resolved = resolveRetryParams();

		expect(resolved).toEqual(DEFAULT_RETRY_PARAMS);
		expect(resolved).not.toBe(DEFAULT_RETRY_PARAMS);
	});

	it("merges overrides while keeping the other defaults", () => {
		const rng = () => 0.3;
		const overrides = { maxRetries: 0, jitterRatio: 0, rng };
		const resolved = resolveRetryParams(overrides);

		expect(resolved).toEqual({
			...DEFAULT_RETRY_PARAMS,
			maxRetries: 0,
			jitterRatio: 0,
			rng,
		});
		expect(resolved.rng).toBe(rng);
		expect(overrides).toEqual({ maxRetries: 0, jitterRatio: 0, rng });
	});
});
