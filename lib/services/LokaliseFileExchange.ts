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
	 */
	protected async withExponentialBackoff<T>(
		operation: () => Promise<T>,
	): Promise<T> {
		const { maxRetries, initialSleepTime, jitterRatio, rng } = this.retryParams;
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

					const base = initialSleepTime * 2 ** (attempt - 1);
					const maxJitter = Math.floor(base * jitterRatio);
					const jitter = maxJitter > 0 ? Math.floor(rng() * maxJitter) : 0;
					const sleepMs = base + jitter;

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
	 * Polls the status of queued processes until they are marked as "finished" or until the maximum wait time is exceeded.
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
		let waitTime = initialWaitTime;

		const processMap = new Map<string, QueuedProcess>();
		const pendingProcessIds = new Set<string>();

		this.logMsg("debug", "Initial processes check...");

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

			// ОБНОВЛЯЕМ через ПУЛ
			const ids = [...pendingProcessIds];
			const batch = await this.fetchProcessesBatch(ids, concurrency);

			for (const { id, process } of batch) {
				if (!process) continue; // ошибка уже залогирована
				processMap.set(id, process);

				this.logMsg(
					"debug",
					`Process ID: ${id}, status: ${process.status ?? "missing"}`,
				);

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

		// Финальный добор через тот же пул, чтобы не стрелять веером
		if (pendingProcessIds.size > 0) {
			this.logMsg(
				"debug",
				`Final refresh for ${pendingProcessIds.size} pending processes before return...`,
			);

			const finalBatch = await this.fetchProcessesBatch(
				[...pendingProcessIds],
				concurrency,
			);

			for (const { id, process } of finalBatch) {
				if (process) processMap.set(id, process);
			}
		}

		return Array.from(processMap.values());
	}

	/**
	 * Determines if a given error is eligible for retry.
	 */
	private isRetryable(error: LokaliseApiError): boolean {
		return LokaliseFileExchange.RETRYABLE_CODES.includes(error.code);
	}

	/**
	 * Logs a message with a specified level and the current threshold.
	 */
	protected logMsg(level: LogLevel, ...args: unknown[]): void {
		this.logger(
			{ level, threshold: this.logThreshold, withTimestamp: true },
			...args,
		);
	}

	/**
	 * Retrieves the latest state of a queued process from the API.
	 */
	protected async getUpdatedProcess(processId: string): Promise<QueuedProcess> {
		this.logMsg("debug", `Requesting update for process ID: ${processId}`);

		const updatedProcess = await this.apiClient
			.queuedProcesses()
			.get(processId, { project_id: this.projectId });

		this.logMsg(
			"debug",
			`Process ID: ${updatedProcess.process_id}, status: ${updatedProcess.status ?? "missing"}`,
		);

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
	 * Validates the required client configuration parameters.
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
					results[idx] = await worker(items[idx], idx);
				}
			});

		await Promise.all(workers);
		return results;
	}

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
	 * Pauses execution for the specified number of milliseconds.
	 */
	protected static sleep(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}
}
