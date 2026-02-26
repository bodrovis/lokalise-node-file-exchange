// lib/errors/LokaliseError.ts
var LokaliseError = class extends Error {
  /**
   * The error code representing the type of Lokalise API error.
   */
  code;
  /**
   * Additional details about the error.
   */
  details;
  /**
   * Creates a new instance of LokaliseError.
   *
   * @param message - The error message.
   * @param code - The error code (optional).
   * @param details - Optional additional details about the error.
   */
  constructor(message, code, details) {
    super(message);
    this.code = code;
    if (details) {
      this.details = details;
    }
  }
  /**
   * Returns a string representation of the error, including code and details.
   *
   * @returns The formatted error message.
   */
  toString() {
    let baseMessage = `LokaliseError: ${this.message}`;
    if (this.code) {
      baseMessage += ` (Code: ${this.code})`;
    }
    if (this.details) {
      const formattedDetails = Object.entries(this.details).map(([key, value]) => `${key}: ${value}`).join(", ");
      baseMessage += ` | Details: ${formattedDetails}`;
    }
    return baseMessage;
  }
};

// lib/services/LokaliseDownload.ts
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { pipeline, Readable } from "stream";
import { promisify } from "util";
import yauzl from "yauzl";

// lib/services/LokaliseFileExchange.ts
import {
  LokaliseApi,
  ApiError as LokaliseApiError,
  LokaliseApiOAuth
} from "@lokalise/node-api";
import {
  logWithColor,
  logWithLevel
} from "kliedz";
var LokaliseFileExchange = class _LokaliseFileExchange {
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
   * Default retry parameters for API requests.
   */
  static defaultRetryParams = {
    maxRetries: 3,
    initialSleepTime: 1e3,
    jitterRatio: 0.2,
    rng: Math.random
  };
  static FINISHED_STATUSES = [
    "finished",
    "cancelled",
    "failed"
  ];
  static RETRYABLE_CODES = [408, 429];
  static maxConcurrentProcesses = 6;
  static isPendingStatus(status) {
    return !_LokaliseFileExchange.isFinishedStatus(status);
  }
  static isFinishedStatus(status) {
    return status != null && _LokaliseFileExchange.FINISHED_STATUSES.includes(
      status
    );
  }
  /**
   * Creates a new instance of LokaliseFileExchange.
   *
   * @param clientConfig - Configuration for the Lokalise SDK.
   * @param exchangeConfig - The configuration object for file exchange operations.
   * @throws {LokaliseError} If the provided configuration is invalid.
   */
  constructor(clientConfig, {
    projectId,
    useOAuth2 = false,
    retryParams,
    logThreshold = "info",
    logColor = true
  }) {
    this.projectId = projectId;
    this.logThreshold = logThreshold;
    this.logger = this.chooseLogger(logColor);
    this.retryParams = this.buildRetryParams(retryParams);
    this.validateParams();
    const apiConfig = this.buildLokaliseClientConfig(
      clientConfig,
      logThreshold
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
  async withExponentialBackoff(operation) {
    const { maxRetries } = this.retryParams;
    this.logMsg(
      "debug",
      `Running operation with exponential backoff; max retries: ${maxRetries}`
    );
    for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
      try {
        this.logMsg("debug", `Attempt #${attempt}...`);
        return await operation();
      } catch (error) {
        if (error instanceof LokaliseApiError && this.isRetryable(error)) {
          this.logMsg("debug", `Retryable error caught: ${error.message}`);
          if (attempt === maxRetries + 1) {
            throw new LokaliseError(
              `Maximum retries reached: ${error.message}`,
              error.code,
              error.details
            );
          }
          const sleepMs = this.calculateSleepMs(this.retryParams, attempt);
          this.logMsg("debug", `Waiting ${sleepMs}ms before retry...`);
          await _LokaliseFileExchange.sleep(sleepMs);
        } else if (error instanceof LokaliseApiError) {
          throw new LokaliseError(error.message, error.code, error.details);
        } else {
          throw error;
        }
      }
    }
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
  async pollProcesses(processes, initialWaitTime, maxWaitTime, concurrency = _LokaliseFileExchange.maxConcurrentProcesses) {
    this.logMsg(
      "debug",
      `Start polling processes. Total processes count: ${processes.length}`
    );
    const startTime = Date.now();
    const { processMap, pendingProcessIds } = this.initializePollingState(processes);
    await this.runPollingLoop(
      processMap,
      pendingProcessIds,
      startTime,
      initialWaitTime,
      maxWaitTime,
      concurrency
    );
    if (pendingProcessIds.size > 0) {
      await this.refreshRemainingProcesses(
        processMap,
        pendingProcessIds,
        concurrency
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
  initializePollingState(processes) {
    this.logMsg("debug", "Initial processes check...");
    const processMap = /* @__PURE__ */ new Map();
    const pendingProcessIds = /* @__PURE__ */ new Set();
    for (const p of processes) {
      if (p.status) {
        this.logMsg(
          "debug",
          `Process ID: ${p.process_id}, status: ${p.status}`
        );
      } else {
        this.logMsg("debug", `Process ID: ${p.process_id}, status is missing`);
      }
      processMap.set(p.process_id, p);
      if (_LokaliseFileExchange.isPendingStatus(p.status)) {
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
  async runPollingLoop(processMap, pendingProcessIds, startTime, initialWaitTime, maxWaitTime, concurrency) {
    let waitTime = initialWaitTime;
    let didFastFollow = false;
    while (pendingProcessIds.size > 0 && Date.now() - startTime < maxWaitTime) {
      this.logMsg("debug", `Polling... Pending IDs: ${pendingProcessIds.size}`);
      if (!didFastFollow && [...processMap.values()].some((p) => p.status == null)) {
        this.logMsg(
          "debug",
          "Fast-follow: some statuses missing, quick recheck in 200ms"
        );
        await _LokaliseFileExchange.sleep(200);
        didFastFollow = true;
      }
      const ids = [...pendingProcessIds];
      const batch = await this.fetchProcessesBatch(ids, concurrency);
      for (const { id, process: process2 } of batch) {
        if (!process2) continue;
        processMap.set(id, process2);
        if (_LokaliseFileExchange.isFinishedStatus(process2.status)) {
          this.logMsg(
            "debug",
            `Process ${id} completed with status=${process2.status}.`
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
          "Time budget exhausted, stopping polling without extra sleep."
        );
        break;
      }
      const sleepMs = Math.min(waitTime, remaining);
      this.logMsg("debug", `Waiting ${sleepMs}...`);
      await _LokaliseFileExchange.sleep(sleepMs);
      waitTime = Math.min(
        waitTime * 2,
        Math.max(0, maxWaitTime - (Date.now() - startTime))
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
  async refreshRemainingProcesses(processMap, pendingProcessIds, concurrency) {
    this.logMsg(
      "debug",
      `Final refresh for ${pendingProcessIds.size} pending processes before return...`
    );
    const finalBatch = await this.fetchProcessesBatch(
      [...pendingProcessIds],
      concurrency
    );
    for (const { id, process: process2 } of finalBatch) {
      if (process2) {
        processMap.set(id, process2);
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
  isRetryable(error) {
    return _LokaliseFileExchange.RETRYABLE_CODES.includes(error.code);
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
      { level, threshold: this.logThreshold, withTimestamp: true },
      ...args
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
  async getUpdatedProcess(processId) {
    this.logMsg("debug", `Requesting update for process ID: ${processId}`);
    const updatedProcess = await this.apiClient.queuedProcesses().get(processId, { project_id: this.projectId });
    if (updatedProcess.status) {
      this.logMsg(
        "debug",
        `Process ID: ${updatedProcess.process_id}, status: ${updatedProcess.status}`
      );
    } else {
      this.logMsg(
        "debug",
        `Process ID: ${updatedProcess.process_id}, status is missing`
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
  validateParams() {
    if (!this.projectId || typeof this.projectId !== "string") {
      throw new LokaliseError("Invalid or missing Project ID.");
    }
    const { maxRetries, initialSleepTime, jitterRatio } = this.retryParams;
    if (maxRetries < 0) {
      throw new LokaliseError(
        "maxRetries must be greater than or equal to zero."
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
  async runWithConcurrencyLimit(items, limit, worker) {
    const results = new Array(items.length);
    let i = 0;
    const workers = new Array(Math.min(limit, items.length)).fill(null).map(async () => {
      while (true) {
        const idx = i++;
        if (idx >= items.length) break;
        const item = items[idx];
        if (item === void 0) {
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
  async fetchProcessesBatch(processIds, concurrency = _LokaliseFileExchange.maxConcurrentProcesses) {
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
  static sleep(ms) {
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
  calculateSleepMs(retryParams, attempt) {
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
  buildLokaliseClientConfig(clientConfig, logThreshold) {
    if (logThreshold === "silent") {
      return {
        ...clientConfig,
        silent: true
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
  createApiClient(lokaliseApiConfig, useOAuth2) {
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
  buildRetryParams(retryParams) {
    return {
      ..._LokaliseFileExchange.defaultRetryParams,
      ...retryParams
    };
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
};

// lib/services/LokaliseDownload.ts
var LokaliseDownload = class _LokaliseDownload extends LokaliseFileExchange {
  static defaultProcessParams = {
    asyncDownload: false,
    pollInitialWaitTime: 1e3,
    pollMaximumWaitTime: 12e4,
    bundleDownloadTimeout: 0
  };
  streamPipeline = promisify(pipeline);
  /**
   * Downloads translations from Lokalise, optionally using async polling, and extracts them to disk.
   *
   * @param downloadTranslationParams - Full configuration for the download process, extraction destination, and optional polling or timeout settings.
   * @throws {LokaliseError} If the download, polling, or extraction fails.
   */
  async downloadTranslations({
    downloadFileParams,
    extractParams = {},
    processDownloadFileParams
  }) {
    this.logMsg("debug", "Downloading translations from Lokalise...");
    const processParams = this.buildProcessParams(processDownloadFileParams);
    const translationsBundleURL = await this.fetchTranslationBundleURL(
      downloadFileParams,
      processParams
    );
    const zipFilePath = await this.downloadZip(
      translationsBundleURL,
      processParams.bundleDownloadTimeout
    );
    await this.processZip(
      zipFilePath,
      path.resolve(extractParams.outputDir ?? "./")
    );
  }
  /**
   * Unpacks a ZIP file into the specified directory.
   *
   * @param zipFilePath - Path to the ZIP file.
   * @param outputDir - Directory to extract the files into.
   * @throws {LokaliseError} If extraction fails or malicious paths are detected.
   */
  async unpackZip(zipFilePath, outputDir) {
    return new Promise((resolve, reject) => {
      yauzl.open(zipFilePath, { lazyEntries: true }, (err, zipfile) => {
        if (err) {
          return reject(
            new LokaliseError(
              `Failed to open ZIP file at ${zipFilePath}: ${err.message}`
            )
          );
        }
        zipfile.readEntry();
        zipfile.on("entry", (entry) => {
          this.handleZipEntry(entry, zipfile, outputDir).then(() => zipfile.readEntry()).catch(reject);
        });
        zipfile.on("end", resolve);
        zipfile.on("error", reject);
      });
    });
  }
  /**
   * Downloads a ZIP file from the given URL and stores it as a temporary file.
   *
   * Performs URL validation, optional timeout handling, fetch request execution,
   * response integrity checks, and writes the ZIP stream to disk.
   *
   * @param url - Direct URL to the ZIP bundle provided by Lokalise.
   * @param downloadTimeout - Optional timeout (in ms) for the HTTP request. `0` disables timeouts.
   * @returns Absolute path to the temporary ZIP file on disk.
   */
  async downloadZip(url, downloadTimeout = 0) {
    this.logMsg("debug", "Downloading translation bundle...");
    const bundleURL = this.assertHttpUrl(url);
    const tempZipPath = this.buildTempZipPath();
    const signal = this.buildAbortSignal(downloadTimeout);
    const response = await this.fetchZipResponse(
      bundleURL,
      signal,
      downloadTimeout
    );
    const body = this.getZipResponseBody(response, url);
    await this.writeZipToDisk(body, tempZipPath);
    return tempZipPath;
  }
  /**
   * Builds a unique temporary file path for storing the downloaded ZIP bundle.
   *
   * Uses a UUID when available or falls back to a combination of PID, timestamp, and random bytes.
   *
   * @returns A full path to a temporary ZIP file in the OS temp directory.
   */
  buildTempZipPath() {
    const uid = crypto.randomUUID?.() ?? `${process.pid}-${Date.now()}-${crypto.randomBytes(8).toString("hex")}`;
    return path.join(os.tmpdir(), `lokalise-${uid}.zip`);
  }
  /**
   * Creates an optional AbortSignal for enforcing request timeouts.
   *
   * Returns `undefined` when no timeout is configured, disabling abort handling.
   *
   * @param downloadTimeout - Timeout in milliseconds. `0` or negative disables the signal.
   * @returns An AbortSignal if timeout is enabled, otherwise `undefined`.
   */
  buildAbortSignal(downloadTimeout) {
    if (downloadTimeout <= 0) {
      return void 0;
    }
    return AbortSignal.timeout(downloadTimeout);
  }
  /**
   * Executes a fetch request for the ZIP bundle URL with optional timeout handling.
   *
   * Wraps network failures, timeouts, and unexpected fetch errors into `LokaliseError`
   * so higher-level logic receives consistent exceptions.
   *
   * @param bundleURL - Parsed URL pointing to the ZIP file.
   * @param signal - Optional `AbortSignal` used to enforce request timeouts.
   * @param downloadTimeout - Timeout duration (ms) used for error messaging.
   * @returns The raw `Response` object returned by `fetch` if the request succeeds.
   */
  async fetchZipResponse(bundleURL, signal, downloadTimeout) {
    try {
      return await fetch(bundleURL, signal ? { signal } : {});
    } catch (err) {
      if (err instanceof Error) {
        if (err.name === "TimeoutError") {
          throw new LokaliseError(
            `Request timed out after ${downloadTimeout}ms`,
            408,
            { reason: "timeout" }
          );
        }
        throw new LokaliseError(err.message, 500, {
          reason: "network or fetch error"
        });
      }
      throw new LokaliseError(
        "An unknown error occurred. This might indicate a bug.",
        500,
        {
          reason: String(err)
        }
      );
    }
  }
  /**
   * Validates and extracts the readable body stream from a fetch response.
   *
   * Ensures the response is OK and has a non-null body before returning it.
   *
   * @param response - The HTTP response returned by `fetch`.
   * @param originalUrl - Original URL used for error diagnostics.
   * @returns A web ReadableStream of the ZIP file contents.
   * @throws {LokaliseError} If the response is not OK or body is missing.
   */
  getZipResponseBody(response, originalUrl) {
    if (!response.ok) {
      throw new LokaliseError(
        `Failed to download ZIP file: ${response.statusText} (${response.status})`
      );
    }
    const body = response.body;
    if (!body) {
      throw new LokaliseError(
        `Response body is null. Cannot download ZIP file from URL: ${originalUrl}`
      );
    }
    return body;
  }
  /**
   * Streams the ZIP response body to a temporary file on disk.
   *
   * Cleans up the temporary file if the streaming pipeline fails.
   *
   * @param body - Web readable stream of the ZIP content.
   * @param tempZipPath - Path where the ZIP should be written.
   * @returns A promise that resolves once the file is fully written.
   * @throws {Error} Re-throws any pipeline errors after attempting cleanup.
   */
  async writeZipToDisk(body, tempZipPath) {
    try {
      const nodeReadable = Readable.fromWeb(body);
      await this.streamPipeline(
        nodeReadable,
        fs.createWriteStream(tempZipPath)
      );
    } catch (e) {
      try {
        await fs.promises.unlink(tempZipPath);
      } catch {
        this.logMsg(
          "debug",
          `Stream pipeline failed and unable to remove temp path ${tempZipPath}`
        );
      }
      throw e;
    }
  }
  /**
   * Retrieves a translation bundle from Lokalise with retries and exponential backoff.
   *
   * @param downloadFileParams - Parameters for Lokalise API file download.
   * @returns The downloaded bundle metadata.
   * @throws {LokaliseError} If retries are exhausted or an API error occurs.
   */
  async getTranslationsBundle(downloadFileParams) {
    return this.withExponentialBackoff(
      () => this.apiClient.files().download(this.projectId, downloadFileParams)
    );
  }
  /**
   * Retrieves a translation bundle from Lokalise with retries and exponential backoff.
   *
   * @param downloadFileParams - Parameters for Lokalise API file download.
   * @returns The queued process.
   * @throws {LokaliseError} If retries are exhausted or an API error occurs.
   */
  async getTranslationsBundleAsync(downloadFileParams) {
    return this.withExponentialBackoff(
      () => this.apiClient.files().async_download(this.projectId, downloadFileParams)
    );
  }
  /**
   * Extracts a single entry from a ZIP archive to the specified output directory.
   *
   * Creates necessary directories and streams the file content to disk.
   *
   * @param entry - The ZIP entry to extract.
   * @param zipfile - The open ZIP file instance.
   * @param outputDir - The directory where the entry should be written.
   * @returns A promise that resolves when the entry is fully written.
   */
  async handleZipEntry(entry, zipfile, outputDir) {
    const fullPath = this.processZipEntryPath(outputDir, entry.fileName);
    if (entry.fileName.endsWith("/")) {
      await this.createDir(fullPath);
      return;
    }
    await this.createDir(path.dirname(fullPath));
    return new Promise((response, reject) => {
      zipfile.openReadStream(entry, (readErr, readStream) => {
        if (readErr || !readStream) {
          return reject(
            new LokaliseError(`Failed to read ZIP entry: ${entry.fileName}`)
          );
        }
        const writeStream = fs.createWriteStream(fullPath);
        readStream.pipe(writeStream);
        writeStream.on("finish", response);
        writeStream.on("error", reject);
        readStream.on("error", reject);
      });
    });
  }
  /**
   * Creates a directory and all necessary parent directories.
   *
   * @param dir - The directory path to create.
   * @returns A promise that resolves when the directory is created.
   */
  async createDir(dir) {
    await fs.promises.mkdir(dir, { recursive: true });
  }
  /**
   * Resolves and validates the full output path for a ZIP entry.
   *
   * Prevents path traversal attacks by ensuring the resolved path stays within the output directory.
   *
   * @param outputDir - The base output directory.
   * @param entryFilename - The filename of the ZIP entry.
   * @returns The absolute and safe path to write the entry.
   * @throws {LokaliseError} If the entry path is detected as malicious.
   */
  processZipEntryPath(outputDir, entryFilename) {
    const fullPath = path.resolve(outputDir, entryFilename);
    const relative = path.relative(outputDir, fullPath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new LokaliseError(`Malicious ZIP entry detected: ${entryFilename}`);
    }
    return fullPath;
  }
  /**
   * Parses and validates a URL string, ensuring it uses HTTP or HTTPS protocol.
   *
   * @param value - The URL string to validate.
   * @returns A parsed `URL` object if valid.
   * @throws {LokaliseError} If the URL is invalid or uses an unsupported protocol.
   */
  assertHttpUrl(value) {
    let parsed;
    try {
      parsed = new URL(value);
    } catch {
      throw new LokaliseError(`Invalid URL: ${value}`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new LokaliseError(`Unsupported protocol in URL: ${value}`);
    }
    return parsed;
  }
  /**
   * Builds effective process parameters for the download workflow.
   *
   * Merges caller-provided overrides with the default settings.
   *
   * @param overrides - Partial process configuration to override defaults.
   * @returns Fully resolved process parameters.
   */
  buildProcessParams(overrides) {
    return {
      ..._LokaliseDownload.defaultProcessParams,
      ...overrides
    };
  }
  /**
   * Unpacks the downloaded ZIP archive into the target directory and
   * removes the temporary archive file afterwards.
   *
   * Logs progress and always attempts to delete the temporary file.
   *
   * @param zipFilePath - Path to the temporary ZIP file.
   * @param unpackTo - Destination directory for extracted files.
   */
  async processZip(zipFilePath, unpackTo) {
    this.logMsg(
      "debug",
      `Unpacking translations from ${zipFilePath} to ${unpackTo}`
    );
    try {
      await this.unpackZip(zipFilePath, unpackTo);
      this.logMsg("debug", "Translations unpacked!");
      this.logMsg("debug", "Download successful!");
    } finally {
      this.logMsg("debug", `Removing temp archive from ${zipFilePath}`);
      await fs.promises.unlink(zipFilePath);
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
    const translationsBundle = await this.getTranslationsBundle(downloadFileParams);
    return translationsBundle.bundle_url;
  }
  /**
   * Polls an async download process until it completes or the maximum wait time is reached.
   *
   * Validates the final status and throws if the process did not finish properly.
   *
   * @param downloadProcess - The initially queued async process.
   * @param initialWait - Initial interval in ms before the first poll.
   * @param maxWait - Maximum total wait time in ms.
   * @returns The completed process object.
   * @throws {LokaliseError} If the process is not found or does not finish successfully.
   */
  async pollAsyncDownload(downloadProcess, initialWait, maxWait) {
    this.logMsg(
      "debug",
      `Waiting for download process ID ${downloadProcess.process_id} to complete...`
    );
    this.logMsg(
      "debug",
      `Effective waits: initial=${initialWait}ms, max=${maxWait}ms`
    );
    const results = await this.pollProcesses(
      [downloadProcess],
      initialWait,
      maxWait
    );
    const completedProcess = results.find(
      (p) => p.process_id === downloadProcess.process_id
    );
    if (!completedProcess) {
      throw new LokaliseError(
        `Process ${downloadProcess.process_id} not found after polling`,
        500
      );
    }
    if (!LokaliseFileExchange.isFinishedStatus(completedProcess.status)) {
      throw new LokaliseError(
        `Download process did not finish within ${maxWait}ms${completedProcess.status ? ` (last status=${completedProcess.status})` : " (status missing)"}`,
        504
      );
    }
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
    return processParams.asyncDownload ? this.fetchBundleURLAsync(downloadFileParams, processParams) : this.fetchBundleURLSync(downloadFileParams);
  }
  /**
   * Extracts and verifies the download URL from a finished async process.
   *
   * Ensures `details.download_url` is present and is a string.
   *
   * @param completedProcess - Process object with status `finished`.
   * @returns Valid download URL string.
   * @throws {LokaliseError} If the URL is missing or invalid.
   */
  handleFinishedAsyncProcess(completedProcess) {
    const details = completedProcess.details;
    const url = details?.download_url;
    if (!url || typeof url !== "string") {
      this.logMsg(
        "warn",
        "Process finished but details.download_url is missing or invalid",
        details
      );
      throw new LokaliseError(
        "Lokalise returned finished process without a valid download_url",
        502
      );
    }
    return url;
  }
  /**
   * Handles a failed or cancelled async process by throwing an error with context.
   *
   * Includes the process status and optional message from Lokalise.
   *
   * @param completedProcess - Process object with status `failed` or `cancelled`.
   * @throws {LokaliseError} Always throws, as the process did not succeed.
   */
  handleFailedAsyncProcess(completedProcess) {
    const msg = completedProcess.message?.trim();
    throw new LokaliseError(
      `Process ${completedProcess.process_id} ended with status=${completedProcess.status}` + (msg ? `: ${msg}` : ""),
      502
    );
  }
  /**
   * Handles an unexpected async process outcome when it did not finish in time.
   *
   * Logs a warning and throws an error indicating that finalization took too long.
   *
   * @param completedProcess - Process object with unexpected status.
   * @param maxWait - Effective maximum wait time used during polling.
   * @throws {LokaliseError} Always throws to signal an unexpected async outcome.
   */
  handleUnexpectedAsyncProcess(completedProcess, maxWait) {
    this.logMsg("warn", `Process ended with status=${completedProcess.status}`);
    throw new LokaliseError(
      `Download process took too long to finalize; effective=${maxWait}ms`,
      500
    );
  }
  /**
   * Runs the async download flow: queues the download, polls its status,
   * and returns the final bundle URL once the process completes.
   *
   * Handles finished, failed/cancelled, and unexpected statuses separately.
   *
   * @param downloadFileParams - Parameters for Lokalise API async file download.
   * @param processParams - Effective process parameters controlling polling behavior.
   * @returns Direct URL to the generated ZIP bundle.
   * @throws {LokaliseError} If the process fails, is cancelled, or does not finalize properly.
   */
  async fetchBundleURLAsync(downloadFileParams, processParams) {
    this.logMsg("debug", "Async download mode enabled.");
    const downloadProcess = await this.getTranslationsBundleAsync(downloadFileParams);
    const { pollInitialWaitTime, pollMaximumWaitTime } = processParams;
    const completedProcess = await this.pollAsyncDownload(
      downloadProcess,
      pollInitialWaitTime,
      pollMaximumWaitTime
    );
    this.logMsg(
      "debug",
      `Download process status is ${completedProcess.status}`
    );
    if (completedProcess.status === "finished") {
      return this.handleFinishedAsyncProcess(completedProcess);
    }
    if (completedProcess.status === "failed" || completedProcess.status === "cancelled") {
      this.handleFailedAsyncProcess(completedProcess);
    }
    this.handleUnexpectedAsyncProcess(completedProcess, pollMaximumWaitTime);
  }
};

// lib/services/LokaliseUpload.ts
import fs2 from "fs";
import path2 from "path";
var LokaliseUpload = class _LokaliseUpload extends LokaliseFileExchange {
  static defaultPollingParams = {
    pollStatuses: false,
    pollInitialWaitTime: 1e3,
    pollMaximumWaitTime: 12e4
  };
  /**
   * Collects files, uploads them to Lokalise, and optionally polls for process completion, returning both processes and errors.
   *
   * @param {UploadTranslationParams} uploadTranslationParams - Parameters for collecting and uploading files.
   * @returns {Promise<{ processes: QueuedProcess[]; errors: FileUploadError[] }>} A promise resolving with successful processes and upload errors.
   */
  async uploadTranslations({
    uploadFileParams,
    collectFileParams,
    processUploadFileParams
  } = {}) {
    this.logMsg("debug", "Uploading translations to Lokalise...");
    const { pollStatuses, pollInitialWaitTime, pollMaximumWaitTime } = {
      ..._LokaliseUpload.defaultPollingParams,
      ...processUploadFileParams
    };
    this.logMsg("debug", "Collecting files to upload...");
    const collectedFiles = await this.collectFiles(collectFileParams);
    this.logMsg("debug", "Collected files:", collectedFiles);
    this.logMsg("debug", "Performing parallel upload...");
    const { processes, errors } = await this.parallelUpload(
      collectedFiles,
      uploadFileParams,
      processUploadFileParams
    );
    let completedProcesses = processes;
    this.logMsg(
      "debug",
      "File uploading queued! IDs:",
      completedProcesses.map((p) => p.process_id)
    );
    if (pollStatuses) {
      this.logMsg("debug", "Polling queued processes...");
      completedProcesses = await this.pollProcesses(
        processes,
        pollInitialWaitTime,
        pollMaximumWaitTime
      );
      this.logMsg("debug", "Polling completed!");
    }
    this.logMsg("debug", "Upload successful!");
    return { processes: completedProcesses, errors };
  }
  /**
   * Collects files from the filesystem based on the given parameters.
   *
   * @param {CollectFileParams} collectFileParams - Parameters for file collection, including directories, extensions, and patterns.
   * @returns {Promise<string[]>} A promise resolving with the list of collected file paths.
   */
  async collectFiles({
    inputDirs = ["./locales"],
    extensions = [".*"],
    excludePatterns = [],
    recursive = true,
    fileNamePattern = ".*"
  } = {}) {
    const queue = this.makeQueue(inputDirs);
    const normalizedExtensions = this.normalizeExtensions(extensions);
    const fileNameRegex = this.makeFilenameRegexp(fileNamePattern);
    const excludeRegexes = this.makeExcludeRegExes(excludePatterns);
    const files = await this.processCollectionQueue(
      queue,
      normalizedExtensions,
      fileNameRegex,
      excludeRegexes,
      recursive
    );
    return files.sort();
  }
  /**
   * Uploads a single file to Lokalise.
   *
   * @param {UploadFileParams} uploadParams - Parameters for uploading the file.
   * @returns {Promise<QueuedProcess>} A promise resolving with the upload process details.
   */
  async uploadSingleFile(uploadParams) {
    return this.withExponentialBackoff(
      () => this.apiClient.files().upload(this.projectId, uploadParams)
    );
  }
  /**
   * Processes a file to prepare it for upload, converting it to base64 and extracting its language code.
   *
   * @param file - The absolute path to the file.
   * @param projectRoot - The root directory of the project.
   * @param processParams - Optional processing settings including inferers.
   * @returns A promise resolving with the processed file details, including base64 content, relative path, and language code.
   */
  async processFile(file, projectRoot, processParams) {
    const relativePath = await this.inferRelativePath(
      file,
      projectRoot,
      processParams
    );
    const languageCode = await this.inferLanguageCode(
      file,
      relativePath,
      processParams
    );
    const base64Content = await this.readFileAsBase64(file);
    return {
      data: base64Content,
      filename: relativePath,
      lang_iso: languageCode
    };
  }
  /**
   * Infers the relative path for an uploaded file.
   *
   * Tries a custom `filenameInferer` first; if it fails or returns empty/whitespace,
   * falls back to a POSIX-style relative path based on the project root.
   *
   * @param file - Absolute path to the source file.
   * @param projectRoot - Root directory of the project.
   * @param processParams - Optional processing settings including filename inferer.
   * @returns A promise resolving with the inferred relative path.
   */
  async inferRelativePath(file, projectRoot, processParams) {
    try {
      const fromInferer = processParams?.filenameInferer ? await processParams.filenameInferer(file) : "";
      if (!fromInferer.trim()) {
        throw new Error("Invalid filename: empty or only whitespace");
      }
      return fromInferer;
    } catch {
      return path2.posix.relative(
        this.toPosixPath(projectRoot),
        this.toPosixPath(file)
      );
    }
  }
  /**
   * Infers the language code for an uploaded file.
   *
   * Tries a custom `languageInferer` first; if it fails or returns empty/whitespace,
   * falls back to extracting the language code from the filename before the last extension.
   *
   * Example: "en.default.json" → "default"
   *
   * @param file - Absolute path to the source file.
   * @param relativePath - Effective relative path of the file (used for fallback parsing).
   * @param processParams - Optional processing settings including language inferer.
   * @returns A promise resolving with the inferred language code.
   */
  async inferLanguageCode(file, relativePath, processParams) {
    try {
      const fromInferer = processParams?.languageInferer ? await processParams.languageInferer(file) : "";
      if (!fromInferer.trim()) {
        throw new Error("Invalid language code: empty or only whitespace");
      }
      return fromInferer;
    } catch {
      const baseName = path2.basename(relativePath);
      return baseName.split(".").slice(-2, -1)[0] ?? "unknown";
    }
  }
  /**
   * Reads a file from disk and returns its content encoded as base64.
   *
   * @param file - Absolute path to the source file.
   * @returns A promise resolving with the file content encoded in base64.
   */
  async readFileAsBase64(file) {
    const fileContent = await fs2.promises.readFile(file);
    return fileContent.toString("base64");
  }
  /**
   * Uploads files in parallel with a limit on the number of concurrent uploads.
   *
   * @param {string[]} files - List of file paths to upload.
   * @param {Partial<UploadFileParams>} baseUploadFileParams - Base parameters for uploads.
   * @param {ProcessUploadFileParams} [processParams] - Optional processing settings including inferers.
   * @returns {Promise<{ processes: QueuedProcess[]; errors: FileUploadError[] }>} A promise resolving with successful processes and upload errors.
   */
  async parallelUpload(files, baseUploadFileParams = {}, processParams) {
    const projectRoot = process.cwd();
    const queuedProcesses = [];
    const errors = [];
    await this.runWithConcurrencyLimit(
      files,
      _LokaliseUpload.maxConcurrentProcesses,
      async (file) => {
        try {
          const processedFileParams = await this.processFile(
            file,
            projectRoot,
            processParams
          );
          const queued = await this.uploadSingleFile({
            ...baseUploadFileParams,
            ...processedFileParams
          });
          queuedProcesses.push(queued);
        } catch (error) {
          errors.push({ file, error });
        }
      }
    );
    return { processes: queuedProcesses, errors };
  }
  /**
   * Normalizes an array of file extensions by ensuring each starts with a dot and is lowercase.
   *
   * @param extensions - The list of file extensions to normalize.
   * @returns A new array with normalized file extensions.
   */
  normalizeExtensions(extensions) {
    return extensions.map(
      (ext) => (ext.startsWith(".") ? ext : `.${ext}`).toLowerCase()
    );
  }
  /**
   * Determines whether a file should be collected based on its extension and name pattern.
   *
   * @param entry - The directory entry to evaluate.
   * @param normalizedExtensions - List of allowed file extensions.
   * @param fileNameRegex - Regular expression to match valid filenames.
   * @returns `true` if the file matches both extension and name pattern, otherwise `false`.
   */
  shouldCollectFile(entry, normalizedExtensions, fileNameRegex) {
    const fileExt = path2.extname(entry.name).toLowerCase();
    const matchesExtension = normalizedExtensions.includes(".*") || normalizedExtensions.includes(fileExt);
    const matchesFilenamePattern = fileNameRegex.test(entry.name);
    return matchesExtension && matchesFilenamePattern;
  }
  /**
   * Creates a regular expression from a given pattern string or RegExp.
   *
   * @param fileNamePattern - The filename pattern to convert into a RegExp.
   * @returns A valid RegExp object.
   * @throws {Error} If the pattern string is invalid and cannot be compiled.
   */
  makeFilenameRegexp(fileNamePattern) {
    try {
      return new RegExp(fileNamePattern);
    } catch {
      throw new Error(`Invalid fileNamePattern: ${fileNamePattern}`);
    }
  }
  /**
   * Converts an array of exclude patterns into an array of RegExp objects.
   *
   * @param excludePatterns - An array of strings or regular expressions to exclude.
   * @returns An array of compiled RegExp objects.
   * @throws {Error} If any pattern is invalid and cannot be compiled.
   */
  makeExcludeRegExes(excludePatterns) {
    if (excludePatterns.length === 0) {
      return [];
    }
    try {
      return excludePatterns.map((pattern) => new RegExp(pattern));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Invalid excludePatterns: ${msg}`);
    }
  }
  /**
   * Safely reads the contents of a directory, returning an empty array if access fails.
   *
   * Logs a warning if the directory cannot be read (e.g. due to permissions or non-existence).
   *
   * @param dir - The directory path to read.
   * @returns A promise that resolves to an array of directory entries, or an empty array on failure.
   */
  async safeReadDir(dir) {
    try {
      return await fs2.promises.readdir(dir, { withFileTypes: true });
    } catch {
      this.logMsg("warn", `Skipping inaccessible directory: ${dir}...`);
      return [];
    }
  }
  /**
   * Checks if a file path matches any of the provided exclusion patterns.
   *
   * @param filePath - The path of the file to check.
   * @param excludeRegexes - An array of RegExp patterns to test against.
   * @returns `true` if the file path matches any exclude pattern, otherwise `false`.
   */
  shouldExclude(filePath, rx) {
    const posix = this.toPosixPath(filePath);
    return rx.some((r) => r.test(filePath) || r.test(posix));
  }
  /**
   * Creates a queue of absolute paths from the provided input directories.
   *
   * @param inputDirs - An array of input directory paths (relative or absolute).
   * @returns An array of resolved absolute directory paths.
   */
  makeQueue(inputDirs) {
    return [...inputDirs.map((dir) => path2.resolve(dir))];
  }
  /**
   * Processes a queue of directories to collect files matching given criteria.
   *
   * Recursively reads directories (if enabled), filters files by extension,
   * filename pattern, and exclusion rules, and collects matching file paths.
   *
   * @param queue - The list of directories to process.
   * @param exts - Allowed file extensions (normalized).
   * @param nameRx - Regular expression to match valid filenames.
   * @param excludeRx - Array of exclusion patterns.
   * @param recursive - Whether to traverse subdirectories.
   * @returns A promise that resolves to an array of matched file paths.
   */
  async processCollectionQueue(queue, exts, nameRx, excludeRx, recursive) {
    const found = [];
    while (queue.length) {
      const dir = queue.shift();
      if (!dir) {
        this.logMsg(
          "debug",
          `collectFiles: received falsy dir entry (${String(dir)}). This is unexpected and might indicate a bug.`
        );
        continue;
      }
      const entries = await this.safeReadDir(dir);
      for (const entry of entries) {
        const fullPath = path2.resolve(dir, entry.name);
        this.handleEntry(entry, fullPath, queue, found, {
          exts,
          nameRx,
          excludeRx,
          recursive
        });
      }
    }
    return found;
  }
  /**
   * Handles a single directory entry during file collection.
   *
   * Applies exclusion rules, optionally queues directories for recursion,
   * and collects files that match the specified extension and filename pattern.
   *
   * @param entry - The directory entry to handle.
   * @param fullPath - The absolute path to the entry.
   * @param queue - The processing queue for directories.
   * @param found - The list to store matched file paths.
   * @param opts - Options including extensions, name pattern, exclusions, and recursion flag.
   */
  handleEntry(entry, fullPath, queue, found, opts) {
    if (this.shouldExclude(fullPath, opts.excludeRx)) {
      return;
    }
    if (entry.isDirectory()) {
      if (opts.recursive) {
        queue.push(fullPath);
      }
      return;
    }
    if (entry.isFile() && this.shouldCollectFile(entry, opts.exts, opts.nameRx)) {
      found.push(fullPath);
    }
  }
  /**
   * Normalizes a filesystem path to POSIX format.
   *
   * Replaces platform-specific separators (e.g. `\` on Windows)
   * with POSIX-style `/` to ensure consistent path handling
   * across different operating systems.
   *
   * @param p - Original filesystem path.
   * @returns The same path but with POSIX separators.
   */
  toPosixPath(p) {
    return p.split(path2.sep).join(path2.posix.sep);
  }
};
export {
  LokaliseDownload,
  LokaliseError,
  LokaliseUpload
};
//# sourceMappingURL=index.js.map