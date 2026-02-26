import { DownloadFileParams, UploadFileParams, QueuedProcess, LokaliseApi, ClientParams, DownloadBundle } from '@lokalise/node-api';
import { LogThreshold, LogFunction, LogLevel } from 'kliedz';
import yauzl from 'yauzl';

/**
 * Describes the structure of a Lokalise error.
 */
interface LokaliseError$1 {
    /**
     * The error message.
     */
    message: string;
    /**
     * The error code representing the type of Lokalise API error.
     */
    code?: number | undefined;
    /**
     * Additional details about the error (optional).
     */
    details?: Record<string, string | number | boolean>;
}

/**
 * Represents a custom error.
 */
declare class LokaliseError extends Error implements LokaliseError$1 {
    /**
     * The error code representing the type of Lokalise API error.
     */
    code?: number | undefined;
    /**
     * Additional details about the error.
     */
    details?: Record<string, string | number | boolean>;
    /**
     * Creates a new instance of LokaliseError.
     *
     * @param message - The error message.
     * @param code - The error code (optional).
     * @param details - Optional additional details about the error.
     */
    constructor(message: string, code?: number, details?: Record<string, string | number | boolean>);
    /**
     * Returns a string representation of the error, including code and details.
     *
     * @returns The formatted error message.
     */
    toString(): string;
}

interface CollectFileParams {
    inputDirs?: string[];
    extensions?: string[];
    excludePatterns?: string[] | RegExp[];
    recursive?: boolean;
    fileNamePattern?: string | RegExp;
}

interface ExtractParams {
    outputDir?: string;
}

interface ProcessDownloadFileParams {
    asyncDownload?: boolean;
    pollInitialWaitTime?: number;
    pollMaximumWaitTime?: number;
    bundleDownloadTimeout?: number;
}

interface DownloadTranslationParams {
    downloadFileParams: DownloadFileParams;
    extractParams?: ExtractParams;
    processDownloadFileParams?: ProcessDownloadFileParams;
}

interface FileUploadError {
    file: string;
    error: unknown;
}

interface LokaliseExchangeConfig {
    projectId: string;
    useOAuth2?: boolean;
    retryParams?: Partial<RetryParams>;
    logThreshold?: LogThreshold;
    logColor?: boolean;
}

type UploadFileParamsBase = Omit<UploadFileParams, "data" | "filename" | "lang_iso">;
interface PartialUploadFileParams extends UploadFileParamsBase {
}

interface ProcessedFile {
    data: string;
    filename: string;
    lang_iso: string;
}

type Inferer = (filePath: string) => Promise<string> | string;
interface ProcessUploadFileParams {
    languageInferer?: Inferer;
    filenameInferer?: Inferer;
    pollStatuses?: boolean;
    pollInitialWaitTime?: number;
    pollMaximumWaitTime?: number;
}

interface QueuedUploadProcessesWithErrors {
    processes: QueuedProcess[];
    errors: FileUploadError[];
}

interface RetryParams {
    maxRetries: number;
    initialSleepTime: number;
    jitterRatio: number;
    rng: () => number;
}

interface UploadTranslationParams {
    uploadFileParams?: PartialUploadFileParams;
    collectFileParams?: CollectFileParams;
    processUploadFileParams?: ProcessUploadFileParams;
}

/**
 * A utility class for exchanging files with the Lokalise API.
 */
