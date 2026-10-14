import type { RetryParams } from "./interfaces/index.js";

export const DEFAULT_RETRY_PARAMS: Readonly<RetryParams> = {
	maxRetries: 3,
	initialSleepTime: 1000,
	maxSleepTime: 30_000,
	jitterRatio: 0.2,
	rng: Math.random,
};

export const FINISHED_STATUSES: ReadonlySet<string> = new Set([
	"finished",
	"cancelled",
	"failed",
]);

export const RETRYABLE_CODES: ReadonlySet<number> = new Set([408, 429]);

export const MAX_CONCURRENT_PROCESSES = 6;
