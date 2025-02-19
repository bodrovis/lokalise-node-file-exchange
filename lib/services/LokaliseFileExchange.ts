import { LokaliseApi, LokaliseApiOAuth } from "@lokalise/node-api";
import type { ClientParams } from "@lokalise/node-api";
import { ApiError as LokaliseApiError } from "@lokalise/node-api";
import type { QueuedProcess } from "@lokalise/node-api";
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

	// Constants for process statuses
	private readonly PENDING_STATUSES = [
		"queued",
		"pre_processing",
		"running",
		"post_processing",
	];
	private readonly FINISHED_STATUSES = ["finished", "cancelled", "failed"];

	/**
	 * Creates a new instance of LokaliseFileExchange.
	 *
	 * @param clientConfig - Configuration for the Lokalise SDK.
	 * @param exchangeConfig - The configuration object for file exchange operations.
	 * @throws {LokaliseError} If the provided configuration is invalid.
	 */
	constructor(
		clientConfig: ClientParams,
		exchangeConfig: LokaliseExchangeConfig,
	) {
		if (!clientConfig.apiKey || typeof clientConfig.apiKey !== "string") {
			throw new LokaliseError("Invalid or missing API token.", 401);
		}

		if (
			!exchangeConfig.projectId ||
			typeof exchangeConfig.projectId !== "string"
		) {
			throw new LokaliseError("Invalid or missing Project ID.", 400);
		}

		const { useOAuth2 = false } = exchangeConfig;

		if (useOAuth2) {
			this.apiClient = new LokaliseApiOAuth(clientConfig);
		} else {
			this.apiClient = new LokaliseApi(clientConfig);
		}

		this.projectId = exchangeConfig.projectId;
		this.retryParams = {
			...LokaliseFileExchange.defaultRetryParams,
			...exchangeConfig.retryParams,
		};

		if (this.retryParams.maxRetries < 0) {
			throw new LokaliseError(
				"maxRetries must be greater than or equal to zero.",
				400,
			);
		}
		if (this.retryParams.initialSleepTime <= 0) {
			throw new LokaliseError(
				"initialSleepTime must be a positive value.",
				400,
			);
		}
	}

	/**
	 * Executes an asynchronous operation with exponential backoff retry logic.
	 *
	 * Retries the provided operation in the event of specific retryable errors (e.g., 429 Too Many Requests,
	 * 408 Request Timeout) using an exponential backoff strategy with optional jitter. If the maximum number
	 * of retries is exceeded, it throws an error. Non-retryable errors are immediately propagated.
	 *
	 * @template T The type of the value returned by the operation.
	 * @param operation - The asynchronous operation to execute.
	 * @returns A promise that resolves to the result of the operation if successful.
	 * @throws {LokaliseError} If the maximum number of retries is reached or a non-retryable error occurs.
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
							`Maximum retries reached: ${error.message ?? "Unknown error"}`,
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

		// This line is unreachable but keeps TS happy.
		throw new LokaliseError("Unexpected error during operation.", 500);
	}

	/**
	 * Polls the status of queued processes until they are marked as "finished" or until the maximum wait time is exceeded.
	 *
	 * @param {QueuedProcess[]} processes - The array of processes to poll.
	 * @param {number} initialWaitTime - The initial wait time before polling in milliseconds.
	 * @param {number} maxWaitTime - The maximum time to wait for processes in milliseconds.
	 * @returns {Promise<QueuedProcess[]>} A promise resolving to the updated array of processes with their final statuses.
	 */
	protected async pollProcesses(
		processes: QueuedProcess[],
		initialWaitTime: number,
		maxWaitTime: number,
	): Promise<QueuedProcess[]> {
		const startTime = Date.now();
		let waitTime = initialWaitTime;

		const processMap = new Map<string, QueuedProcess>();

		// Initialize processMap and set a default status if missing
		const pendingProcessIds = new Set<string>();

		for (const process of processes) {
			if (!process.status) {
				process.status = "queued"; // Assign default status if missing
			}

			processMap.set(process.process_id, process);

			if (this.PENDING_STATUSES.includes(process.status)) {
				pendingProcessIds.add(process.process_id);
			}
		}

		while (pendingProcessIds.size > 0 && Date.now() - startTime < maxWaitTime) {
			await Promise.all(
				[...pendingProcessIds].map(async (processId) => {
					try {
						const updatedProcess = await this.apiClient
							.queuedProcesses()
							.get(processId, { project_id: this.projectId });

						if (!updatedProcess.status) {
							updatedProcess.status = "queued"; // Ensure missing status is defaulted
						}

						processMap.set(processId, updatedProcess);

						if (this.FINISHED_STATUSES.includes(updatedProcess.status)) {
							pendingProcessIds.delete(processId);
						}
					} catch (_error) {
						// console.warn(`Failed to fetch process ${processId}:`, error);
					}
				}),
			);

			if (
				pendingProcessIds.size === 0 ||
				Date.now() - startTime >= maxWaitTime
			) {
				break;
			}

			await this.sleep(waitTime);
			waitTime = Math.min(waitTime * 2, maxWaitTime - (Date.now() - startTime));
		}

		return Array.from(processMap.values());
	}

	/**
	 * Pauses execution for the specified number of milliseconds.
	 *
	 * @param ms - The time to sleep in milliseconds.
	 * @returns A promise that resolves after the specified time.
	 */
	protected sleep(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}
}
