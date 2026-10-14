import {
	ClientParams,
	DownloadBundle,
	DownloadFileParams,
	LokaliseApi,
	QueuedProcess,
	UploadFileParams,
} from "@lokalise/node-api";
import { LogFunction, LogLevel, LogThreshold } from "kliedz";

//#region lib/interfaces/LokaliseError.d.ts
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
//#endregion
//#region lib/errors/LokaliseError.d.ts
/**
 * Represents an error occurring during Lokalise operations.
 */
export declare class LokaliseError extends Error implements LokaliseError$1 {
	code?: number;
	details?: Record<string, string | number | boolean>;
	/**
	 * Creates a LokaliseError instance.
	 *
	 * @param message - Error description.
	 * @param code - Optional error code.
	 * @param details - Optional additional error information.
	 */
	constructor(
		message: string,
		code?: number,
		details?: Record<string, string | number | boolean>,
	);
	/**
	 * Returns the error message with optional code and details.
	 */
	toString(): string;
}
//#endregion
//#region lib/interfaces/CollectFileParams.d.ts
interface CollectFileParams {
	inputDirs?: string[];
	extensions?: string[];
	excludePatterns?: string[] | RegExp[];
	recursive?: boolean;
	fileNamePattern?: string | RegExp;
}
//#endregion
//#region lib/interfaces/ExtractParams.d.ts
interface ExtractParams {
	outputDir?: string;
}
//#endregion
//#region lib/interfaces/ProcessDownloadFileParams.d.ts
interface ProcessDownloadFileParams {
	asyncDownload?: boolean;
	pollInitialWaitTime?: number;
	pollMaximumWaitTime?: number;
	bundleDownloadTimeout?: number;
}
//#endregion
//#region lib/interfaces/DownloadTranslationParams.d.ts
interface DownloadTranslationParams {
	downloadFileParams: DownloadFileParams;
	extractParams?: ExtractParams;
	processDownloadFileParams?: ProcessDownloadFileParams;
}
//#endregion
//#region lib/interfaces/FileUploadError.d.ts
interface FileUploadError {
	file: string;
	error: unknown;
}
//#endregion
//#region lib/interfaces/LokaliseExchangeConfig.d.ts
interface LokaliseExchangeConfig {
	projectId: string;
	useOAuth2?: boolean;
	retryParams?: Partial<RetryParams>;
	logThreshold?: LogThreshold;
	logColor?: boolean;
}
//#endregion
//#region lib/interfaces/PartialUploadFileParams.d.ts
type UploadFileParamsBase = Omit<
	UploadFileParams,
	"data" | "filename" | "lang_iso"
>;
interface PartialUploadFileParams extends UploadFileParamsBase {}
//#endregion
//#region lib/interfaces/ProcessedFile.d.ts
interface ProcessedFile {
	data: string;
	filename: string;
	lang_iso: string;
}
//#endregion
//#region lib/interfaces/ProcessUploadFileParams.d.ts
type Inferer = (filePath: string) => Promise<string> | string;
interface ProcessUploadFileParams {
	languageInferer?: Inferer;
	filenameInferer?: Inferer;
	pollStatuses?: boolean;
	pollInitialWaitTime?: number;
	pollMaximumWaitTime?: number;
}
//#endregion
//#region lib/interfaces/QueuedUploadProcessesWithErrors.d.ts
interface QueuedUploadProcessesWithErrors {
	processes: QueuedProcess[];
	errors: FileUploadError[];
}
//#endregion
//#region lib/interfaces/RetryParams.d.ts
interface RetryParams {
	maxRetries: number;
	initialSleepTime: number;
	maxSleepTime: number;
	jitterRatio: number;
	rng: () => number;
}
//#endregion
//#region lib/interfaces/UploadTranslationParams.d.ts
interface UploadTranslationParams {
	uploadFileParams?: PartialUploadFileParams;
	collectFileParams?: CollectFileParams;
	processUploadFileParams?: ProcessUploadFileParams;
}
//#endregion
//#region lib/services/LokaliseFileExchange.d.ts
/**
 * A utility class for exchanging files with the Lokalise API.
 */
declare abstract class LokaliseFileExchange {
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
	protected readonly retryParams: Required<RetryParams>;
	/**
	 * Logger function.
	 */
	protected readonly logger: LogFunction;
	/**
	 * Log threshold (do not print messages with severity less than the specified value).
	 */
	protected readonly logThreshold: LogThreshold;
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
			useOAuth2,
			retryParams,
			logThreshold,
			logColor,
		}: LokaliseExchangeConfig,
	);
	/**
	 * Validates the project ID and retry configuration.
	 *
	 * @throws {LokaliseError} If any configuration value is invalid.
	 */
	private validateParams;
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
	 * Selects the logger implementation based on whether color output is enabled.
	 *
	 * @param logColor - If true, uses the colorized logger.
	 * @returns The chosen log function.
	 */
	private chooseLogger;
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
}
//#endregion
//#region lib/services/LokaliseDownload.d.ts
/**
 * Handles downloading and extracting translation files from Lokalise.
 */