declare class LokaliseFileExchange {
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
    private static readonly defaultRetryParams;
    private static readonly FINISHED_STATUSES;
    private static readonly RETRYABLE_CODES;
    protected static readonly maxConcurrentProcesses = 6;
    private static isPendingStatus;
    static isFinishedStatus(status?: string | null): boolean;
    /**
     * Creates a new instance of LokaliseFileExchange.
     *
     * @param clientConfig - Configuration for the Lokalise SDK.
     * @param exchangeConfig - The configuration object for file exchange operations.
     * @throws {LokaliseError} If the provided configuration is invalid.
     */
    constructor(clientConfig: ClientParams, { projectId, useOAuth2, retryParams, logThreshold, logColor, }: LokaliseExchangeConfig);
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
    protected withExponentialBackoff<T>(operation: () => Promise<T>): Promise<T>;
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
    protected pollProcesses(processes: QueuedProcess[], initialWaitTime: number, maxWaitTime: number, concurrency?: number): Promise<QueuedProcess[]>;
    /**
     * Builds internal tracking structures for polling: a map of process IDs
     * to their last known state and a set of IDs that are still pending.
     *
     * Also logs the initial status of each process.
     *
     * @param processes - Initial list of queued processes.
     * @returns A map of processes keyed by ID and a set of pending process IDs.
     */
    private initializePollingState;
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
    private runPollingLoop;
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
    private refreshRemainingProcesses;
    /**
     * Determines whether the given Lokalise API error should trigger a retry attempt.
     *
     * An error is considered retryable if its `code` matches one of the predefined
     * retryable status codes.
     *
     * @param error - The `LokaliseApiError` instance to evaluate.
     * @returns `true` if the error is retryable, otherwise `false`.
     */
    private isRetryable;
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
    protected logMsg(level: LogLevel, ...args: unknown[]): void;
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
    protected getUpdatedProcess(processId: string): Promise<QueuedProcess>;
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
    private validateParams;
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
    protected runWithConcurrencyLimit<T, R>(items: T[], limit: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]>;
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
    protected fetchProcessesBatch(processIds: string[], concurrency?: number): Promise<Array<{
        id: string;
        process?: QueuedProcess;
    }>>;
    /**
     * Delays execution for a given duration.
     *
     * Creates a Promise that resolves after the specified number of milliseconds,
     * allowing async workflows to pause without blocking the event loop.
     *
     * @param ms - Number of milliseconds to wait.
     * @returns A promise that resolves after the delay.
     */
    protected static sleep(ms: number): Promise<void>;
    /**
     * Computes the exponential-backoff delay for a retry attempt,
     * optionally adding jitter to avoid synchronized retries.
     *
     * @param retryParams - Backoff settings (initial delay, jitter, RNG).
     * @param attempt - Retry attempt number (1-based).
     * @returns Calculated sleep time in milliseconds.
     */
    protected calculateSleepMs(retryParams: RetryParams, attempt: number): number;
    /**
     * Builds the final Lokalise client configuration,
     * enabling silent mode when the log threshold is `"silent"`.
     *
     * @param clientConfig - Base client parameters.
     * @param logThreshold - Active logging threshold.
     * @returns The adjusted client configuration.
     */
    private buildLokaliseClientConfig;
    /**
     * Creates the appropriate Lokalise API client instance,
     * choosing between OAuth2 and token-based authentication.
     *
     * @param lokaliseApiConfig - Configuration passed to the client.
     * @param useOAuth2 - Whether OAuth2 authentication should be used.
     * @returns A Lokalise API client instance.
     */
    private createApiClient;
    /**
     * Merges user-provided retry settings with default retry parameters.
     *
     * @param retryParams - Optional overrides.
     * @returns Fully resolved retry configuration.
     */
    private buildRetryParams;
    /**
     * Selects the logger implementation based on whether color output is enabled.
     *
     * @param logColor - If true, uses the colorized logger.
     * @returns The chosen log function.
     */
    private chooseLogger;
}

/**
 * Handles downloading and extracting translation files from Lokalise.
 */
