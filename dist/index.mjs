import { randomUUID } from "node:crypto";
import fs, { createWriteStream } from "node:fs";
import fs$1, { lstat, mkdir, realpath, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { setTimeout } from "node:timers/promises";
import { ApiError, LokaliseApi, LokaliseApiOAuth } from "@lokalise/node-api";
import { logWithColor, logWithLevel } from "kliedz";
import yauzl from "yauzl";

//#region lib/errors/LokaliseError.ts
/**
 * Represents an error occurring during Lokalise operations.
 */
var LokaliseError = class extends Error {
	code;
	details;
	/**
	 * Creates a LokaliseError instance.
	 *
	 * @param message - Error description.
	 * @param code - Optional error code.
	 * @param details - Optional additional error information.
	 */
	constructor(message, code, details) {
		super(message);
		this.name = "LokaliseError";
		if (code !== void 0) this.code = code;
		if (details !== void 0) this.details = details;
	}
	/**
	 * Returns the error message with optional code and details.
	 */
	toString() {
		let message = `${this.name}: ${this.message}`;
		if (this.code !== void 0) message += ` (Code: ${this.code})`;
		if (this.details && Object.keys(this.details).length > 0) {
			const details = Object.entries(this.details)
				.map(([key, value]) => `${key}: ${value}`)
				.join(", ");
			message += ` | Details: ${details}`;
		}
		return message;
	}
};

//#endregion
//#region lib/downloaders/bundle-downloader.ts
const MAX_TIMEOUT_MS$1 = 2147483647;
/**
 * Validates the bundle download timeout.
 * Zero disables the timeout.
 */
function validateDownloadTimeout(timeout) {
	if (
		!Number.isSafeInteger(timeout) ||
		timeout < 0 ||
		timeout > MAX_TIMEOUT_MS$1
	)
		throw new LokaliseError(
			`bundleDownloadTimeout must be an integer between 0 and ${MAX_TIMEOUT_MS$1}.`,
		);
}
/**
 * Downloads a ZIP bundle into a temporary file.
 *
 * Validates the URL and timeout, removes partial files on failure,
 * and converts download errors into LokaliseError.
 */
async function downloadBundleZip(url, timeout = 0, onWarning) {
	validateDownloadTimeout(timeout);
	const bundleURL = parseBundleUrl(url);
	const signal = timeout > 0 ? AbortSignal.timeout(timeout) : void 0;
	const tempZipPath = path.join(tmpdir(), `lokalise-${randomUUID()}.zip`);
	try {
		await fetchZipToDisk(bundleURL, tempZipPath, signal);
		return tempZipPath;
	} catch (error) {
		const normalizedError = normalizeDownloadError(error, signal, timeout);
		await cleanupTempZip(tempZipPath, onWarning);
		throw normalizedError;
	}
}
/**
 * Fetches a ZIP bundle and streams the response body to disk.
 *
 * @throws {LokaliseError} If the HTTP response is unsuccessful
 * or has no body.
 */
async function fetchZipToDisk(url, destination, signal) {
	const response = await fetch(url, signal ? { signal } : void 0);
	if (!response.ok) {
		try {
			await response.body?.cancel();
		} catch {}
		throw new LokaliseError(
			`Failed to download ZIP file: ${response.statusText} (${response.status})`,
			response.status,
		);
	}
	if (!response.body) throw new LokaliseError("ZIP response body is missing.");
	await writeZipToDisk(response.body, destination, signal);
}
/**
 * Removes a temporary ZIP file without masking download errors.
 */
async function cleanupTempZip(tempZipPath, onWarning) {
	try {
		await rm(tempZipPath, { force: true });
	} catch (error) {
		try {
			onWarning?.(`Failed to remove temporary ZIP: ${tempZipPath}`, error);
		} catch {}
	}
}
/**
 * Converts download failures into LokaliseError,
 * preserving the original error as its cause.
 */
function normalizeDownloadError(error, signal, timeout) {
	if (error instanceof LokaliseError) return error;
	if (signal?.aborted && signal.reason?.name === "TimeoutError") {
		const wrapped = new LokaliseError(
			`Bundle download timed out after ${timeout}ms`,
			408,
			{ reason: "timeout" },
		);
		wrapped.cause = error;
		return wrapped;
	}
	const message = error instanceof Error ? error.message : String(error);
	const wrapped = new LokaliseError(
		`Failed to download ZIP bundle: ${message}`,
		500,
		{ reason: "download error" },
	);
	wrapped.cause = error;
	return wrapped;
}
/**
 * Streams a ZIP response body into a temporary file.
 */
async function writeZipToDisk(body, destination, signal) {
	const readable = Readable.fromWeb(body);
	const writable = createWriteStream(destination, {
		flags: "wx",
		mode: 384,
	});
	await pipeline(readable, writable, signal ? { signal } : {});
}
/**
 * Validates the bundle URL protocol.
 */
function parseBundleUrl(value) {
	let url;
	try {
		url = new URL(value);
	} catch {
		throw new LokaliseError("Invalid bundle download URL.");
	}
	if (url.protocol !== "http:" && url.protocol !== "https:")
		throw new LokaliseError("Unsupported bundle URL protocol.");
	return url;
}

//#endregion
//#region lib/extractors/zip-extractor.ts
const MAX_ENTRIES = 1e4;
const MAX_ENTRY_BYTES = 104857600;
const MAX_TOTAL_BYTES = 1073741824;
/**
 * Extracts a ZIP archive into the specified directory.
 *
 * Validates entry paths, limits decompressed data,
 * and processes entries sequentially.
 */
async function unpackZip(zipFilePath, outputDir) {
	const zipfile = await yauzl.openPromise(zipFilePath, {
		autoClose: true,
		validateEntrySizes: true,
	});
	try {
		await mkdir(outputDir, { recursive: true });
		const root = await realpath(outputDir);
		const seenFiles = /* @__PURE__ */ new Set();
		let entryCount = 0;
		let totalBytes = 0;
		for await (const entry of zipfile.eachEntry()) {
			if (++entryCount > MAX_ENTRIES)
				throw new LokaliseError("ZIP contains too many entries.");
			if (
				!Number.isSafeInteger(entry.uncompressedSize) ||
				entry.uncompressedSize < 0 ||
				entry.uncompressedSize > MAX_ENTRY_BYTES
			)
				throw new LokaliseError(
					`Invalid or oversized ZIP entry: ${entry.fileName}`,
				);
			totalBytes += entry.uncompressedSize;
			if (totalBytes > MAX_TOTAL_BYTES)
				throw new LokaliseError("ZIP exceeds maximum extracted size.");
			await extractZipEntry(entry, zipfile, root, seenFiles);
		}
	} finally {
		zipfile.close();
	}
}
/**
 * Validates and extracts a ZIP entry.
 *
 * Handles directories, rejects duplicate files, and delegates
 * file extraction to a dedicated function.
 */
async function extractZipEntry(entry, zipfile, root, seenFiles) {
	const destination = resolveZipEntryPath(root, entry.fileName);
	const isDirectory = entry.fileName.endsWith("/");
	validateZipEntryType(entry, isDirectory);
	if (isDirectory) {
		await ensureSafeDirectory(root, destination);
		return;
	}
	const key =
		process.platform === "win32" ? destination.toLowerCase() : destination;
	if (seenFiles.has(key))
		throw new LokaliseError(`Duplicate ZIP entry: ${entry.fileName}`);
	seenFiles.add(key);
	await ensureSafeDirectory(root, path.dirname(destination));
	await writeZipEntry(entry, zipfile, destination);
}
/**
 * Rejects symbolic links, special files, and inconsistent
 * UNIX file types in ZIP entries.
 */
function validateZipEntryType(entry, isDirectory) {
	if (entry.versionMadeBy >>> 8 !== 3) return;
	const fileType = (entry.externalFileAttributes >>> 16) & 61440;
	const isRegularFile = fileType === 32768;
	const isUnixDirectory = fileType === 16384;
	if (fileType !== 0 && !isRegularFile && !isUnixDirectory)
		throw new LokaliseError(`Unsupported ZIP entry type: ${entry.fileName}`);
	if ((isUnixDirectory && !isDirectory) || (isRegularFile && isDirectory))
		throw new LokaliseError(`Inconsistent ZIP entry type: ${entry.fileName}`);
}
/**
 * Extracts an entry into a temporary file and replaces
 * the destination only after successful extraction.
 */
async function writeZipEntry(entry, zipfile, destination) {
	const tempFile = path.join(
		path.dirname(destination),
		`.lokalise-${randomUUID()}.tmp`,
	);
	try {
		const readStream = await zipfile.openReadStreamPromise(entry);
		await pipeline(
			readStream,
			createSizeLimiter(entry),
			createWriteStream(tempFile, {
				flags: "wx",
				mode: 384,
			}),
		);
		await rename(tempFile, destination);
	} finally {
		await rm(tempFile, { force: true });
	}
}
/**
 * Creates a stream transform that rejects ZIP entries
 * exceeding their declared or configured size limits.
 */
function createSizeLimiter(entry) {
	let bytesRead = 0;
	return new Transform({
		transform(chunk, _encoding, callback) {
			bytesRead += chunk.length;
			if (bytesRead > entry.uncompressedSize || bytesRead > MAX_ENTRY_BYTES) {
				callback(
					new LokaliseError(`ZIP entry exceeds size limit: ${entry.fileName}`),
				);
				return;
			}
			callback(null, chunk);
		},
	});
}
/**
 * Ensures that a ZIP entry stays within the extraction root.
 */
function resolveZipEntryPath(root, filename) {
	if (
		filename.includes("\0") ||
		path.posix.isAbsolute(filename) ||
		path.win32.isAbsolute(filename) ||
		/^[A-Za-z]:/.test(filename)
	)
		throw new LokaliseError(`Malicious ZIP entry: ${filename}`);
	const destination = path.resolve(root, filename);
	const relative = path.relative(root, destination);
	if (
		relative === ".." ||
		relative.startsWith(`..${path.sep}`) ||
		path.isAbsolute(relative)
	)
		throw new LokaliseError(`Malicious ZIP entry: ${filename}`);
	return destination;
}
/**
 * Creates directories while rejecting symbolic links
 * within the extraction root.
 */
async function ensureSafeDirectory(root, directory) {
	const relative = path.relative(root, directory);
	if (!relative) return;
	let current = root;
	for (const segment of relative.split(path.sep)) {
		current = path.join(current, segment);
		try {
			await mkdir(current);
		} catch (error) {
			if (error.code !== "EEXIST") throw error;
		}
		const stat = await lstat(current);
		if (!stat.isDirectory() || stat.isSymbolicLink())
			throw new LokaliseError(`Unsafe extraction directory: ${current}`);
	}
}

//#endregion
//#region lib/constants.ts
const DEFAULT_RETRY_PARAMS = {
	maxRetries: 3,
	initialSleepTime: 1e3,
	maxSleepTime: 3e4,
	jitterRatio: 0.2,
	rng: Math.random,
};
const FINISHED_STATUSES = /* @__PURE__ */ new Set([
	"finished",
	"cancelled",
	"failed",
]);
const RETRYABLE_CODES = /* @__PURE__ */ new Set([408, 429]);

//#endregion
//#region lib/utils/concurrency.ts
/**
 * Runs asynchronous tasks with limited concurrency.
 *
 * Preserves input order. On failure, stops scheduling
 * new tasks and waits for active tasks to settle.
 *
 * @param items - Items to process.
 * @param limit - Maximum concurrent operations.
 * @param worker - Async task handler.
 * @returns Results in input order.
 */
async function runWithConcurrencyLimit(items, limit, worker) {
	if (!Number.isSafeInteger(limit) || limit <= 0)
		throw new LokaliseError(
			"Concurrency limit must be a positive safe integer.",
		);
	const count = items.length;
	const results = new Array(count);
	const state = { nextIndex: 0 };
	const runWorker = async () => {
		while (!state.failure) {
			const index = state.nextIndex++;
			if (index >= count) return;
			if (!(index in items)) {
				state.failure ??= {
					error: /* @__PURE__ */ new Error(`Missing item at index ${index}`),
				};
				return;
			}
			try {
				results[index] = await worker(items[index], index);
			} catch (error) {
				state.failure ??= { error };
				return;
			}
		}
	};
	const workers = Array.from({ length: Math.min(limit, count) }, () =>
		runWorker(),
	);
	await Promise.all(workers);
	if (state.failure) throw state.failure.error;
	return results;
}

//#endregion
//#region lib/utils/process-status.ts
function isFinishedStatus(status) {
	return status != null && FINISHED_STATUSES.has(status);
}

//#endregion
//#region lib/processes/poll-lokalise-processes.ts
const FAST_FOLLOW_DELAY_MS = 200;
const MAX_TIMER_DELAY_MS = 2147483647;
/**
 * Polls Lokalise processes until they reach terminal states
 * or the polling time budget expires.
 *
 * Preserves input order and duplicate process IDs.
 * In-flight API requests may outlive the time budget.
 */
async function pollLokaliseProcesses(options) {
	const { processes, initialWaitTime, onDebug, signal } = options;
	const concurrency = options.concurrency ?? 6;
	validatePollingParams({
		initialWaitTime,
		maxWaitTime: options.maxWaitTime,
		concurrency,
	});
	signal?.throwIfAborted();
	const state = createPollingState(processes, initialWaitTime);
	onDebug?.(`Starting polling. Processes: ${processes.length}`);
	await runPollingLoop(state, options, concurrency);
	onDebug?.(`Polling stopped. Pending: ${state.pending.size}`);
	return processes.map(
		(process) => state.latest.get(process.process_id) ?? process,
	);
}
/**
 * Creates the initial polling state from queued processes.
 */
function createPollingState(processes, initialWaitTime) {
	const latest = /* @__PURE__ */ new Map();
	for (const process of processes) {
		if (typeof process.process_id !== "string" || !process.process_id.trim())
			throw new LokaliseError("Invalid or missing process ID.");
		latest.set(process.process_id, process);
	}
	return {
		latest,
		pending: new Set(
			[...latest.values()]
				.filter((p) => !isFinishedStatus(p.status))
				.map((p) => p.process_id),
		),
		startedAt: performance.now(),
		nextDelay: 0,
		backoff: Math.min(initialWaitTime, MAX_TIMER_DELAY_MS),
		fastFollowUsed: false,
	};
}
/**
 * Repeatedly fetches and applies process status updates
 * until completion or timeout.
 */
async function runPollingLoop(state, options, concurrency) {
	const { onDebug, signal } = options;
	while (state.pending.size > 0) {
		signal?.throwIfAborted();
		if (!(await waitBeforeNextRound(state, options))) break;
		const ids = [...state.pending];
		onDebug?.(`Polling ${ids.length} pending processes...`);
		const updates = await fetchStatuses(ids, concurrency, options);
		signal?.throwIfAborted();
		applyProcessUpdates(state, updates, onDebug);
	}
}
/**
 * Waits until the next polling round.
 *
 * Returns false when the time budget has expired.
 */
async function waitBeforeNextRound(state, options) {
	const { maxWaitTime, signal, onDebug } = options;
	const remaining = maxWaitTime - (performance.now() - state.startedAt);
	if (remaining <= 0) return false;
	if (state.nextDelay === 0) return true;
	if (state.nextDelay >= remaining) return false;
	const wait = Math.min(state.nextDelay, MAX_TIMER_DELAY_MS);
	onDebug?.(`Waiting ${wait}ms before polling...`);
	await setTimeout(wait, void 0, signal ? { signal } : {});
	return performance.now() - state.startedAt < maxWaitTime;
}
/**
 * Updates process states and schedules the next polling delay.
 */
function applyProcessUpdates(state, updates, onDebug) {
	let hasMissingStatus = false;
	for (const { id, process } of updates) {
		if (!process || !state.pending.has(id)) continue;
		if (process.process_id !== id) {
			onDebug?.(`Ignoring mismatched process response for ${id}`);
			continue;
		}
		state.latest.set(id, process);
		if (isFinishedStatus(process.status)) {
			state.pending.delete(id);
			onDebug?.(`Process ${id} completed: ${process.status}`);
		} else if (process.status == null) hasMissingStatus = true;
	}
	if (!state.fastFollowUsed && hasMissingStatus) {
		state.nextDelay = FAST_FOLLOW_DELAY_MS;
		state.fastFollowUsed = true;
		onDebug?.("Fast-follow: rechecking missing statuses.");
	} else {
		state.nextDelay = state.backoff;
		state.backoff = Math.min(state.backoff * 2, MAX_TIMER_DELAY_MS);
	}
}
/**
 * Fetches current process states with limited concurrency.
 *
 * Retryable API errors leave individual processes pending.
 * Other errors propagate to the caller.
 */
async function fetchStatuses(
	ids,
	concurrency,
	{ apiClient, projectId, onDebug, onWarning },
) {
	return runWithConcurrencyLimit(ids, concurrency, async (id) => {
		onDebug?.(`Requesting process ${id}...`);
		try {
			const process = await apiClient
				.queuedProcesses()
				.get(id, { project_id: projectId });
			onDebug?.(`Process ${id}: ${process.status ?? "missing"}`);
			return {
				id,
				process,
			};
		} catch (error) {
			if (!(error instanceof ApiError) || !RETRYABLE_CODES.has(error.code))
				throw error;
			onWarning?.(id, error);
			return { id };
		}
	});
}
/**
 * Validates polling intervals and concurrency settings.
 *
 * @throws {LokaliseError} If any parameter is invalid.
 */
function validatePollingParams({
	initialWaitTime,
	maxWaitTime,
	concurrency = 6,
}) {
	if (!Number.isFinite(initialWaitTime) || initialWaitTime <= 0)
		throw new LokaliseError("initialWaitTime must be a positive finite value.");
	if (!Number.isFinite(maxWaitTime) || maxWaitTime < 0)
		throw new LokaliseError("maxWaitTime must be a non-negative finite value.");
	if (!Number.isSafeInteger(concurrency) || concurrency <= 0)
		throw new LokaliseError("concurrency must be a positive safe integer.");
}

//#endregion
//#region lib/utils/retry.ts
const MAX_TIMEOUT_MS = 2147483647;
const MAX_ALLOWED_RETRIES = 10;
/**
 * Validates retry configuration.
 */
function validateRetryParams(params) {
	const { maxRetries, initialSleepTime, maxSleepTime, jitterRatio, rng } =
		params;
	if (
		!Number.isSafeInteger(maxRetries) ||
		maxRetries < 0 ||
		maxRetries > MAX_ALLOWED_RETRIES
	)
		throw new LokaliseError(
			`maxRetries must be an integer between 0 and ${MAX_ALLOWED_RETRIES}.`,
		);
	if (!Number.isFinite(initialSleepTime) || initialSleepTime < 1)
		throw new LokaliseError(
			"initialSleepTime must be a finite value of at least 1 ms.",
		);
	if (
		!Number.isFinite(maxSleepTime) ||
		maxSleepTime < initialSleepTime ||
		maxSleepTime > MAX_TIMEOUT_MS
	)
		throw new LokaliseError(
			`maxSleepTime must be between initialSleepTime and ${MAX_TIMEOUT_MS} ms.`,
		);
	if (!Number.isFinite(jitterRatio) || jitterRatio < 0 || jitterRatio > 1)
		throw new LokaliseError(
			"jitterRatio must be a finite value between 0 and 1.",
		);
	if (typeof rng !== "function")
		throw new LokaliseError("rng must be a function.");
}
/**
 * Calculates a capped exponential-backoff delay with symmetric jitter.
 *
 * retryNumber is 1-based: the first retry uses the initial delay.
 * Assumes retry parameters have already been validated.
 */
function calculateSleepMs(params, retryNumber) {
	if (!Number.isSafeInteger(retryNumber) || retryNumber < 1)
		throw new LokaliseError("retryNumber must be a positive integer.");
	const { initialSleepTime, maxSleepTime, jitterRatio, rng } = params;
	const base = Math.min(
		maxSleepTime,
		initialSleepTime * 2 ** (retryNumber - 1),
	);
	if (jitterRatio === 0) return Math.max(1, Math.round(base));
	const random = rng();
	if (!Number.isFinite(random) || random < 0 || random >= 1)
		throw new LokaliseError(
			"rng must return a finite number between 0 (inclusive) and 1 (exclusive).",
		);
	const factor = 1 + (random * 2 - 1) * jitterRatio;
	return Math.max(1, Math.min(maxSleepTime, Math.round(base * factor)));
}
/**
 * Converts a Lokalise SDK error into a library error.
 */
function wrapApiError(error, exhausted = false) {
	const message = exhausted
		? `Maximum retries reached: ${error.message}`
		: error.message;
	const wrapped = new LokaliseError(message, error.code, error.details);
	wrapped.cause = error;
	return wrapped;
}
/**
 * Executes an asynchronous operation with bounded exponential backoff.
 *
 * Only configured Lokalise API errors are retried.
 * Non-Lokalise errors are propagated unchanged.
 */
async function withExponentialBackoff(
	operation,
	params,
	{ signal, onDebug } = {},
) {
	validateRetryParams(params);
	onDebug?.(
		`Running operation with exponential backoff; max retries: ${params.maxRetries}`,
	);
	for (let attempt = 1; ; attempt++) {
		signal?.throwIfAborted();
		onDebug?.(`Attempt #${attempt}...`);
		try {
			return await operation();
		} catch (error) {
			signal?.throwIfAborted();
			if (!(error instanceof ApiError)) throw error;
			if (!RETRYABLE_CODES.has(error.code)) throw wrapApiError(error);
			if (attempt > params.maxRetries) throw wrapApiError(error, true);
			const sleepMs = calculateSleepMs(params, attempt);
			onDebug?.(
				`Retryable error (${error.code}). Waiting ${sleepMs}ms before retry...`,
			);
			await setTimeout(sleepMs, void 0, signal ? { signal } : {});
		}
	}
}
/**
 * Resolves retry configuration using default values
 * for any missing parameters.
 *
 * @param params - Optional retry parameter overrides.
 * @returns Fully resolved retry configuration.
 */
function resolveRetryParams(params) {
	return {
		maxRetries: params?.maxRetries ?? DEFAULT_RETRY_PARAMS.maxRetries,
		initialSleepTime:
			params?.initialSleepTime ?? DEFAULT_RETRY_PARAMS.initialSleepTime,
		maxSleepTime: params?.maxSleepTime ?? DEFAULT_RETRY_PARAMS.maxSleepTime,
		jitterRatio: params?.jitterRatio ?? DEFAULT_RETRY_PARAMS.jitterRatio,
		rng: params?.rng ?? DEFAULT_RETRY_PARAMS.rng,
	};
}

//#endregion
//#region lib/services/LokaliseFileExchange.ts
/**
 * A utility class for exchanging files with the Lokalise API.
 */
var LokaliseFileExchange = class {
	/**
	 * The Lokalise API client instance.
	 */
	apiClient;
	/**
	 * The ID of the project in Lokalise.
	 */
	projectId;
	/**
	 * Retry parameters for API requests.
	 */
	retryParams;
	/**
	 * Logger function.
	 */
	logger;
	/**
	 * Log threshold (do not print messages with severity less than the specified value).
	 */
	logThreshold;
	/**
	 * Creates a new instance of LokaliseFileExchange.
	 *
	 * @param clientConfig - Configuration for the Lokalise SDK.
	 * @param exchangeConfig - The configuration object for file exchange operations.
	 * @throws {LokaliseError} If the provided configuration is invalid.
	 */
	constructor(
		clientConfig,
		{
			projectId,
			useOAuth2 = false,
			retryParams,
			logThreshold = "info",
			logColor = true,
		},
	) {
		this.projectId = projectId;
		this.logThreshold = logThreshold;
		this.logger = this.chooseLogger(logColor);
		this.retryParams = resolveRetryParams(retryParams);
		this.validateParams();
		const apiConfig = this.buildLokaliseClientConfig(
			clientConfig,
			logThreshold,
		);
		this.apiClient = this.createApiClient(apiConfig, useOAuth2);
	}
	/**
	 * Validates the project ID and retry configuration.
	 *
	 * @throws {LokaliseError} If any configuration value is invalid.
	 */
	validateParams() {
		if (
			typeof this.projectId !== "string" ||
			this.projectId.trim().length === 0
		)
			throw new LokaliseError("Invalid or missing Project ID.");
		validateRetryParams(this.retryParams);
	}
	/**
	 * Builds the final Lokalise client configuration,
	 * enabling silent mode when the log threshold is `"silent"`.
	 *
	 * @param clientConfig - Base client parameters.
	 * @param logThreshold - Active logging threshold.
	 * @returns The adjusted client configuration.
	 */
	buildLokaliseClientConfig(clientConfig, logThreshold) {
		if (logThreshold === "silent")
			return {
				...clientConfig,
				silent: true,
			};
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
	createApiClient(lokaliseApiConfig, useOAuth2) {
		if (useOAuth2) {
			this.logMsg("debug", "Using OAuth 2 Lokalise API client");
			return new LokaliseApiOAuth(lokaliseApiConfig);
		}
		this.logMsg("debug", "Using regular (token-based) Lokalise API client");
		return new LokaliseApi(lokaliseApiConfig);
	}
	/**
	 * Selects the logger implementation based on whether color output is enabled.
	 *
	 * @param logColor - If true, uses the colorized logger.
	 * @returns The chosen log function.
	 */
	chooseLogger(logColor) {
		return logColor ? logWithColor : logWithLevel;
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
	logMsg(level, ...args) {
		this.logger(
			{
				level,
				threshold: this.logThreshold,
				withTimestamp: true,
			},
			...args,
		);
	}
};

//#endregion
//#region lib/services/LokaliseDownload.ts
/**
 * Handles downloading and extracting translation files from Lokalise.
 */
var LokaliseDownload = class LokaliseDownload extends LokaliseFileExchange {
	static defaultProcessParams = {
		asyncDownload: false,
		pollInitialWaitTime: 1e3,
		pollMaximumWaitTime: 12e4,
		bundleDownloadTimeout: 0,
	};
	/**
	 * Downloads translations from Lokalise, optionally using async polling, and extracts them to disk.
	 *
	 * @param downloadTranslationParams - Full configuration for the download process, extraction destination, and optional polling or timeout settings.
	 * @throws {LokaliseError} If the download, polling, or extraction fails.
	 */
	async downloadTranslations({
		downloadFileParams,
		extractParams = {},
		processDownloadFileParams,
	}) {
		this.logMsg("debug", "Downloading translations from Lokalise...");
		const processParams = this.buildProcessParams(processDownloadFileParams);
		validateDownloadTimeout(processParams.bundleDownloadTimeout);
		if (processParams.asyncDownload)
			validatePollingParams({
				initialWaitTime: processParams.pollInitialWaitTime,
				maxWaitTime: processParams.pollMaximumWaitTime,
			});
		const translationsBundleURL = await this.fetchTranslationBundleURL(
			downloadFileParams,
			processParams,
		);
		const zipFilePath = await downloadBundleZip(
			translationsBundleURL,
			processParams.bundleDownloadTimeout,
			(message, error) => this.logMsg("warn", message, error),
		);
		await this.processZip(
			zipFilePath,
			path.resolve(extractParams.outputDir ?? "./"),
		);
	}
	/**
	 * Retrieves translation bundle metadata from Lokalise
	 * with exponential-backoff retry support.
	 *
	 * @param downloadFileParams - Parameters for the Lokalise API request.
	 * @returns The translation bundle metadata.
	 * @throws {LokaliseError} If the API request fails.
	 */
	async getTranslationsBundle(downloadFileParams) {
		return withExponentialBackoff(
			() => this.apiClient.files().download(this.projectId, downloadFileParams),
			this.retryParams,
			{ onDebug: (message) => this.logMsg("debug", message) },
		);
	}
	/**
	 * Starts an asynchronous translation bundle download
	 * with exponential-backoff retry support.
	 *
	 * @param downloadFileParams - Parameters for the Lokalise API request.
	 * @returns The queued download process.
	 * @throws {LokaliseError} If the API request fails.
	 */
	async getTranslationsBundleAsync(downloadFileParams) {
		return withExponentialBackoff(
			() =>
				this.apiClient
					.files()
					.async_download(this.projectId, downloadFileParams),
			this.retryParams,
			{ onDebug: (message) => this.logMsg("debug", message) },
		);
	}
	/**
	 * Resolves download process parameters using default values
	 * for any missing options.
	 *
	 * @param overrides - Optional process configuration overrides.
	 * @returns Fully resolved process parameters.
	 */
	buildProcessParams(overrides) {
		const defaults = LokaliseDownload.defaultProcessParams;
		return {
			asyncDownload: overrides?.asyncDownload ?? defaults.asyncDownload,
			pollInitialWaitTime:
				overrides?.pollInitialWaitTime ?? defaults.pollInitialWaitTime,
			pollMaximumWaitTime:
				overrides?.pollMaximumWaitTime ?? defaults.pollMaximumWaitTime,
			bundleDownloadTimeout:
				overrides?.bundleDownloadTimeout ?? defaults.bundleDownloadTimeout,
		};
	}
	/**
	 * Extracts the downloaded ZIP archive and removes
	 * the temporary archive afterward.
	 *
	 * Cleanup failures are logged without masking extraction errors.
	 *
	 * @param zipFilePath - Path to the temporary ZIP archive.
	 * @param unpackTo - Destination directory.
	 */
	async processZip(zipFilePath, unpackTo) {
		this.logMsg("debug", `Unpacking translations to ${unpackTo}`);
		try {
			await unpackZip(zipFilePath, unpackTo);
			this.logMsg(
				"debug",
				"Translations downloaded and unpacked successfully.",
			);
		} finally {
			try {
				await fs.promises.unlink(zipFilePath);
			} catch (error) {
				this.logMsg(
					"warn",
					`Unable to remove temporary archive ${zipFilePath}`,
					error,
				);
			}
		}
	}
	/**
	 * Fetches the direct bundle URL in synchronous (non-async) mode.
	 *
	 * Calls the standard download endpoint without polling.
	 *
	 * @param downloadFileParams - Parameters for Lokalise API file download.
	 * @returns Direct bundle URL returned by Lokalise.
	 */
	async fetchBundleURLSync(downloadFileParams) {
		this.logMsg("debug", "Async download mode disabled.");
		return (await this.getTranslationsBundle(downloadFileParams)).bundle_url;
	}
	/**
	 * Polls an asynchronous download process and returns
	 * its latest known state.
	 *
	 * @param downloadProcess - Initially queued download process.
	 * @param initialWait - Initial polling interval in milliseconds.
	 * @param maxWait - Maximum polling time in milliseconds.
	 * @returns The latest process state.
	 */
	async pollAsyncDownload(downloadProcess, initialWait, maxWait) {
		this.logMsg(
			"debug",
			`Waiting for download process ${downloadProcess.process_id}...`,
		);
		const completedProcess = (
			await pollLokaliseProcesses({
				processes: [downloadProcess],
				apiClient: this.apiClient,
				projectId: this.projectId,
				initialWaitTime: initialWait,
				maxWaitTime: maxWait,
				onDebug: (message) => this.logMsg("debug", message),
				onWarning: (id, error) =>
					this.logMsg("warn", `Failed to fetch process ${id}:`, error),
			})
		)[0];
		if (
			!completedProcess ||
			completedProcess.process_id !== downloadProcess.process_id
		)
			throw new LokaliseError(
				`Process ${downloadProcess.process_id} not found after polling`,
				500,
			);
		return completedProcess;
	}
	/**
	 * Resolves the bundle download URL using either async or sync strategy.
	 *
	 * Delegates to `fetchBundleURLAsync` or `fetchBundleURLSync`
	 * based on the `asyncDownload` flag.
	 *
	 * @param downloadFileParams - Parameters for Lokalise API file download.
	 * @param processParams - Effective process parameters controlling async behavior and polling.
	 * @returns Direct bundle URL to download.
	 */
	fetchTranslationBundleURL(downloadFileParams, processParams) {
		return processParams.asyncDownload
			? this.fetchBundleURLAsync(downloadFileParams, processParams)
			: this.fetchBundleURLSync(downloadFileParams);
	}
	/**
	 * Resolves the bundle URL from a completed async process.
	 *
	 * Throws when the process failed, was cancelled,
	 * or did not finish within the polling time budget.
	 */
	resolveAsyncBundleUrl(process, maxWait) {
		const { process_id, status } = process;
		if (status === "finished") {
			const url = process.details?.download_url;
			if (typeof url !== "string" || !url.trim())
				throw new LokaliseError(
					`Process ${process_id} finished without a valid download_url`,
					502,
				);
			return url.trim();
		}
		if (status === "failed" || status === "cancelled") {
			const message = process.message?.trim();
			throw new LokaliseError(
				`Process ${process_id} ended with status=${status}${message ? `: ${message}` : ""}`,
				502,
			);
		}
		throw new LokaliseError(
			`Download process ${process_id} did not finish within ${maxWait}ms (last status=${status ?? "missing"})`,
			504,
		);
	}
	/**
	 * Queues an asynchronous translation bundle download,
	 * polls the process, and returns the generated bundle URL.
	 *
	 * @param downloadFileParams - Lokalise API download parameters.
	 * @param processParams - Resolved download process configuration.
	 * @returns Direct URL of the generated ZIP bundle.
	 */
	async fetchBundleURLAsync(downloadFileParams, processParams) {
		this.logMsg("debug", "Async download mode enabled.");
		const downloadProcess =
			await this.getTranslationsBundleAsync(downloadFileParams);
		const completedProcess = await this.pollAsyncDownload(
			downloadProcess,
			processParams.pollInitialWaitTime,
			processParams.pollMaximumWaitTime,
		);
		this.logMsg(
			"debug",
			`Download process status: ${completedProcess.status ?? "missing"}`,
		);
		return this.resolveAsyncBundleUrl(
			completedProcess,
			processParams.pollMaximumWaitTime,
		);
	}
};

//#endregion
//#region lib/collectors/file-collector.ts
const SKIPPABLE_ERRORS = /* @__PURE__ */ new Set([
	"ENOENT",
	"EACCES",
	"EPERM",
	"ENOTDIR",
]);
/**
 * Collects matching files from one or more directories.
 *
 * Returns unique absolute paths in sorted order.
 * Symbolic links are not followed during recursive traversal.
 */
async function collectFiles(
	{
		inputDirs = ["./locales"],
		extensions = [".*"],
		excludePatterns = [],
		recursive = true,
		fileNamePattern = ".*",
	} = {},
	options = {},
) {
	return walkDirectories(
		inputDirs,
		{
			extensions: new Set(
				extensions.map((ext) =>
					(ext.startsWith(".") ? ext : `.${ext}`).toLowerCase(),
				),
			),
			nameRegex: compileRegex(fileNamePattern, "fileNamePattern"),
			excludeRegexes: excludePatterns.map((pattern) =>
				compileRegex(pattern, "excludePatterns"),
			),
			recursive,
		},
		options,
	);
}
/**
 * Traverses directories using a queue and collects matching files.
 */
async function walkDirectories(inputDirs, filters, options) {
	const queue = inputDirs.map((dir) => ({
		path: path.resolve(dir),
		isRoot: true,
	}));
	const visited = /* @__PURE__ */ new Set();
	const found = /* @__PURE__ */ new Set();
	for (const { path: dir, isRoot } of queue) {
		if (visited.has(dir)) continue;
		visited.add(dir);
		const entries = await readDirectory(dir, isRoot, options);
		for (const entry of entries) {
			const fullPath = path.resolve(dir, entry.name);
			if (shouldExclude(fullPath, filters.excludeRegexes)) continue;
			if (entry.isDirectory()) {
				if (filters.recursive)
					queue.push({
						path: fullPath,
						isRoot: false,
					});
			} else if (entry.isFile() && matchesFile(entry, filters))
				found.add(fullPath);
		}
	}
	return [...found].sort();
}
/**
 * Reads a directory, allowing recoverable failures in nested directories.
 * Errors for explicitly requested root directories are always propagated.
 */
async function readDirectory(dir, isRoot, { onWarning }) {
	try {
		return await fs.promises.readdir(dir, { withFileTypes: true });
	} catch (error) {
		const code = error.code;
		if (!isRoot && code && SKIPPABLE_ERRORS.has(code)) {
			onWarning?.(`Skipping inaccessible directory: ${dir}`, error);
			return [];
		}
		throw new Error(`Failed to read directory: ${dir}`, { cause: error });
	}
}
/**
 * Checks filename and extension filters.
 */
function matchesFile(entry, filters) {
	const extension = path.extname(entry.name).toLowerCase();
	return (
		(filters.extensions.has(".*") || filters.extensions.has(extension)) &&
		testRegex(filters.nameRegex, entry.name)
	);
}
/**
 * Checks exclusions against native and POSIX paths.
 */
function shouldExclude(filePath, regexes) {
	const posixPath = filePath.split(path.sep).join("/");
	return regexes.some(
		(regex) => testRegex(regex, filePath) || testRegex(regex, posixPath),
	);
}
/**
 * Compiles a pattern while preserving the original error.
 */
function compileRegex(pattern, name) {
	try {
		return new RegExp(pattern);
	} catch (error) {
		throw new Error(`Invalid ${name}: ${String(pattern)}`, { cause: error });
	}
}
/**
 * Tests a regular expression without retaining lastIndex state.
 */
function testRegex(regex, value) {
	regex.lastIndex = 0;
	return regex.test(value);
}

//#endregion
//#region lib/processors/upload-file.ts
/**
 * Prepares a file for uploading to Lokalise.
 *
 * Infers its filename and language code, then reads
 * the contents as a base64-encoded string.
 */
async function processUploadFile(file, projectRoot, params) {
	const filename = await inferUploadFilename(file, projectRoot, params);
	const lang_iso = await inferLanguageCode(file, filename, params);
	return {
		data: (await fs$1.readFile(file)).toString("base64"),
		filename,
		lang_iso,
	};
}
/**
 * Infers the upload filename using a custom inferer or
 * the path relative to the project root.
 */
async function inferUploadFilename(file, projectRoot, params) {
	const inferred = await params?.filenameInferer?.(file);
	if (inferred !== void 0) {
		if (typeof inferred !== "string")
			throw new LokaliseError("filenameInferer must return a string.");
		if (inferred.trim()) return inferred.replaceAll("\\", "/");
	}
	const relative = path.relative(projectRoot, file);
	if (
		!relative ||
		relative === ".." ||
		relative.startsWith(`..${path.sep}`) ||
		path.isAbsolute(relative)
	)
		throw new LokaliseError(`File is outside the project root: ${file}`);
	return relative.split(path.sep).join("/");
}
/**
 * Infers the language code using a custom inferer or
 * the filename segment before the final extension.
 */
async function inferLanguageCode(file, filename, params) {
	const inferred = await params?.languageInferer?.(file);
	if (inferred !== void 0) {
		if (typeof inferred !== "string")
			throw new LokaliseError("languageInferer must return a string.");
		if (inferred.trim()) return inferred;
	}
	const lang = path.posix.basename(filename).split(".").at(-2);
	if (!lang?.trim())
		throw new LokaliseError(
			`Cannot infer language code from filename: ${filename}`,
		);
	return lang;
}

//#endregion
//#region lib/services/LokaliseUpload.ts
/**
 * Handles uploading translation files to Lokalise.
 */
var LokaliseUpload = class LokaliseUpload extends LokaliseFileExchange {
	static defaultPollingParams = {
		pollStatuses: false,
		pollInitialWaitTime: 1e3,
		pollMaximumWaitTime: 12e4,
	};
	/**
	 * Collects and uploads translation files to Lokalise.
	 * Optionally polls queued processes and returns their statuses
	 * along with any upload errors.
	 *
	 * @param params - File collection, upload, and processing options.
	 * @returns Queued processes and upload errors.
	 */
	async uploadTranslations({
		uploadFileParams,
		collectFileParams,
		processUploadFileParams,
	} = {}) {
		this.logMsg("debug", "Uploading translations to Lokalise...");
		const polling = this.resolvePollingParams(processUploadFileParams);
		const files = await collectFiles(collectFileParams, {
			onWarning: (message, error) => this.logMsg("warn", message, error),
		});
		const { processes, errors } = await this.parallelUpload(
			files,
			uploadFileParams,
			processUploadFileParams,
		);
		const shouldPoll = polling.pollStatuses && processes.length > 0;
		const completedProcesses = shouldPoll
			? await this.pollUploadedProcesses(
					processes,
					polling.pollInitialWaitTime,
					polling.pollMaximumWaitTime,
				)
			: processes;
		this.logUploadSummary(completedProcesses, errors, shouldPoll);
		return {
			processes: completedProcesses,
			errors,
		};
	}
	/**
	 * Uploads a single file to Lokalise with retry support.
	 *
	 * @param uploadParams - File upload parameters.
	 * @returns The queued upload process.
	 */
	async uploadSingleFile(uploadParams) {
		return withExponentialBackoff(
			() => this.apiClient.files().upload(this.projectId, uploadParams),
			this.retryParams,
			{ onDebug: (message) => this.logMsg("debug", message) },
		);
	}
	/**
	 * Uploads files concurrently while preserving input order
	 * in the resulting process and error arrays.
	 *
	 * Individual file failures do not stop other uploads.
	 */
	async parallelUpload(files, baseUploadFileParams = {}, processParams) {
		const projectRoot = process.cwd();
		const results = await runWithConcurrencyLimit(files, 6, async (file) => {
			try {
				const processed = await processUploadFile(
					file,
					projectRoot,
					processParams,
				);
				return {
					ok: true,
					process: await this.uploadSingleFile({
						...baseUploadFileParams,
						...processed,
					}),
				};
			} catch (error) {
				return {
					ok: false,
					error: {
						file,
						error,
					},
				};
			}
		});
		const processes = [];
		const errors = [];
		for (const result of results)
			if (result.ok) processes.push(result.process);
			else errors.push(result.error);
		return {
			processes,
			errors,
		};
	}
	async pollUploadedProcesses(processes, initialWaitTime, maxWaitTime) {
		return pollLokaliseProcesses({
			processes,
			apiClient: this.apiClient,
			projectId: this.projectId,
			initialWaitTime,
			maxWaitTime,
			onDebug: (message) => this.logMsg("debug", message),
			onWarning: (id, error) =>
				this.logMsg("warn", `Failed to fetch process ${id}:`, error),
		});
	}
	/**
	 * Resolves polling options and validates enabled polling settings.
	 *
	 * @param params - Optional polling configuration.
	 * @returns Polling configuration with all defaults applied.
	 */
	resolvePollingParams(params) {
		const defaults = LokaliseUpload.defaultPollingParams;
		const resolved = {
			pollStatuses: params?.pollStatuses ?? defaults.pollStatuses,
			pollInitialWaitTime:
				params?.pollInitialWaitTime ?? defaults.pollInitialWaitTime,
			pollMaximumWaitTime:
				params?.pollMaximumWaitTime ?? defaults.pollMaximumWaitTime,
		};
		if (resolved.pollStatuses)
			validatePollingParams({
				initialWaitTime: resolved.pollInitialWaitTime,
				maxWaitTime: resolved.pollMaximumWaitTime,
			});
		return resolved;
	}
	/**
	 * Logs upload results and, if polling was performed,
	 * summarizes the latest process statuses.
	 *
	 * @param processes - Queued processes with their latest states.
	 * @param errors - Errors encountered while uploading files.
	 * @param wasPolled - Whether process polling was performed.
	 */
	logUploadSummary(processes, errors, wasPolled) {
		this.logMsg("debug", `Upload processes received: ${processes.length}.`);
		if (errors.length > 0)
			this.logMsg("warn", `Upload completed with ${errors.length} error(s).`);
		if (!wasPolled) return;
		const failedCount = processes.filter(
			(p) => p.status === "failed" || p.status === "cancelled",
		).length;
		const pendingCount = processes.filter(
			(p) => !isFinishedStatus(p.status),
		).length;
		this.logMsg(
			"debug",
			`Polling stopped. Failed/cancelled: ${failedCount}, pending: ${pendingCount}.`,
		);
	}
};

//#endregion
export { LokaliseDownload, LokaliseError, LokaliseUpload };
//# sourceMappingURL=index.mjs.map