export declare class LokaliseDownload extends LokaliseFileExchange {
	private static readonly defaultProcessParams;
	/**
	 * Downloads translations from Lokalise, optionally using async polling, and extracts them to disk.
	 *
	 * @param downloadTranslationParams - Full configuration for the download process, extraction destination, and optional polling or timeout settings.
	 * @throws {LokaliseError} If the download, polling, or extraction fails.
	 */
	downloadTranslations({
		downloadFileParams,
		extractParams,
		processDownloadFileParams,
	}: DownloadTranslationParams): Promise<void>;
	/**
	 * Retrieves translation bundle metadata from Lokalise
	 * with exponential-backoff retry support.
	 *
	 * @param downloadFileParams - Parameters for the Lokalise API request.
	 * @returns The translation bundle metadata.
	 * @throws {LokaliseError} If the API request fails.
	 */
	protected getTranslationsBundle(
		downloadFileParams: DownloadFileParams,
	): Promise<DownloadBundle>;
	/**
	 * Starts an asynchronous translation bundle download
	 * with exponential-backoff retry support.
	 *
	 * @param downloadFileParams - Parameters for the Lokalise API request.
	 * @returns The queued download process.
	 * @throws {LokaliseError} If the API request fails.
	 */
	protected getTranslationsBundleAsync(
		downloadFileParams: DownloadFileParams,
	): Promise<QueuedProcess>;
	/**
	 * Resolves download process parameters using default values
	 * for any missing options.
	 *
	 * @param overrides - Optional process configuration overrides.
	 * @returns Fully resolved process parameters.
	 */
	private buildProcessParams;
	/**
	 * Extracts the downloaded ZIP archive and removes
	 * the temporary archive afterward.
	 *
	 * Cleanup failures are logged without masking extraction errors.
	 *
	 * @param zipFilePath - Path to the temporary ZIP archive.
	 * @param unpackTo - Destination directory.
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
	 * Polls an asynchronous download process and returns
	 * its latest known state.
	 *
	 * @param downloadProcess - Initially queued download process.
	 * @param initialWait - Initial polling interval in milliseconds.
	 * @param maxWait - Maximum polling time in milliseconds.
	 * @returns The latest process state.
	 */
	protected pollAsyncDownload(
		downloadProcess: QueuedProcess,
		initialWait: number,
		maxWait: number,
	): Promise<QueuedProcess>;
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
	 * Resolves the bundle URL from a completed async process.
	 *
	 * Throws when the process failed, was cancelled,
	 * or did not finish within the polling time budget.
	 */
	private resolveAsyncBundleUrl;
	/**
	 * Queues an asynchronous translation bundle download,
	 * polls the process, and returns the generated bundle URL.
	 *
	 * @param downloadFileParams - Lokalise API download parameters.
	 * @param processParams - Resolved download process configuration.
	 * @returns Direct URL of the generated ZIP bundle.
	 */
	protected fetchBundleURLAsync(
		downloadFileParams: DownloadFileParams,
		processParams: Required<ProcessDownloadFileParams>,
	): Promise<string>;
}
//#endregion
//#region lib/services/LokaliseUpload.d.ts
/**
 * Handles uploading translation files to Lokalise.
 */
export declare class LokaliseUpload extends LokaliseFileExchange {
	private static readonly defaultPollingParams;
	/**
	 * Collects and uploads translation files to Lokalise.
	 * Optionally polls queued processes and returns their statuses
	 * along with any upload errors.
	 *
	 * @param params - File collection, upload, and processing options.
	 * @returns Queued processes and upload errors.
	 */
	uploadTranslations({
		uploadFileParams,
		collectFileParams,
		processUploadFileParams,
	}?: UploadTranslationParams): Promise<QueuedUploadProcessesWithErrors>;
	/**
	 * Uploads a single file to Lokalise with retry support.
	 *
	 * @param uploadParams - File upload parameters.
	 * @returns The queued upload process.
	 */
	protected uploadSingleFile(
		uploadParams: UploadFileParams,
	): Promise<QueuedProcess>;
	/**
	 * Uploads files concurrently while preserving input order
	 * in the resulting process and error arrays.
	 *
	 * Individual file failures do not stop other uploads.
	 */
	private parallelUpload;
	private pollUploadedProcesses;
	/**
	 * Resolves polling options and validates enabled polling settings.
	 *
	 * @param params - Optional polling configuration.
	 * @returns Polling configuration with all defaults applied.
	 */
	private resolvePollingParams;
	/**
	 * Logs upload results and, if polling was performed,
	 * summarizes the latest process statuses.
	 *
	 * @param processes - Queued processes with their latest states.
	 * @param errors - Errors encountered while uploading files.
	 * @param wasPolled - Whether process polling was performed.
	 */
	private logUploadSummary;
}
//#endregion
export type {
	CollectFileParams,
	DownloadTranslationParams,
	ExtractParams,
	FileUploadError,
	LokaliseExchangeConfig,
	PartialUploadFileParams,
	ProcessDownloadFileParams,
	ProcessedFile,
	ProcessUploadFileParams,
	QueuedUploadProcessesWithErrors,
	RetryParams,
	UploadTranslationParams,
};
//# sourceMappingURL=index.d.mts.map
