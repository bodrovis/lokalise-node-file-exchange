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
	private static readonly defaultRetryParams: Required<RetryParams> = {
		maxRetries: 3,
		initialSleepTime: 1000,
		jitterRatio: 0.2,
		rng: Math.random,
	};

	private static readonly FINISHED_STATUSES = [
		"finished",
		"cancelled",
		"failed",
	] as const;

	private static readonly RETRYABLE_CODES = [408, 429];

	protected static readonly maxConcurrentProcesses = 6;

	private static isPendingStatus(status?: string | null): boolean {
		return !LokaliseFileExchange.isFinishedStatus(status);
	}

	public static isFinishedStatus(status?: string | null): boolean {
		return (
			status != null &&
			(LokaliseFileExchange.FINISHED_STATUSES as readonly string[]).includes(
				status,
			)
		);
	}

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
		this.projectId = projectId;
		this.logThreshold = logThreshold;
		this.logger = this.chooseLogger(logColor);
		this.retryParams = this.buildRetryParams(retryParams);

		this.validateParams();

		const apiConfig = this.buildLokaliseClientConfig(
			clientConfig,
			logThreshold,
		);
		this.apiClient = this.createApiClient(apiConfig, useOAuth2);
	}

	/**
	 * Executes an asynchronous operation with exponential-backoff retry logic.
	 *
	 * The operation is attempted multiple times if it throws a retryable
	 * `LokaliseApiError`. Each retry waits longer than the previous one based on
	 * exponential backoff parameters (`base`, `factor`, optional jitter).
	 *
	 * Behaviour:
	 * - If the operation succeeds — its result is returned immediately.
	 * - If it fails with a retryable error — the function waits and retries.
	 * - If the maximum number of retries is reached — throws a `LokaliseError`
	 *   with the original error details.
	 * - If the error is non-retryable — it is immediately wrapped into
	 *   `LokaliseError` and rethrown.
	 * - Any non-Lokalise errors are rethrown as-is.
	 *
	 * @param operation - A function that performs the async action to be retried.
	 * @returns The successful result of the operation.
	 * @throws LokaliseError After all retries fail or on non-retryable errors.
	 */
	protected async withExponentialBackoff<T>(
		operation: () => Promise<T>,
	): Promise<T> {
		const { maxRetries } = this.retryParams;
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
							`Maximum retries reached: ${error.message}`,
							error.code,
							error.details,
						);
					}

					const sleepMs = this.calculateSleepMs(this.retryParams, attempt);

					this.logMsg("debug", `Waiting ${sleepMs}ms before retry...`);
					await LokaliseFileExchange.sleep(sleepMs);
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
	 * Polls the status of queued processes until they are marked as "finished"
	 * or until the maximum wait time is exceeded.
	 *
	 * Uses batched polling with limited concurrency and exponential backoff-like
	 * wait times between iterations. Performs an initial status snapshot, then
	 * repeatedly refreshes pending processes until either:
	 * - all of them reach a finished state, or
	 * - the time budget (`maxWaitTime`) is exhausted.
	 *
	 * A final refresh is performed for any still-pending processes before returning.
	 *
	 * @param processes - List of queued processes to poll.
	 * @param initialWaitTime - Initial delay (in ms) between polling iterations.
	 * @param maxWaitTime - Maximum total time (in ms) allowed for polling.
	 * @param concurrency - Maximum number of processes to refresh per batch.
	 * @returns A list of processes with their latest known statuses.
	 */
	protected async pollProcesses(
		processes: QueuedProcess[],
		initialWaitTime: number,
		maxWaitTime: number,
		concurrency = LokaliseFileExchange.maxConcurrentProcesses,
	): Promise<QueuedProcess[]> {
		this.logMsg(
			"debug",
			`Start polling processes. Total processes count: ${processes.length}`,
		);

		const startTime = Date.now();

		const { processMap, pendingProcessIds } =
			this.initializePollingState(processes);

		await this.runPollingLoop(
			processMap,
			pendingProcessIds,
			startTime,
			initialWaitTime,
			maxWaitTime,
			concurrency,
		);

		if (pendingProcessIds.size > 0) {
			await this.refreshRemainingProcesses(
				processMap,
				pendingProcessIds,
				concurrency,
			);
		}

		return Array.from(processMap.values());
	}

	/**
	 * Builds internal tracking structures for polling: a map of process IDs
	 * to their last known state and a set of IDs that are still pending.
	 *
	 * Also logs the initial status of each process.
	 *
	 * @param processes - Initial list of queued processes.
	 * @returns A map of processes keyed by ID and a set of pending process IDs.
	 */
	private initializePollingState(processes: QueuedProcess[]): {
		processMap: Map<string, QueuedProcess>;
		pendingProcessIds: Set<string>;
	} {
		this.logMsg("debug", "Initial processes check...");

		const processMap = new Map<string, QueuedProcess>();
		const pendingProcessIds = new Set<string>();

		for (const p of processes) {
			if (p.status) {
				this.logMsg(
					"debug",
					`Process ID: ${p.process_id}, status: ${p.status}`,
				);
			} else {
				this.logMsg("debug", `Process ID: ${p.process_id}, status is missing`);
			}

			processMap.set(p.process_id, p);

			if (LokaliseFileExchange.isPendingStatus(p.status)) {
				pendingProcessIds.add(p.process_id);
			}
		}

		return { processMap, pendingProcessIds };
	}

	/**
	 * Runs the main polling loop for the given processes.
	 *
	 * Repeatedly fetches updated process statuses in batches while:
	 * - there are still pending IDs, and
	 * - the elapsed time is below the configured maximum.
	 *
	 * Includes a small "fast-follow" recheck when some processes have missing
	 * status on the first iterations, and uses a growing wait time between
	 * iterations (capped by the remaining time budget).
	 *
	 * @param processMap - Map of process IDs to their last known state.
	 * @param pendingProcessIds - Set of IDs that are not finished yet.
	 * @param startTime - Timestamp (ms) when polling started.
	 * @param initialWaitTime - Initial delay (ms) between polling iterations.
	 * @param maxWaitTime - Maximum total polling duration (ms).
	 * @param concurrency - Maximum number of processes to refresh per batch.
	 */
	private async runPollingLoop(
		processMap: Map<string, QueuedProcess>,
		pendingProcessIds: Set<string>,
		startTime: number,
		initialWaitTime: number,
		maxWaitTime: number,
		concurrency: number,
	): Promise<void> {
		let waitTime = initialWaitTime;
		let didFastFollow = false;

		while (pendingProcessIds.size > 0 && Date.now() - startTime < maxWaitTime) {
			this.logMsg("debug", `Polling... Pending IDs: ${pendingProcessIds.size}`);

			if (
				!didFastFollow &&
				[...processMap.values()].some((p) => p.status == null)
			) {
				this.logMsg(
					"debug",
					"Fast-follow: some statuses missing, quick recheck in 200ms",
				);
				await LokaliseFileExchange.sleep(200);
				didFastFollow = true;
			}

			const ids = [...pendingProcessIds];
			const batch = await this.fetchProcessesBatch(ids, concurrency);

			for (const { id, process } of batch) {
				if (!process) continue;
				processMap.set(id, process);

				if (LokaliseFileExchange.isFinishedStatus(process.status)) {
					this.logMsg(
						"debug",
						`Process ${id} completed with status=${process.status}.`,
					);
					pendingProcessIds.delete(id);
				}
			}

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
	}

	/**
	 * Performs a final status refresh for any processes that are still marked
	 * as pending after the main polling loop.
	 *
	 * This gives one last chance to capture terminal statuses right before
	 * returning the result to the caller.
	 *
	 * @param processMap - Map of process IDs to their last known state.
	 * @param pendingProcessIds - Set of IDs that are still considered pending.
	 * @param concurrency - Maximum number of processes to refresh per batch.
	 */
	private async refreshRemainingProcesses(
		processMap: Map<string, QueuedProcess>,
		pendingProcessIds: Set<string>,
		concurrency: number,
	): Promise<void> {
		this.logMsg(
			"debug",
			`Final refresh for ${pendingProcessIds.size} pending processes before return...`,
		);

		const finalBatch = await this.fetchProcessesBatch(
			[...pendingProcessIds],
			concurrency,
		);

		for (const { id, process } of finalBatch) {
			if (process) {
				processMap.set(id, process);
			}
		}
	}

	/**
	 * Determines whether the given Lokalise API error should trigger a retry attempt.
	 *
	 * An error is considered retryable if its `code` matches one of the predefined
	 * retryable status codes.
	 *
	 * @param error - The `LokaliseApiError` instance to evaluate.
	 * @returns `true` if the error is retryable, otherwise `false`.
	 */
	private isRetryable(error: LokaliseApiError): boolean {
		return LokaliseFileExchange.RETRYABLE_CODES.includes(error.code);
	}

	/**
	 * Logs a message using the configured logger, respecting the current log threshold.
	 *
	 * Wraps the raw logger call by attaching metadata such as:
	 * - `level` — severity of the log entry,
	 * - `threshold` — active log level threshold used to filter messages,
	 * - `withTimestamp` — instructs the logger to prepend a timestamp.
	 *
	 * All variadic `args` are forwarded directly to the logger.
	 *
	 * @param level - Log level of the message being emitted.
	 * @param args - Additional values to pass to the logger.
	 */
	protected logMsg(level: LogLevel, ...args: unknown[]): void {
		this.logger(
			{ level, threshold: this.logThreshold, withTimestamp: true },
			...args,
		);
	}

	/**
	 * Fetches the most recent state of a queued process from the Lokalise API.
	 *
	 * Sends a GET request for the process identified by `processId` and logs
	 * both the request and the received status. Used during polling to refresh
	 * the status of long-running async operations.
	 *
	 * @param processId - The unique identifier of the queued process to retrieve.
	 * @returns A promise resolving to the updated `QueuedProcess` object.
	 */
	protected async getUpdatedProcess(processId: string): Promise<QueuedProcess> {
		this.logMsg("debug", `Requesting update for process ID: ${processId}`);

		const updatedProcess = await this.apiClient
			.queuedProcesses()
			.get(processId, { project_id: this.projectId });

		if (updatedProcess.status) {
			this.logMsg(
				"debug",
				`Process ID: ${updatedProcess.process_id}, status: ${updatedProcess.status}`,
			);
		} else {
			this.logMsg(
				"debug",
				`Process ID: ${updatedProcess.process_id}, status is missing`,
			);
		}

		return updatedProcess;
	}

	/**
	 * Validates essential client configuration parameters before any operations run.
	 *
	 * Ensures that:
	 * - `projectId` is present and is a non-empty string,
	 * - retry settings (`maxRetries`, `initialSleepTime`, `jitterRatio`)
	 *   fall within acceptable ranges.
	 *
	 * Throws a `LokaliseError` if any configuration parameter is missing,
	 * malformed, or outside allowed bounds.
	 */
	private validateParams(): void {
		if (!this.projectId || typeof this.projectId !== "string") {
			throw new LokaliseError("Invalid or missing Project ID.");
		}

		const { maxRetries, initialSleepTime, jitterRatio } = this.retryParams;

		if (maxRetries < 0) {
			throw new LokaliseError(
				"maxRetries must be greater than or equal to zero.",
			);
		}
		if (initialSleepTime <= 0) {
			throw new LokaliseError("initialSleepTime must be a positive value.");
		}
		if (jitterRatio < 0 || jitterRatio > 1)
			throw new LokaliseError("jitterRatio must be between 0 and 1.");
	}

	/**
	 * Executes asynchronous work over a list of items with a fixed concurrency limit.
	 *
	 * Spawns up to `limit` parallel worker loops. Each loop pulls the next
	 * unprocessed item index in a thread-safe manner (via shared counter `i`),
	 * runs the provided async `worker` function for that item, and stores the
	 * resulting value in the corresponding position of the `results` array.
	 *
	 * Processing stops when all items have been consumed. If any worker throws,
	 * the error propagates and the whole operation rejects.
	 *
	 * @param items - The list of items to process.
	 * @param limit - Maximum number of concurrent async operations.
	 * @param worker - Async handler executed for each item.
	 * @returns A promise resolving to an array of results, preserving input order.
	 */
	protected async runWithConcurrencyLimit<T, R>(
		items: T[],
		limit: number,
		worker: (item: T, index: number) => Promise<R>,
	): Promise<R[]> {
		const results = new Array<R>(items.length);
		let i = 0;

		const workers = new Array(Math.min(limit, items.length))
			.fill(null)
			.map(async () => {
				while (true) {
					const idx = i++;
					if (idx >= items.length) break;
					const item = items[idx];
					if (item === undefined) {
						throw new Error(`Missing item at index ${idx}`);
					}

					results[idx] = await worker(item, idx);
				}
			});

		await Promise.all(workers);
		return results;
	}

	/**
	 * Fetches updated process states for a list of process IDs in parallel,
	 * respecting a maximum concurrency limit.
	 *
	 * Each process ID is resolved via `getUpdatedProcess()`. If the fetch
	 * succeeds, the returned object includes both `id` and the updated
	 * `process`. If an error occurs, a warning is logged and the result
	 * contains only the `id`, allowing polling to continue without failing
	 * the entire batch.
	 *
	 * Internally uses `runWithConcurrencyLimit` to enforce controlled parallelism.
	 *
	 * @param processIds - The list of queued process IDs to refresh.
	 * @param concurrency - Maximum number of simultaneous requests.
	 * @returns A list of objects mapping each ID to its latest fetched state
	 *          (or `undefined` if the fetch failed).
	 */
	protected async fetchProcessesBatch(
		processIds: string[],
		concurrency = LokaliseFileExchange.maxConcurrentProcesses,
	): Promise<Array<{ id: string; process?: QueuedProcess }>> {
		return this.runWithConcurrencyLimit(processIds, concurrency, async (id) => {
			try {
				const updated = await this.getUpdatedProcess(id);
				return { id, process: updated };
			} catch (error) {
				this.logMsg("warn", `Failed to fetch process ${id}:`, error);
				return { id };
			}
		});
	}

	/**
	 * Delays execution for a given duration.
	 *
	 * Creates a Promise that resolves after the specified number of milliseconds,
	 * allowing async workflows to pause without blocking the event loop.
	 *
	 * @param ms - Number of milliseconds to wait.
	 * @returns A promise that resolves after the delay.
	 */
	protected static sleep(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}

	/**
	 * Computes the exponential-backoff delay for a retry attempt,
	 * optionally adding jitter to avoid synchronized retries.
	 *
	 * @param retryParams - Backoff settings (initial delay, jitter, RNG).
	 * @param attempt - Retry attempt number (1-based).
	 * @returns Calculated sleep time in milliseconds.
	 */
	protected calculateSleepMs(
		retryParams: RetryParams,
		attempt: number,
	): number {
		const { initialSleepTime, jitterRatio, rng } = retryParams;

		const base = initialSleepTime * 2 ** (attempt - 1);
		const maxJitter = Math.floor(base * jitterRatio);
		const jitter = maxJitter > 0 ? Math.floor(rng() * maxJitter) : 0;
		return base + jitter;
	}

	/**
	 * Builds the final Lokalise client configuration,
	 * enabling silent mode when the log threshold is `"silent"`.
	 *
	 * @param clientConfig - Base client parameters.
	 * @param logThreshold - Active logging threshold.
	 * @returns The adjusted client configuration.
	 */
	private buildLokaliseClientConfig(
		clientConfig: ClientParams,
		logThreshold: LogThreshold,
	): ClientParams {
		if (logThreshold === "silent") {
			return {
				...clientConfig,
				silent: true,
			};
		}

		return { ...clientConfig };
	}

	/**
	 * Creates the appropriate Lokalise API client instance,
	 * choosing between OAuth2 and token-based authentication.
	 *
	 * @param lokaliseApiConfig - Configuration passed to the client.
	 * @param useOAuth2 - Whether OAuth2 authentication should be used.
	 * @returns A Lokalise API client instance.
	 */
	private createApiClient(
		lokaliseApiConfig: ClientParams,
		useOAuth2: boolean,
	): LokaliseApi | LokaliseApiOAuth {
		if (useOAuth2) {
			this.logMsg("debug", "Using OAuth 2 Lokalise API client");
			return new LokaliseApiOAuth(lokaliseApiConfig);
		}

		this.logMsg("debug", "Using regular (token-based) Lokalise API client");
		return new LokaliseApi(lokaliseApiConfig);
	}

	/**
	 * Merges user-provided retry settings with default retry parameters.
	 *
	 * @param retryParams - Optional overrides.
	 * @returns Fully resolved retry configuration.
	 */
	private buildRetryParams(retryParams?: Partial<RetryParams>): RetryParams {
		return {
			...LokaliseFileExchange.defaultRetryParams,
			...retryParams,
		};
	}

	/**
	 * Selects the logger implementation based on whether color output is enabled.
	 *
	 * @param logColor - If true, uses the colorized logger.
	 * @returns The chosen log function.
	 */
	private chooseLogger(logColor: boolean): LogFunction {
		return logColor ? logWithColor : logWithLevel;
	}
}
