import type { ClientParams, QueuedProcess } from "@lokalise/node-api";
import {
	LokaliseApi,
	ApiError as LokaliseApiError,
	LokaliseApiOAuth,
} from "@lokalise/node-api";
import {
	type LogFunction,
	type LogLevel,
	type LogThreshold,
	logWithColor,
	logWithLevel,
} from "kliedz";
import { LokaliseError } from "../errors/LokaliseError.js";
import type {
	LokaliseExchangeConfig,
	RetryParams,
} from "../interfaces/index.js";

/**
 * A utility class for exchanging files with the Lokalise API.
 */
export class LokaliseFileExchange {
	/**
	 * The Lokalise API client instance.
	 */
	protected readonly apiClient: LokaliseApi;

	/**
	 * The ID of the project in Lokalise.
	 */
	protected readonly projectId: string;

	/**
	 * Retry parameters for API requests.
	 */
	protected readonly retryParams: RetryParams;

	/**
	 * Logger function.
	 */
	protected readonly logger: LogFunction;

	/**
	 * Log threshold (do not print messages with severity less than the specified value).
	 */
	protected readonly logThreshold: LogThreshold;

	/**
	 * Default retry parameters for API requests.
	 */
	private static readonly defaultRetryParams: RetryParams = {
		maxRetries: 3,
		initialSleepTime: 1000,
	};

	private static readonly PENDING_STATUSES = [
		"queued",
		"pre_processing",
		"running",
		"post_processing",
	];
	private static readonly FINISHED_STATUSES = [
		"finished",
		"cancelled",
		"failed",
	];

	private static readonly RETRYABLE_CODES = [408, 429];

