import { DownloadFileParams, UploadFileParams, LokaliseApi, ClientParams, QueuedProcess, DownloadBundle } from '@lokalise/node-api';

interface CollectFileParams {
    inputDirs?: string[];
    extensions?: string[];
    excludePatterns?: string[];
    recursive?: boolean;
    fileNamePattern?: string;
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
}

interface ProcessUploadFileParams {
    languageInferer?: (filePath: string) => Promise<string> | string;
    filenameInferer?: (filePath: string) => Promise<string> | string;
    pollStatuses?: boolean;
    pollInitialWaitTime?: number;
    pollMaximumWaitTime?: number;
}

interface RetryParams {
    maxRetries: number;
    initialSleepTime: number;
}

type UploadFileParamsBase = Omit<UploadFileParams, "data" | "filename" | "lang_iso">;
interface PartialUploadFileParams extends UploadFileParamsBase {
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
    readonly apiClient: LokaliseApi;
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
    private static readonly defaultRetryParams;
    private readonly PENDING_STATUSES;
    private readonly FINISHED_STATUSES;
    /**
     * Creates a new instance of LokaliseFileExchange.
     *
     * @param clientConfig - Configuration for the Lokalise SDK.
     * @param exchangeConfig - The configuration object for file exchange operations.
     * @throws {LokaliseError} If the provided configuration is invalid.
     */
    constructor(clientConfig: ClientParams, exchangeConfig: LokaliseExchangeConfig);
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
     * Pauses execution for the specified number of milliseconds.
     *
     * @param ms - The time to sleep in milliseconds.
     * @returns A promise that resolves after the specified time.
     */
    protected sleep(ms: number): Promise<void>;
}

/**
 * Handles downloading and extracting translation files from Lokalise.
 */
declare class LokaliseDownload extends LokaliseFileExchange {
    private readonly streamPipeline;
    /**
     * Downloads translations from Lokalise, saving them to a ZIP file and extracting them.
     *
     * @param downloadTranslationParams - Configuration for download, extraction, and retries.
     * @throws {LokaliseError} If any step fails (e.g., download or extraction fails).
     */
    downloadTranslations(downloadTranslationParams: DownloadTranslationParams): Promise<void>;
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
    protected downloadZip(url: string, downloadTimeout: number | undefined): Promise<string>;
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
}

interface ProcessedFile {
    data: string;
    filename: string;
    lang_iso: string;
}

/**
 * Handles uploading translation files to Lokalise.
 */
declare class LokaliseUpload extends LokaliseFileExchange {
    private readonly maxConcurrentProcesses;
    /**
     * Collects files and uploads them to Lokalise, returning both processes and errors.
     *
     * @param {UploadTranslationParams} uploadTranslationParams - Parameters for collecting and uploading files.
     * @returns {Promise<{ processes: QueuedProcess[]; errors: FileUploadError[] }>} A promise resolving with successful processes and upload errors.
     */
    /**
     * Collects files, uploads them to Lokalise, and optionally polls for process completion, returning both processes and errors.
     *
     * @param {UploadTranslationParams} uploadTranslationParams - Parameters for collecting and uploading files.
     * @returns {Promise<{ processes: QueuedProcess[]; errors: FileUploadError[] }>} A promise resolving with successful processes and upload errors.
     */
    uploadTranslations(uploadTranslationParams?: UploadTranslationParams): Promise<{
        processes: QueuedProcess[];
        errors: FileUploadError[];
    }>;
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
     * @param {(filePath: string) => Promise<string> | string} [languageInferer] - Optional function to infer the language code from the file path. Can be asynchronous.
     * @returns {Promise<ProcessedFile>} A promise resolving with the processed file details, including base64 content, relative path, and language code.
     */
    protected processFile(file: string, projectRoot: string, languageInferer?: (filePath: string) => Promise<string> | string, filenameInferer?: (filePath: string) => Promise<string> | string): Promise<ProcessedFile>;
    /**
     * Uploads files in parallel with a limit on the number of concurrent uploads.
     *
     * @param {string[]} files - List of file paths to upload.
     * @param {Partial<UploadFileParams>} baseUploadFileParams - Base parameters for uploads.
     * @param {(filePath: string) => Promise<string> | string} [languageInferer] - Optional function to infer the language code from the file path. Can be asynchronous.
     * @returns {Promise<{ processes: QueuedProcess[]; errors: FileUploadError[] }>} A promise resolving with successful processes and upload errors.
     */
    private parallelUpload;
}

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
    details?: Record<string, string | number>;
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
    details?: Record<string, string | number>;
    /**
     * Creates a new instance of LokaliseError.
     *
     * @param message - The error message.
     * @param code - The error code (optional).
     * @param details - Optional additional details about the error.
     */
    constructor(message: string, code?: number, details?: Record<string, string | number>);
    /**
     * Returns a string representation of the error, including code and details.
     *
     * @returns The formatted error message.
     */
    toString(): string;
}

export { type CollectFileParams, type DownloadTranslationParams, type ExtractParams, type FileUploadError, LokaliseDownload, LokaliseError, type LokaliseExchangeConfig, LokaliseUpload, type PartialUploadFileParams, type ProcessDownloadFileParams, type ProcessUploadFileParams, type RetryParams, type UploadTranslationParams };
