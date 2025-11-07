export interface RetryParams {
	maxRetries: number;
	initialSleepTime: number;
	jitterRatio: number;
	rng: () => number;
}