	/**
	 * Creates a new instance of LokaliseFileExchange.
	 *
	 * @param clientConfig - Configuration for the Lokalise SDK.
	 * @param exchangeConfig - The configuration object for file exchange operations.
	 * @throws {LokaliseError} If the provided configuration is invalid.
	 */
	constructor(
		clientConfig: ClientParams,
		{
			projectId,
			useOAuth2 = false,
			retryParams,
			logThreshold = "info",
			logColor = true,
		}: LokaliseExchangeConfig,
	) {
		if (logColor) {
			this.logger = logWithColor;
		} else {
			this.logger = logWithLevel;
		}

		this.logThreshold = logThreshold;

		let lokaliseApiConfig = clientConfig;

		if (logThreshold === "silent") {
			lokaliseApiConfig = {
				silent: true,
				...lokaliseApiConfig,
			};
		}

		if (useOAuth2) {
			this.logMsg("debug", "Using OAuth 2 Lokalise API client");
			this.apiClient = new LokaliseApiOAuth(lokaliseApiConfig);
		} else {
			this.logMsg("debug", "Using regular (token-based) Lokalise API client");
			this.apiClient = new LokaliseApi(lokaliseApiConfig);
		}

		this.projectId = projectId;

		this.retryParams = {
			...LokaliseFileExchange.defaultRetryParams,
			...retryParams,
		};

		this.validateParams();
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
		this.logMsg(
			"debug",
			`Running operation with exponential backoff; max retries: ${maxRetries}`,
		);

		for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
			try {
				this.logMsg("debug", `Attempt #${attempt}...`);

				return await operation();
			} catch (error: unknown) {
				if (error instanceof LokaliseApiError && this.isRetryable(error)) {
					this.logMsg("debug", `Retryable error caught: ${error.message}`);

					if (attempt === maxRetries + 1) {
						throw new LokaliseError(
							`Maximum retries reached: ${error.message ?? "Unknown error"}`,
							error.code,
							error.details,
						);
					}

					const backoff = initialSleepTime * 2 ** (attempt - 1);
					this.logMsg("debug", `Waiting ${backoff}ms before retry...`);
					await LokaliseFileExchange.sleep(backoff);
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
		this.logMsg(
			"debug",
			`Start polling processes. Total processes count: ${processes.length}`,
		);

		const startTime = Date.now();
		let waitTime = initialWaitTime;

		const processMap = new Map<string, QueuedProcess>();

		// Initialize processMap and set a default status if missing
		const pendingProcessIds = new Set<string>();

		this.logMsg("debug", "Initial processes check...");

		for (const process of processes) {
			if (process.status) {
				this.logMsg("debug", `Process ID: ${process.process_id}, status: ${process.status}`);
			} else {
				this.logMsg("debug", `Process ID: ${process.process_id}, status is missing, setting to "queued"`);
				process.status = "queued"; // Assign default status if missing
			}

			processMap.set(process.process_id, process);

			if (LokaliseFileExchange.PENDING_STATUSES.includes(process.status)) {
				pendingProcessIds.add(process.process_id);
			}
		}

		while (pendingProcessIds.size > 0 && Date.now() - startTime < maxWaitTime) {
			this.logMsg("debug", `Polling... Pending IDs: ${pendingProcessIds.size}`);

			await Promise.all(
				[...pendingProcessIds].map(async (processId) => {
					try {
						const updated = await this.getUpdatedProcess(processId);
						processMap.set(processId, updated);

						if (
							LokaliseFileExchange.FINISHED_STATUSES.includes(updated.status)
						) {
							this.logMsg(
								"debug",
								`Process ${processId} completed with status=${updated.status}.`,
							);
							pendingProcessIds.delete(processId);
						}
					} catch (error) {
						this.logMsg("warn", `Failed to fetch process ${processId}:`, error);
					}
				}),
			);

			if (pendingProcessIds.size === 0) {
				this.logMsg("debug", "Finished polling. Pending processes IDs: 0");
				break;
			}

			const elapsed = Date.now() - startTime;
			const remaining = maxWaitTime - elapsed;

			if (remaining <= 0) {
				this.logMsg(
					"debug",
					"Time budget exhausted, stopping polling without extra sleep.",
				);
				break;
			}

			const sleepMs = Math.min(waitTime, remaining);
			this.logMsg("debug", `Waiting ${sleepMs}...`);
			await LokaliseFileExchange.sleep(sleepMs);

			waitTime = Math.min(
				waitTime * 2,
				Math.max(0, maxWaitTime - (Date.now() - startTime)),
			);
		}

		if (pendingProcessIds.size > 0) {
			this.logMsg(
				"debug",
				`Final refresh for ${pendingProcessIds.size} pending processes before return...`,
			);
			await Promise.all(
				[...pendingProcessIds].map(async (processId) => {
					try {
						const updated = await this.getUpdatedProcess(processId);
						processMap.set(processId, updated);
					} catch (error) {
						this.logMsg(
							"warn",
							`Final refresh failed for process ${processId}:`,
							error,
						);
					}
				}),
			);
		}

		return Array.from(processMap.values());
	}

	/**
	 * Determines if a given error is eligible for retry.
	 *
	 * @param error - The error object returned from the Lokalise API.
	 * @returns `true` if the error is retryable, otherwise `false`.
	 */
	private isRetryable(error: LokaliseApiError): boolean {
		return LokaliseFileExchange.RETRYABLE_CODES.includes(error.code);
	}

	/**
	 * Logs a message with a specified level and the current threshold.
	 *
	 * @param level - Severity level of the message (e.g. "info", "error").
	 * @param args - Values to log. Strings, objects, errors, etc.
	 */
	protected logMsg(level: LogLevel, ...args: unknown[]): void {
		this.logger(
			{ level, threshold: this.logThreshold, withTimestamp: true },
			...args,
		);
	}

	/**
	 * Retrieves the latest state of a queued process from the API.
	 *
	 * @param processId - The ID of the queued process to fetch.
	 * @returns A promise that resolves to the updated queued process.
	 */
	protected async getUpdatedProcess(processId: string): Promise<QueuedProcess> {
		this.logMsg("debug", `Requesting update for process ID: ${processId}`);

		const updatedProcess = await this.apiClient
			.queuedProcesses()
			.get(processId, { project_id: this.projectId });

		this.logMsg("debug", updatedProcess);

		if (updatedProcess.status) {
			this.logMsg("debug", `Process ID: ${updatedProcess.process_id}, status: ${updatedProcess.status}`);
		} else {
			this.logMsg("debug", `Process ID: ${updatedProcess.process_id}, status is missing, setting to "queued"`);
			updatedProcess.status = "queued";
		}

		return updatedProcess;
	}

	/**
	 * Validates the required client configuration parameters.
	 *
	 * Checks for a valid `projectId` and ensures that retry parameters
	 * such as `maxRetries` and `initialSleepTime` meet the required conditions.
	 *
	 * @throws {LokaliseError} If `projectId` or `retryParams` is invalid.
	 */
	private validateParams(): void {
		if (!this.projectId || typeof this.projectId !== "string") {
			throw new LokaliseError("Invalid or missing Project ID.");
		}

		if (this.retryParams.maxRetries < 0) {
			throw new LokaliseError(
				"maxRetries must be greater than or equal to zero.",
			);
		}
		if (this.retryParams.initialSleepTime <= 0) {
			throw new LokaliseError("initialSleepTime must be a positive value.");
		}
	}

	/**
	 * Pauses execution for the specified number of milliseconds.
	 *
	 * @param ms - The time to sleep in milliseconds.
	 * @returns A promise that resolves after the specified time.
	 */
	protected static sleep(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}
}