declare class LokaliseDownload extends LokaliseFileExchange {
    private static readonly defaultProcessParams;
    private readonly streamPipeline;
    /**
     * Downloads translations from Lokalise, optionally using async polling, and extracts them to disk.
     *
     * @param downloadTranslationParams - Full configuration for the download process, extraction destination, and optional polling or timeout settings.
     * @throws {LokaliseError} If the download, polling, or extraction fails.
     */
    downloadTranslations({ downloadFileParams, extractParams, processDownloadFileParams, }: DownloadTranslationParams): Promise<void>;
    /**
     * Unpacks a ZIP file into the specified directory.
     *
     * @param zipFilePath - Path to the ZIP file.
     * @param outputDir - Directory to extract the files into.
     * @throws {LokaliseError} If extraction fails or malicious paths are detected.
     */
    protected unpackZip(zipFilePath: string, outputDir: string): Promise<void>;
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
    protected downloadZip(url: string, downloadTimeout?: number): Promise<string>;
    /**
     * Builds a unique temporary file path for storing the downloaded ZIP bundle.
     *
     * Uses a UUID when available or falls back to a combination of PID, timestamp, and random bytes.
     *
     * @returns A full path to a temporary ZIP file in the OS temp directory.
     */
    protected buildTempZipPath(): string;
    /**
     * Creates an optional AbortSignal for enforcing request timeouts.
     *
     * Returns `undefined` when no timeout is configured, disabling abort handling.
     *
     * @param downloadTimeout - Timeout in milliseconds. `0` or negative disables the signal.
     * @returns An AbortSignal if timeout is enabled, otherwise `undefined`.
     */
    private buildAbortSignal;
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
    protected fetchZipResponse(bundleURL: URL, signal: AbortSignal | undefined, downloadTimeout: number): Promise<Response>;
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
    private getZipResponseBody;
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
    private writeZipToDisk;
    /**
     * Retrieves a translation bundle from Lokalise with retries and exponential backoff.
     *
     * @param downloadFileParams - Parameters for Lokalise API file download.
     * @returns The downloaded bundle metadata.
     * @throws {LokaliseError} If retries are exhausted or an API error occurs.
     */
    protected getTranslationsBundle(downloadFileParams: DownloadFileParams): Promise<DownloadBundle>;
    /**
     * Retrieves a translation bundle from Lokalise with retries and exponential backoff.
     *
     * @param downloadFileParams - Parameters for Lokalise API file download.
     * @returns The queued process.
     * @throws {LokaliseError} If retries are exhausted or an API error occurs.
     */
    protected getTranslationsBundleAsync(downloadFileParams: DownloadFileParams): Promise<QueuedProcess>;
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
    protected handleZipEntry(entry: yauzl.Entry, zipfile: yauzl.ZipFile, outputDir: string): Promise<void>;
    /**
     * Creates a directory and all necessary parent directories.
     *
     * @param dir - The directory path to create.
     * @returns A promise that resolves when the directory is created.
     */
    private createDir;
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
    protected processZipEntryPath(outputDir: string, entryFilename: string): string;
    /**
     * Parses and validates a URL string, ensuring it uses HTTP or HTTPS protocol.
     *
     * @param value - The URL string to validate.
     * @returns A parsed `URL` object if valid.
     * @throws {LokaliseError} If the URL is invalid or uses an unsupported protocol.
     */
    private assertHttpUrl;
    /**
     * Builds effective process parameters for the download workflow.
     *
     * Merges caller-provided overrides with the default settings.
     *
     * @param overrides - Partial process configuration to override defaults.
     * @returns Fully resolved process parameters.
     */
    private buildProcessParams;
    /**
     * Unpacks the downloaded ZIP archive into the target directory and
     * removes the temporary archive file afterwards.
     *
     * Logs progress and always attempts to delete the temporary file.
     *
     * @param zipFilePath - Path to the temporary ZIP file.
     * @param unpackTo - Destination directory for extracted files.
     */
    private processZip;
    /**
     * Fetches the direct bundle URL in synchronous (non-async) mode.
     *
     * Calls the standard download endpoint without polling.
     *
     * @param downloadFileParams - Parameters for Lokalise API file download.
     * @returns Direct bundle URL returned by Lokalise.
     */
    private fetchBundleURLSync;
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
    protected pollAsyncDownload(downloadProcess: QueuedProcess, initialWait: number, maxWait: number): Promise<QueuedProcess>;
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
    private fetchTranslationBundleURL;
    /**
     * Extracts and verifies the download URL from a finished async process.
     *
     * Ensures `details.download_url` is present and is a string.
     *
     * @param completedProcess - Process object with status `finished`.
     * @returns Valid download URL string.
     * @throws {LokaliseError} If the URL is missing or invalid.
     */
    private handleFinishedAsyncProcess;
    /**
     * Handles a failed or cancelled async process by throwing an error with context.
     *
     * Includes the process status and optional message from Lokalise.
     *
     * @param completedProcess - Process object with status `failed` or `cancelled`.
     * @throws {LokaliseError} Always throws, as the process did not succeed.
     */
    private handleFailedAsyncProcess;
    /**
     * Handles an unexpected async process outcome when it did not finish in time.
     *
     * Logs a warning and throws an error indicating that finalization took too long.
     *
     * @param completedProcess - Process object with unexpected status.
     * @param maxWait - Effective maximum wait time used during polling.
     * @throws {LokaliseError} Always throws to signal an unexpected async outcome.
     */
    private handleUnexpectedAsyncProcess;
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
    protected fetchBundleURLAsync(downloadFileParams: DownloadFileParams, processParams: Required<ProcessDownloadFileParams>): Promise<string>;
}

/**
 * Handles uploading translation files to Lokalise.
 */
