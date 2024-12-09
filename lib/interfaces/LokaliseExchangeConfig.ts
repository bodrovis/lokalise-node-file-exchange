import type { RetryParams } from "../interfaces/index.js";

export interface LokaliseExchangeConfig {
	projectId: string;
	retryParams?: Partial<RetryParams>;
}
