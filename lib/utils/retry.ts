import { setTimeout as sleep } from "node:timers/promises";
import { ApiError as LokaliseApiError } from "@lokalise/node-api";
import { DEFAULT_RETRY_PARAMS, RETRYABLE_CODES } from "../constants.js";
import { LokaliseError } from "../errors/LokaliseError.js";
import type { RetryParams } from "../interfaces/index.js";

const MAX_TIMEOUT_MS = 2_147_483_647;
const MAX_ALLOWED_RETRIES = 10;

export interface RetryOptions {
	signal?: AbortSignal;
	onDebug?: (message: string) => void;
}

/**
 * Validates retry configuration.
 */
export function validateRetryParams(params: RetryParams): void {
	const { maxRetries, initialSleepTime, maxSleepTime, jitterRatio, rng } =
		params;

	if (
		!Number.isSafeInteger(maxRetries) ||
		maxRetries < 0 ||
		maxRetries > MAX_ALLOWED_RETRIES
	) {
		throw new LokaliseError(
			`maxRetries must be an integer between 0 and ${MAX_ALLOWED_RETRIES}.`,
		);
	}

	if (!Number.isFinite(initialSleepTime) || initialSleepTime < 1) {
		throw new LokaliseError(
			"initialSleepTime must be a finite value of at least 1 ms.",
		);
	}

	if (
		!Number.isFinite(maxSleepTime) ||
		maxSleepTime < initialSleepTime ||
		maxSleepTime > MAX_TIMEOUT_MS
	) {
		throw new LokaliseError(
			`maxSleepTime must be between initialSleepTime and ${MAX_TIMEOUT_MS} ms.`,
		);
	}

	if (!Number.isFinite(jitterRatio) || jitterRatio < 0 || jitterRatio > 1) {
		throw new LokaliseError(
			"jitterRatio must be a finite value between 0 and 1.",
		);
	}

	if (typeof rng !== "function") {
		throw new LokaliseError("rng must be a function.");
	}
}

/**
 * Calculates a capped exponential-backoff delay with symmetric jitter.
 *
 * retryNumber is 1-based: the first retry uses the initial delay.
 * Assumes retry parameters have already been validated.
 */
export function calculateSleepMs(
	params: RetryParams,
	retryNumber: number,
): number {
	if (!Number.isSafeInteger(retryNumber) || retryNumber < 1) {
		throw new LokaliseError("retryNumber must be a positive integer.");
	}

	const { initialSleepTime, maxSleepTime, jitterRatio, rng } = params;

	const base = Math.min(
		maxSleepTime,
		initialSleepTime * 2 ** (retryNumber - 1),
	);

	if (jitterRatio === 0) {
		return Math.max(1, Math.round(base));
	}

	const random = rng();

	if (!Number.isFinite(random) || random < 0 || random >= 1) {
		throw new LokaliseError(
			"rng must return a finite number between 0 (inclusive) and 1 (exclusive).",
		);
	}

	const factor = 1 + (random * 2 - 1) * jitterRatio;

	return Math.max(1, Math.min(maxSleepTime, Math.round(base * factor)));
}

/**
 * Converts a Lokalise SDK error into a library error.
 */
function wrapApiError(
	error: LokaliseApiError,
	exhausted = false,
): LokaliseError {
	const message = exhausted
		? `Maximum retries reached: ${error.message}`
		: error.message;

	const wrapped = new LokaliseError(message, error.code, error.details);

	wrapped.cause = error;

	return wrapped;
}

/**
 * Executes an asynchronous operation with bounded exponential backoff.
 *
 * Only configured Lokalise API errors are retried.
 * Non-Lokalise errors are propagated unchanged.
 */
export async function withExponentialBackoff<T>(
	operation: () => Promise<T>,
	params: RetryParams,
	{ signal, onDebug }: RetryOptions = {},
): Promise<T> {
	validateRetryParams(params);

	onDebug?.(
		`Running operation with exponential backoff; max retries: ${params.maxRetries}`,
	);

	for (let attempt = 1; ; attempt++) {
		signal?.throwIfAborted();

		onDebug?.(`Attempt #${attempt}...`);

		try {
			return await operation();
		} catch (error: unknown) {
			signal?.throwIfAborted();

			if (!(error instanceof LokaliseApiError)) {
				throw error;
			}

			if (!RETRYABLE_CODES.has(error.code)) {
				throw wrapApiError(error);
			}

			if (attempt > params.maxRetries) {
				throw wrapApiError(error, true);
			}

			const sleepMs = calculateSleepMs(params, attempt);

			onDebug?.(
				`Retryable error (${error.code}). Waiting ${sleepMs}ms before retry...`,
			);

			await sleep(sleepMs, undefined, signal ? { signal } : {});
		}
	}
}

/**
 * Resolves retry configuration using default values
 * for any missing parameters.
 *
 * @param params - Optional retry parameter overrides.
 * @returns Fully resolved retry configuration.
 */
export function resolveRetryParams(
	params?: Partial<RetryParams>,
): Required<RetryParams> {
	return {
		maxRetries: params?.maxRetries ?? DEFAULT_RETRY_PARAMS.maxRetries,
		initialSleepTime:
			params?.initialSleepTime ?? DEFAULT_RETRY_PARAMS.initialSleepTime,
		maxSleepTime: params?.maxSleepTime ?? DEFAULT_RETRY_PARAMS.maxSleepTime,
		jitterRatio: params?.jitterRatio ?? DEFAULT_RETRY_PARAMS.jitterRatio,
		rng: params?.rng ?? DEFAULT_RETRY_PARAMS.rng,
	};
}
