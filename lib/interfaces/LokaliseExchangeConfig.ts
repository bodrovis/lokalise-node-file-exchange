import type { RetryParams } from "../interfaces/index.js";

export interface LokaliseExchangeConfig {
	projectId: string;
	useOAuth2?: boolean;
	retryParams?: Partial<RetryParams>;
}
