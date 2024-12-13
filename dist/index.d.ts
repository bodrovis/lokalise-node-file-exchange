import { DownloadFileParams, UploadFileParams, LokaliseApi, ClientParams, DownloadBundle, QueuedProcess } from '@lokalise/node-api';

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

interface DownloadTranslationParams {
    downloadFileParams: DownloadFileParams;
    extractParams?: ExtractParams;
}

interface FileUploadError {
    file: string;
    error: unknown;
}

interface LokaliseExchangeConfig {
    projectId: string;
    retryParams?: Partial<RetryParams>;
}

interface ProcessUploadFileParams {
    languageInferer?: (filePath: string) => Promise<string> | string;
}

interface RetryParams {
    maxRetries: number;
    initialSleepTime: number;
}

interface UploadTranslationParams {
    uploadFileParams?: UploadFileParams;
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
    /**
     * Creates a new instance of LokaliseFileExchange.
     *
     * @param {ClientParams} clientConfig - Configuration for the Lokalise SDK.
     * @param {LokaliseExchangeConfig} exchangeConfig - The configuration object for file exchange operations.
     * @throws {Error} If the provided configuration is invalid.
     */
    constructor(clientConfig: ClientParams, exchangeConfig: LokaliseExchangeConfig);
    /**
     * Executes an asynchronous operation with exponential backoff retry logic.
     *
     * Retries the provided operation in the event of specific retryable errors (e.g., 429 Too Many Requests,
     * 408 Request Timeout) using an exponential backoff strategy. If the maximum number of retries is exceeded,
     * it throws an error. Non-retryable errors are immediately propagated.
     *
     * @template T The type of the value returned by the operation.
     * @param {() => Promise<T>} operation - The asynchronous operation to execute.
     * @returns {Promise<T>} A promise that resolves to the result of the operation if successful.
     * @throws {LokaliseError} If the maximum number of retries is reached or a non-retryable error occurs.
     */
    protected withExponentialBackoff<T>(operation: () => Promise<T>): Promise<T>;
    /**
     * Pauses execution for the specified number of milliseconds.
     *
     * @param {number} ms - The time to sleep in milliseconds.
     * @returns {Promise<void>} A promise that resolves after the specified time.
     */
    protected sleep(ms: number): Promise<void>;
}

/**
 * Handles downloading and extracting translation files from Lokalise.
 */
declare class LokaliseDownload extends LokaliseFileExchange {
    private readonly streamPipeline;
    /**
     * Downloads translations from Lokalise, saving them to a ZIP file and then extracting them.
     *
     * @param {DownloadTranslationParams} downloadTranslationParams - Configuration for download, extraction, and retries.
     * @throws {LokaliseError} If any step fails (e.g., download or extraction fails).
     */
    downloadTranslations(downloadTranslationParams: DownloadTranslationParams): Promise<void>;
    /**
     * Unpacks a ZIP file into the specified directory.
     *
     * @param {string} zipFilePath - Path to the ZIP file.
     * @param {string} outputDir - Directory to extract the files into.
     * @throws {LokaliseError, Error} If extraction fails for any reason.
     */
    unpackZip(zipFilePath: string, outputDir: string): Promise<void>;
    /**
     * Downloads a ZIP file from the given URL.
     *
     * @param {string} url - The URL of the ZIP file.
     * @returns {Promise<string>} The file path of the downloaded ZIP file.
     * @throws {LokaliseError} If the download fails or the response body is empty.
     */
    downloadZip(url: string): Promise<string>;
    /**
     * Retrieves a translation bundle from Lokalise with retries and exponential backoff.
     *
     * @param {DownloadFileParams} downloadFileParams - Parameters for Lokalise API file download.
     * @returns {Promise<DownloadBundle>} The downloaded bundle metadata.
     * @throws {LokaliseError} If retries are exhausted or an API error occurs.
     */
    getTranslationsBundle(downloadFileParams: DownloadFileParams): Promise<DownloadBundle>;
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
    uploadTranslations(uploadTranslationParams: UploadTranslationParams): Promise<{
        processes: QueuedProcess[];
        errors: FileUploadError[];
    }>;
    /**
     * Collects files from the filesystem based on the given parameters.
     *
     * @param {CollectFileParams} collectFileParams - Parameters for file collection, including directories, extensions, and patterns.
     * @returns {Promise<string[]>} A promise resolving with the list of collected file paths.
     */
    collectFiles({ inputDirs, extensions, excludePatterns, recursive, fileNamePattern, }?: CollectFileParams): Promise<string[]>;
    /**
     * Uploads files in parallel with a limit on the number of concurrent uploads.
     *
     * @param {string[]} files - List of file paths to upload.
     * @param {Partial<UploadFileParams>} baseUploadFileParams - Base parameters for uploads.
     * @param {ProcessUploadFileParams} processUploadFileParams - Parameters for processing files before upload.
     * @returns {Promise<{ processes: QueuedProcess[]; errors: FileUploadError[] }>} A promise resolving with successful processes and upload errors.
     */
    parallelUpload(files: string[], baseUploadFileParams?: Partial<UploadFileParams>, processUploadFileParams?: ProcessUploadFileParams): Promise<{
        processes: QueuedProcess[];
        errors: FileUploadError[];
    }>;
    /**
     * Uploads a single file to Lokalise.
     *
     * @param {UploadFileParams} uploadParams - Parameters for uploading the file.
     * @returns {Promise<QueuedProcess>} A promise resolving with the upload process details.
     */
    uploadSingleFile(uploadParams: UploadFileParams): Promise<QueuedProcess>;
    /**
     * Processes a file to prepare it for upload, converting it to base64 and extracting its language code.
     *
     * @param {string} file - The absolute path to the file.
     * @param {string} projectRoot - The root directory of the project.
     * @param {(filePath: string) => Promise<string> | string} [languageInferer] - Optional function to infer the language code from the file path. Can be asynchronous.
     * @returns {Promise<ProcessedFile>} A promise resolving with the processed file details, including base64 content, relative path, and language code.
     */
    processFile(file: string, projectRoot: string, languageInferer?: (filePath: string) => Promise<string> | string): Promise<ProcessedFile>;
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
    details?: any;
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
    details?: Record<string, any>;
    /**
     * Creates a new instance of LokaliseError.
     *
     * @param message - The error message.
     * @param code - The error code (optional).
     * @param details - Optional additional details about the error.
     */
    constructor(message: string, code?: number, details?: Record<string, any>);
    /**
     * Returns a string representation of the error, including code and details.
     *
     * @returns The formatted error message.
     */
    toString(): string;
}

export { type CollectFileParams, type DownloadTranslationParams, type ExtractParams, type FileUploadError, LokaliseDownload, LokaliseError, type LokaliseExchangeConfig, LokaliseFileExchange, LokaliseUpload, type ProcessUploadFileParams, type RetryParams, type UploadTranslationParams };
