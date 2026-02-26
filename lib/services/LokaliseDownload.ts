import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pipeline, Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { promisify } from "node:util";
import type {
	DownloadBundle,
	DownloadedFileProcessDetails,
	DownloadFileParams,
	QueuedProcess,
} from "@lokalise/node-api";
import yauzl from "yauzl";
import { LokaliseError } from "../errors/LokaliseError.js";
import type {
	DownloadTranslationParams,
	ProcessDownloadFileParams,
} from "../interfaces/index.js";
import { LokaliseFileExchange } from "./LokaliseFileExchange.js";

/**
 * Handles downloading and extracting translation files from Lokalise.
 */
export class LokaliseDownload extends LokaliseFileExchange {
	private static readonly defaultProcessParams: Required<ProcessDownloadFileParams> =
		{
			asyncDownload: false,
			pollInitialWaitTime: 1000,
			pollMaximumWaitTime: 120_000,
			bundleDownloadTimeout: 0,
		};

	private readonly streamPipeline = promisify(pipeline);

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
	}: DownloadTranslationParams): Promise<void> {
		this.logMsg("debug", "Downloading translations from Lokalise...");

		const processParams = this.buildProcessParams(processDownloadFileParams);

		const translationsBundleURL = await this.fetchTranslationBundleURL(
			downloadFileParams,
			processParams,
		);

		const zipFilePath = await this.downloadZip(
			translationsBundleURL,
			processParams.bundleDownloadTimeout,
		);

		await this.processZip(
			zipFilePath,
			path.resolve(extractParams.outputDir ?? "./"),
		);
	}

	/**
	 * Unpacks a ZIP file into the specified directory.
	 *
	 * @param zipFilePath - Path to the ZIP file.
	 * @param outputDir - Directory to extract the files into.
	 * @throws {LokaliseError} If extraction fails or malicious paths are detected.
	 */
	protected async unpackZip(
		zipFilePath: string,
		outputDir: string,
	): Promise<void> {
		return new Promise((resolve, reject) => {
			yauzl.open(zipFilePath, { lazyEntries: true }, (err, zipfile) => {
				if (err) {
					return reject(
						new LokaliseError(
							`Failed to open ZIP file at ${zipFilePath}: ${err.message}`,
						),
					);
				}

				zipfile.readEntry();

				zipfile.on("entry", (entry) => {
					this.handleZipEntry(entry, zipfile, outputDir)
						.then(() => zipfile.readEntry())
						.catch(reject);
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
	protected async downloadZip(
		url: string,
		downloadTimeout = 0,
	): Promise<string> {
		this.logMsg("debug", "Downloading translation bundle...");

		const bundleURL = this.assertHttpUrl(url);
		const tempZipPath = this.buildTempZipPath();

		const signal = this.buildAbortSignal(downloadTimeout);
		const response = await this.fetchZipResponse(
			bundleURL,
			signal,
			downloadTimeout,
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
	protected buildTempZipPath(): string {
		const uid =
			crypto.randomUUID?.() ??
			`${process.pid}-${Date.now()}-${crypto.randomBytes(8).toString("hex")}`;

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
	private buildAbortSignal(downloadTimeout: number): AbortSignal | undefined {
		if (downloadTimeout <= 0) {
			return undefined;
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
	protected async fetchZipResponse(
		bundleURL: URL,
		signal: AbortSignal | undefined,
		downloadTimeout: number,
	): Promise<Response> {
		try {
			return await fetch(bundleURL, signal ? { signal } : {});
		} catch (err) {
			if (err instanceof Error) {
				if (err.name === "TimeoutError") {
					throw new LokaliseError(
						`Request timed out after ${downloadTimeout}ms`,
						408,
						{ reason: "timeout" },
					);
				}

				throw new LokaliseError(err.message, 500, {
					reason: "network or fetch error",
				});
			}

			// This should never happen in production
			// as realistically fetch always raises Error,
			// unless some black magic has been involved.
			/* v8 ignore start */
			throw new LokaliseError(
				"An unknown error occurred. This might indicate a bug.",
				500,
				{
					reason: String(err),
				},
			);
			/* v8 ignore end */
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
	private getZipResponseBody(
		response: Response,
		originalUrl: string,
	): WebReadableStream<Uint8Array> {
		if (!response.ok) {
			throw new LokaliseError(
				`Failed to download ZIP file: ${response.statusText} (${response.status})`,
			);
		}

		const body = response.body as WebReadableStream<Uint8Array> | null;

		if (!body) {
			throw new LokaliseError(
				`Response body is null. Cannot download ZIP file from URL: ${originalUrl}`,
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
	private async writeZipToDisk(
		body: WebReadableStream<Uint8Array>,
		tempZipPath: string,
	): Promise<void> {
		try {
			const nodeReadable = Readable.fromWeb(body);
			await this.streamPipeline(
				nodeReadable,
				fs.createWriteStream(tempZipPath),
			);
		} catch (e) {
			try {
				await fs.promises.unlink(tempZipPath);
			} catch {
				this.logMsg(
					"debug",
					`Stream pipeline failed and unable to remove temp path ${tempZipPath}`,
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
	protected async getTranslationsBundle(
		downloadFileParams: DownloadFileParams,
	): Promise<DownloadBundle> {
		return this.withExponentialBackoff(() =>
			this.apiClient.files().download(this.projectId, downloadFileParams),
		);
	}

	/**
	 * Retrieves a translation bundle from Lokalise with retries and exponential backoff.
	 *
	 * @param downloadFileParams - Parameters for Lokalise API file download.
	 * @returns The queued process.
	 * @throws {LokaliseError} If retries are exhausted or an API error occurs.
	 */
	protected async getTranslationsBundleAsync(
		downloadFileParams: DownloadFileParams,
	): Promise<QueuedProcess> {
		return this.withExponentialBackoff(() =>
			this.apiClient.files().async_download(this.projectId, downloadFileParams),
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
	protected async handleZipEntry(
		entry: yauzl.Entry,
		zipfile: yauzl.ZipFile,
		outputDir: string,
	): Promise<void> {
		const fullPath = this.processZipEntryPath(outputDir, entry.fileName);

		if (entry.fileName.endsWith("/")) {
			// it's a directory
			await this.createDir(fullPath);
			return;
		}

		await this.createDir(path.dirname(fullPath));

		return new Promise((response, reject) => {
			zipfile.openReadStream(entry, (readErr, readStream) => {
				if (readErr || !readStream) {
					return reject(
						new LokaliseError(`Failed to read ZIP entry: ${entry.fileName}`),
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
	private async createDir(dir: string): Promise<void> {
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
	protected processZipEntryPath(
		outputDir: string,
		entryFilename: string,
	): string {
		// Validate paths to avoid path traversal issues
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
	private assertHttpUrl(value: string): URL {
		let parsed: URL;
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
	private buildProcessParams(
		overrides?: Partial<ProcessDownloadFileParams>,
	): Required<ProcessDownloadFileParams> {
		return {
			...LokaliseDownload.defaultProcessParams,
			...overrides,
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
	private async processZip(
		zipFilePath: string,
		unpackTo: string,
	): Promise<void> {
		this.logMsg(
			"debug",
			`Unpacking translations from ${zipFilePath} to ${unpackTo}`,
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
	private async fetchBundleURLSync(
		downloadFileParams: DownloadFileParams,
	): Promise<string> {
		this.logMsg("debug", "Async download mode disabled.");

		const translationsBundle =
			await this.getTranslationsBundle(downloadFileParams);
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
	protected async pollAsyncDownload(
		downloadProcess: QueuedProcess,
		initialWait: number,
		maxWait: number,
	): Promise<QueuedProcess> {
		this.logMsg(
			"debug",
			`Waiting for download process ID ${downloadProcess.process_id} to complete...`,
		);
		this.logMsg(
			"debug",
			`Effective waits: initial=${initialWait}ms, max=${maxWait}ms`,
		);

		const results = await this.pollProcesses(
			[downloadProcess],
			initialWait,
			maxWait,
		);

		const completedProcess = results.find(
			(p) => p.process_id === downloadProcess.process_id,
		);

		if (!completedProcess) {
			throw new LokaliseError(
				`Process ${downloadProcess.process_id} not found after polling`,
				500,
			);
		}

		if (!LokaliseFileExchange.isFinishedStatus(completedProcess.status)) {
			throw new LokaliseError(
				`Download process did not finish within ${maxWait}ms` +
					`${completedProcess.status ? ` (last status=${completedProcess.status})` : " (status missing)"}`,
				504,
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
	private fetchTranslationBundleURL(
		downloadFileParams: DownloadFileParams,
		processParams: Required<ProcessDownloadFileParams>,
	): Promise<string> {
		return processParams.asyncDownload
			? this.fetchBundleURLAsync(downloadFileParams, processParams)
			: this.fetchBundleURLSync(downloadFileParams);
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
	private handleFinishedAsyncProcess(completedProcess: QueuedProcess): string {
		const details = completedProcess.details as
			| (DownloadedFileProcessDetails & { download_url?: string })
			| undefined;

		const url = details?.download_url;
		if (!url || typeof url !== "string") {
			this.logMsg(
				"warn",
				"Process finished but details.download_url is missing or invalid",
				details,
			);
			throw new LokaliseError(
				"Lokalise returned finished process without a valid download_url",
				502,
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
	private handleFailedAsyncProcess(completedProcess: QueuedProcess): never {
		const msg = completedProcess.message?.trim();
		throw new LokaliseError(
			`Process ${completedProcess.process_id} ended with status=${completedProcess.status}` +
				(msg ? `: ${msg}` : ""),
			502,
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
	private handleUnexpectedAsyncProcess(
		completedProcess: QueuedProcess,
		maxWait: number,
	): never {
		this.logMsg("warn", `Process ended with status=${completedProcess.status}`);
		throw new LokaliseError(
			`Download process took too long to finalize; effective=${maxWait}ms`,
			500,
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
	protected async fetchBundleURLAsync(
		downloadFileParams: DownloadFileParams,
		processParams: Required<ProcessDownloadFileParams>,
	): Promise<string> {
		this.logMsg("debug", "Async download mode enabled.");

		const downloadProcess =
			await this.getTranslationsBundleAsync(downloadFileParams);

		const { pollInitialWaitTime, pollMaximumWaitTime } = processParams;

		const completedProcess = await this.pollAsyncDownload(
			downloadProcess,
			pollInitialWaitTime,
			pollMaximumWaitTime,
		);

		this.logMsg(
			"debug",
			`Download process status is ${completedProcess.status}`,
		);

		if (completedProcess.status === "finished") {
			return this.handleFinishedAsyncProcess(completedProcess);
		}

		if (
			completedProcess.status === "failed" ||
			completedProcess.status === "cancelled"
		) {
			this.handleFailedAsyncProcess(completedProcess);
		}

		this.handleUnexpectedAsyncProcess(completedProcess, pollMaximumWaitTime);
	}
}
