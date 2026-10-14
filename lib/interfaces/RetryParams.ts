export interface RetryParams {
	maxRetries: number;
	initialSleepTime: number;
	maxSleepTime: number;
	jitterRatio: number;
	rng: () => number;
}
