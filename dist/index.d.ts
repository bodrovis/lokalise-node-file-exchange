import { DownloadFileParams, UploadFileParams, QueuedProcess, LokaliseApi, ClientParams, DownloadBundle } from '@lokalise/node-api';
import { LogThreshold, LogFunction, LogLevel } from 'kliedz';

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
    code?: number;
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
    code?: number;
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
    private static readonly PENDING_STATUSES;
    private static readonly FINISHED_STATUSES;
    private static readonly RETRYABLE_CODES;
    /**
     * Creates a new instance of LokaliseFileExchange.
     *
     * @param clientConfig - Configuration for the Lokalise SDK.
     * @param exchangeConfig - The configuration object for file exchange operations.
     * @throws {LokaliseError} If the provided configuration is invalid.
     */
    constructor(clientConfig: ClientParams, { projectId, useOAuth2, retryParams, logThreshold, logColor, }: LokaliseExchangeConfig);
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
    protected withExponentialBackoff<T>(operation: () => Promise<T>): Promise<T>;
    /**
     * Polls the status of queued processes until they are marked as "finished" or until the maximum wait time is exceeded.
     *
     * @param {QueuedProcess[]} processes - The array of processes to poll.
     * @param {number} initialWaitTime - The initial wait time before polling in milliseconds.
     * @param {number} maxWaitTime - The maximum time to wait for processes in milliseconds.
     * @returns {Promise<QueuedProcess[]>} A promise resolving to the updated array of processes with their final statuses.
     */
    protected pollProcesses(processes: QueuedProcess[], initialWaitTime: number, maxWaitTime: number): Promise<QueuedProcess[]>;
    /**
     * Determines if a given error is eligible for retry.
     *
     * @param error - The error object returned from the Lokalise API.
     * @returns `true` if the error is retryable, otherwise `false`.
     */
    private isRetryable;
    /**
     * Logs a message with a specified level and the current threshold.
     *
     * @param level - Severity level of the message (e.g. "info", "error").
     * @param args - Values to log. Strings, objects, errors, etc.
     */
    protected logMsg(level: LogLevel, ...args: unknown[]): void;
    /**
     * Retrieves the latest state of a queued process from the API.
     *
     * @param processId - The ID of the queued process to fetch.
     * @returns A promise that resolves to the updated queued process.
     */
    protected getUpdatedProcess(processId: string): Promise<QueuedProcess>;
    /**
     * Validates the required client configuration parameters.
     *
     * Checks for a valid `projectId` and ensures that retry parameters
     * such as `maxRetries` and `initialSleepTime` meet the required conditions.
     *
     * @throws {LokaliseError} If `projectId` or `retryParams` is invalid.
     */
    private validateParams;
    /**
     * Pauses execution for the specified number of milliseconds.
     *
     * @param ms - The time to sleep in milliseconds.
     * @returns A promise that resolves after the specified time.
     */
    protected static sleep(ms: number): Promise<void>;
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
     * Downloads a ZIP file from the given URL.
     *
     * @param url - The URL of the ZIP file.
     * @returns The file path of the downloaded ZIP file.
     * @throws {LokaliseError} If the download fails or the response body is empty.
     */
    protected downloadZip(url: string, downloadTimeout?: number): Promise<string>;
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
    private handleZipEntry;
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
    private processZipEntryPath;
    /**
     * Parses and validates a URL string, ensuring it uses HTTP or HTTPS protocol.
     *
     * @param value - The URL string to validate.
     * @returns A parsed `URL` object if valid.
     * @throws {LokaliseError} If the URL is invalid or uses an unsupported protocol.
     */
    private assertHttpUrl;
}

/**
 * Handles uploading translation files to Lokalise.
 */
declare class LokaliseUpload extends LokaliseFileExchange {
    private static readonly maxConcurrentProcesses;
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
     * @param {string} file - The absolute path to the file.
     * @param {string} projectRoot - The root directory of the project.
     * @param {ProcessUploadFileParams} [processParams] - Optional processing settings including inferers.
     * @returns {Promise<ProcessedFile>} A promise resolving with the processed file details, including base64 content, relative path, and language code.
     */
    protected processFile(file: string, projectRoot: string, processParams?: ProcessUploadFileParams): Promise<ProcessedFile>;
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
}

export { type CollectFileParams, type DownloadTranslationParams, type ExtractParams, type FileUploadError, LokaliseDownload, LokaliseError, type LokaliseExchangeConfig, LokaliseUpload, type PartialUploadFileParams, type ProcessDownloadFileParams, type ProcessUploadFileParams, type ProcessedFile, type QueuedUploadProcessesWithErrors, type RetryParams, type UploadTranslationParams };