declare class LokaliseUpload extends LokaliseFileExchange {
    private static readonly defaultPollingParams;
    /**
     * Collects files, uploads them to Lokalise, and optionally polls for process completion, returning both processes and errors.
     *
     * @param {UploadTranslationParams} uploadTranslationParams - Parameters for collecting and uploading files.
     * @returns {Promise<{ processes: QueuedProcess[]; errors: FileUploadError[] }>} A promise resolving with successful processes and upload errors.
     */
    uploadTranslations({ uploadFileParams, collectFileParams, processUploadFileParams, }?: UploadTranslationParams): Promise<QueuedUploadProcessesWithErrors>;
    /**
     * Collects files from the filesystem based on the given parameters.
     *
     * @param {CollectFileParams} collectFileParams - Parameters for file collection, including directories, extensions, and patterns.
     * @returns {Promise<string[]>} A promise resolving with the list of collected file paths.
     */
    protected collectFiles({ inputDirs, extensions, excludePatterns, recursive, fileNamePattern, }?: CollectFileParams): Promise<string[]>;
    /**
     * Uploads a single file to Lokalise.
     *
     * @param {UploadFileParams} uploadParams - Parameters for uploading the file.
     * @returns {Promise<QueuedProcess>} A promise resolving with the upload process details.
     */
    protected uploadSingleFile(uploadParams: UploadFileParams): Promise<QueuedProcess>;
    /**
     * Processes a file to prepare it for upload, converting it to base64 and extracting its language code.
     *
     * @param file - The absolute path to the file.
     * @param projectRoot - The root directory of the project.
     * @param processParams - Optional processing settings including inferers.
     * @returns A promise resolving with the processed file details, including base64 content, relative path, and language code.
     */
    protected processFile(file: string, projectRoot: string, processParams?: ProcessUploadFileParams): Promise<ProcessedFile>;
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
    private inferRelativePath;
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
    private inferLanguageCode;
    /**
     * Reads a file from disk and returns its content encoded as base64.
     *
     * @param file - Absolute path to the source file.
     * @returns A promise resolving with the file content encoded in base64.
     */
    private readFileAsBase64;
    /**
     * Uploads files in parallel with a limit on the number of concurrent uploads.
     *
     * @param {string[]} files - List of file paths to upload.
     * @param {Partial<UploadFileParams>} baseUploadFileParams - Base parameters for uploads.
     * @param {ProcessUploadFileParams} [processParams] - Optional processing settings including inferers.
     * @returns {Promise<{ processes: QueuedProcess[]; errors: FileUploadError[] }>} A promise resolving with successful processes and upload errors.
     */
    private parallelUpload;
    /**
     * Normalizes an array of file extensions by ensuring each starts with a dot and is lowercase.
     *
     * @param extensions - The list of file extensions to normalize.
     * @returns A new array with normalized file extensions.
     */
    private normalizeExtensions;
    /**
     * Determines whether a file should be collected based on its extension and name pattern.
     *
     * @param entry - The directory entry to evaluate.
     * @param normalizedExtensions - List of allowed file extensions.
     * @param fileNameRegex - Regular expression to match valid filenames.
     * @returns `true` if the file matches both extension and name pattern, otherwise `false`.
     */
    private shouldCollectFile;
    /**
     * Creates a regular expression from a given pattern string or RegExp.
     *
     * @param fileNamePattern - The filename pattern to convert into a RegExp.
     * @returns A valid RegExp object.
     * @throws {Error} If the pattern string is invalid and cannot be compiled.
     */
    private makeFilenameRegexp;
    /**
     * Converts an array of exclude patterns into an array of RegExp objects.
     *
     * @param excludePatterns - An array of strings or regular expressions to exclude.
     * @returns An array of compiled RegExp objects.
     * @throws {Error} If any pattern is invalid and cannot be compiled.
     */
    private makeExcludeRegExes;
    /**
     * Safely reads the contents of a directory, returning an empty array if access fails.
     *
     * Logs a warning if the directory cannot be read (e.g. due to permissions or non-existence).
     *
     * @param dir - The directory path to read.
     * @returns A promise that resolves to an array of directory entries, or an empty array on failure.
     */
    private safeReadDir;
    /**
     * Checks if a file path matches any of the provided exclusion patterns.
     *
     * @param filePath - The path of the file to check.
     * @param excludeRegexes - An array of RegExp patterns to test against.
     * @returns `true` if the file path matches any exclude pattern, otherwise `false`.
     */
    private shouldExclude;
    /**
     * Creates a queue of absolute paths from the provided input directories.
     *
     * @param inputDirs - An array of input directory paths (relative or absolute).
     * @returns An array of resolved absolute directory paths.
     */
    private makeQueue;
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
    private processCollectionQueue;
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
    private handleEntry;
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
    private toPosixPath;
}

export { type CollectFileParams, type DownloadTranslationParams, type ExtractParams, type FileUploadError, LokaliseDownload, LokaliseError, type LokaliseExchangeConfig, LokaliseUpload, type PartialUploadFileParams, type ProcessDownloadFileParams, type ProcessUploadFileParams, type ProcessedFile, type QueuedUploadProcessesWithErrors, type RetryParams, type UploadTranslationParams };
