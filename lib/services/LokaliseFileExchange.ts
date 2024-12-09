import { LokaliseApi } from "@lokalise/node-api";
import type { ClientParams } from "@lokalise/node-api";
import { ApiError as LokaliseApiError } from "@lokalise/node-api";
import { LokaliseError } from "../errors/LokaliseError.js";
import type { LokaliseExchangeConfig } from "../interfaces/LokaliseExchangeConfig.js";
import type { RetryParams } from "../interfaces/index.js";

/**
 * A utility class for exchanging files with the Lokalise API.
 */
export class LokaliseFileExchange {
	/**
	 * The Lokalise API client instance.
	 */
	public readonly apiClient: LokaliseApi;

	/**
	 * The ID of the project in Lokalise.
	 */
	protected readonly projectId: string;

	/**
	 * Retry parameters for API requests.
	 */
	protected readonly retryParams: RetryParams;

	/**
	 * Default retry parameters for API requests.
	 */
	private static readonly defaultRetryParams: RetryParams = {
		maxRetries: 3,
		initialSleepTime: 1000,
	};

	/**
	 * Creates a new instance of LokaliseFileExchange.
	 *
	 * @param {ClientParams} clientConfig - Configuration for Lokalise SDK.
	 * @param {LokaliseExchangeConfig} exchangeConfig - The configuration object.
	 * @throws {Error} If the provided configuration is invalid.
	 */
	constructor(
		clientConfig: ClientParams,
		exchangeConfig: LokaliseExchangeConfig,
	) {
		// Validate the API key
		if (!clientConfig.apiKey || typeof clientConfig.apiKey !== "string") {
			throw new Error("Invalid or missing API token.");
		}

		// Validate the project ID
		if (
			!exchangeConfig.projectId ||
			typeof exchangeConfig.projectId !== "string"
		) {
			throw new Error("Invalid or missing Project ID.");
		}

		// Validate and sanitize retryParams
		const mergedRetryParams = {
			...LokaliseFileExchange.defaultRetryParams,
			...exchangeConfig.retryParams,
		};
		if (mergedRetryParams.maxRetries < 0) {
			throw new Error("maxRetries must be greater than or equal to zero.");
		}

		this.apiClient = new LokaliseApi(clientConfig);
		this.projectId = exchangeConfig.projectId;
		this.retryParams = mergedRetryParams;
	}

	/**
	 * Executes an asynchronous operation with exponential backoff retry logic.
	 *
	 * This method retries the provided operation in the event of specific retryable errors (e.g., 429 Too Many Requests,
	 * 408 Request Timeout) using an exponential backoff strategy. If the maximum number of retries is exceeded,
	 * it throws an error. Non-retryable errors are immediately propagated.
	 *
	 * @template T The type of the value returned by the operation.
	 * @param {() => Promise<T>} operation - The asynchronous operation to be executed.
	 * @returns {Promise<T>} A promise that resolves to the result of the operation if successful.
	 * @throws {LokaliseError} Throws a LokaliseError if the maximum number of retries is reached or for non-retryable errors.
	 */
	protected async withExponentialBackoff<T>(
		operation: () => Promise<T>,
	): Promise<T> {
		const { maxRetries, initialSleepTime } = this.retryParams;

		for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
			try {
				return await operation();
			} catch (error: unknown) {
				if (
					error instanceof LokaliseApiError &&
					(error.code === 429 || error.code === 408)
				) {
					if (attempt === maxRetries + 1) {
						throw new LokaliseError(
							`Maximum retries reached: ${error instanceof Error ? error.message : "Unknown error"}`,
							error.code,
							error.details,
						);
					}
					await this.sleep(initialSleepTime * 2 ** (attempt - 1));
				} else if (error instanceof LokaliseApiError) {
					throw new LokaliseError(error.message, error.code, error.details);
				} else {
					throw error;
				}
			}
		}

		throw new LokaliseError("Unexpected error", 500);
	}

	/**
	 * Pauses execution for the specified number of milliseconds.
	 *
	 * @param ms - The time to sleep in milliseconds.
	 * @returns A promise that resolves after the specified time.
	 * @internal This is a utility method used for retrying failed requests.
	 */
	protected sleep(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}
}
