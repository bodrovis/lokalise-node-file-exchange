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
			const formattedDetails = Object.entries(this.details)
				.map(([key, value]) => `${key}: ${value}`)
				.join(", ");
			baseMessage += ` | Details: ${formattedDetails}`;
		}
		return baseMessage;
	}
};

// lib/services/LokaliseDownload.ts
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pipeline, Readable } from "node:stream";
import { promisify } from "node:util";
// lib/services/LokaliseFileExchange.ts
import {
	LokaliseApi,
	ApiError as LokaliseApiError,
	LokaliseApiOAuth,
} from "@lokalise/node-api";
import { logWithColor, logWithLevel } from "kliedz";
import yauzl from "yauzl";

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
		rng: Math.random,
	};
	static FINISHED_STATUSES = ["finished", "cancelled", "failed"];
	static RETRYABLE_CODES = [408, 429];
	static maxConcurrentProcesses = 6;
	static isPendingStatus(status) {
		return !_LokaliseFileExchange.isFinishedStatus(status);
	}
	static isFinishedStatus(status) {
		return (
			status != null && _LokaliseFileExchange.FINISHED_STATUSES.includes(status)
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
		clientConfig,
		{
			projectId,
			useOAuth2 = false,
			retryParams,
			logThreshold = "info",
			logColor = true,
		},
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
			..._LokaliseFileExchange.defaultRetryParams,
			...retryParams,
		};
		this.validateParams();
	}
	/**
	 * Executes an asynchronous operation with exponential backoff retry logic.
	 */
	async withExponentialBackoff(operation) {
		const { maxRetries, initialSleepTime, jitterRatio, rng } = this.retryParams;
		this.logMsg(
			"debug",
			`Running operation with exponential backoff; max retries: ${maxRetries}`,
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
	 * Polls the status of queued processes until they are marked as "finished" or until the maximum wait time is exceeded.
	 */
	async pollProcesses(
		processes,
		initialWaitTime,
		maxWaitTime,
		concurrency = _LokaliseFileExchange.maxConcurrentProcesses,
	) {
		this.logMsg(
			"debug",
			`Start polling processes. Total processes count: ${processes.length}`,
		);
		const startTime = Date.now();
		let waitTime = initialWaitTime;
		const processMap = /* @__PURE__ */ new Map();
		const pendingProcessIds = /* @__PURE__ */ new Set();
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
			if (_LokaliseFileExchange.isPendingStatus(p.status)) {
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
						`Process ${id} completed with status=${process2.status}.`,
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
			await _LokaliseFileExchange.sleep(sleepMs);
			waitTime = Math.min(
				waitTime * 2,
				Math.max(0, maxWaitTime - (Date.now() - startTime)),
			);
		}
		if (pendingProcessIds.size > 0) {
			this.logMsg(
				"debug",
				`Final refresh for ${pendingProcessIds.size} pending processes before return...`,
			);
			const finalBatch = await this.fetchProcessesBatch(
				[...pendingProcessIds],
				concurrency,
			);
			for (const { id, process: process2 } of finalBatch) {
				if (process2) processMap.set(id, process2);
			}
		}
		return Array.from(processMap.values());
	}
	/**
	 * Determines if a given error is eligible for retry.
	 */
	isRetryable(error) {
		return _LokaliseFileExchange.RETRYABLE_CODES.includes(error.code);
	}
	/**
	 * Logs a message with a specified level and the current threshold.
	 */
	logMsg(level, ...args) {
		this.logger(
			{ level, threshold: this.logThreshold, withTimestamp: true },
			...args,
		);
	}
	/**
	 * Retrieves the latest state of a queued process from the API.
	 */
	async getUpdatedProcess(processId) {
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
	 * Validates the required client configuration parameters.
	 */
	validateParams() {
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
	async runWithConcurrencyLimit(items, limit, worker) {
		const results = new Array(items.length);
		let i = 0;
		const workers = new Array(Math.min(limit, items.length))
			.fill(null)
			.map(async () => {
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
	async fetchProcessesBatch(
		processIds,
		concurrency = _LokaliseFileExchange.maxConcurrentProcesses,
	) {
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
	static sleep(ms) {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}
};

// lib/services/LokaliseDownload.ts
var LokaliseDownload = class _LokaliseDownload extends LokaliseFileExchange {
	static defaultProcessParams = {
		asyncDownload: false,
		pollInitialWaitTime: 1e3,
		pollMaximumWaitTime: 12e4,
		bundleDownloadTimeout: 0,
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
		processDownloadFileParams,
	}) {
		this.logMsg("debug", "Downloading translations from Lokalise...");
		const {
			asyncDownload,
			pollInitialWaitTime,
			pollMaximumWaitTime,
			bundleDownloadTimeout,
		} = {
			..._LokaliseDownload.defaultProcessParams,
			...processDownloadFileParams,
		};
		let translationsBundleURL;
		if (asyncDownload) {
			this.logMsg("debug", "Async download mode enabled.");
			const downloadProcess =
				await this.getTranslationsBundleAsync(downloadFileParams);
			this.logMsg(
				"debug",
				`Waiting for download process ID ${downloadProcess.process_id} to complete...`,
			);
			this.logMsg(
				"debug",
				`Effective waits: initial=${pollInitialWaitTime}ms, max=${pollMaximumWaitTime}ms`,
			);
			const results = await this.pollProcesses(
				[downloadProcess],
				pollInitialWaitTime,
				pollMaximumWaitTime,
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
					`Download process did not finish within ${pollMaximumWaitTime}ms${completedProcess.status ? ` (last status=${completedProcess.status})` : " (status missing)"}`,
					504,
				);
			}
			this.logMsg(
				"debug",
				`Download process status is ${completedProcess.status}`,
			);
			if (completedProcess.status === "finished") {
				const details = completedProcess.details;
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
				translationsBundleURL = url;
			} else if (
				completedProcess.status === "failed" ||
				completedProcess.status === "cancelled"
			) {
				const msg = completedProcess.message?.trim();
				throw new LokaliseError(
					`Process ${completedProcess.process_id} ended with status=${completedProcess.status}${msg ? `: ${msg}` : ""}`,
					502,
				);
			} else {
				this.logMsg(
					"warn",
					`Process ended with status=${completedProcess.status}`,
				);
				throw new LokaliseError(
					`Download process took too long to finalize; configured=${String(processDownloadFileParams?.pollMaximumWaitTime)} effective=${pollMaximumWaitTime}ms`,
					500,
				);
			}
		} else {
			this.logMsg("debug", "Async download mode disabled.");
			const translationsBundle =
				await this.getTranslationsBundle(downloadFileParams);
			translationsBundleURL = translationsBundle.bundle_url;
		}
		this.logMsg("debug", "Downloading translation bundle...");
		const zipFilePath = await this.downloadZip(
			translationsBundleURL,
			bundleDownloadTimeout,
		);
		const unpackTo = path.resolve(extractParams.outputDir ?? "./");
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
							`Failed to open ZIP file at ${zipFilePath}: ${err.message}`,
						),
					);
				}
				if (!zipfile) {
					return reject(
						new LokaliseError(`ZIP file is invalid or empty: ${zipFilePath}`),
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
	 * Downloads a ZIP file from the given URL.
	 *
	 * @param url - The URL of the ZIP file.
	 * @returns The file path of the downloaded ZIP file.
	 * @throws {LokaliseError} If the download fails or the response body is empty.
	 */
	async downloadZip(url, downloadTimeout = 0) {
		const bundleURL = this.assertHttpUrl(url);
		const uid =
			crypto.randomUUID?.() ??
			`${process.pid}-${Date.now()}-${crypto.randomBytes(8).toString("hex")}`;
		const tempZipPath = path.join(os.tmpdir(), `lokalise-${uid}.zip`);
		let response;
		const signal =
			downloadTimeout > 0 ? AbortSignal.timeout(downloadTimeout) : void 0;
		try {
			response = await fetch(bundleURL, {
				...(signal ? { signal } : {}),
			});
		} catch (err) {
			if (err instanceof Error) {
				if (err.name === "TimeoutError") {
					throw new LokaliseError(
						`Request timed out after ${downloadTimeout}ms`,
						408,
						{
							reason: "timeout",
						},
					);
				}
				throw new LokaliseError(err.message, 500, {
					reason: "network or fetch error",
				});
			}
			throw new LokaliseError("An unknown error occurred", 500, {
				reason: String(err),
			});
		}
		if (!response.ok) {
			throw new LokaliseError(
				`Failed to download ZIP file: ${response.statusText} (${response.status})`,
			);
		}
		const body = response.body;
		if (!body) {
			throw new LokaliseError(
				`Response body is null. Cannot download ZIP file from URL: ${url}`,
			);
		}
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
		return tempZipPath;
	}
	/**
	 * Retrieves a translation bundle from Lokalise with retries and exponential backoff.
	 *
	 * @param downloadFileParams - Parameters for Lokalise API file download.
	 * @returns The downloaded bundle metadata.
	 * @throws {LokaliseError} If retries are exhausted or an API error occurs.
	 */
	async getTranslationsBundle(downloadFileParams) {
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
	async getTranslationsBundleAsync(downloadFileParams) {
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
};

// lib/services/LokaliseUpload.ts
import fs2 from "node:fs";
import path2 from "node:path";

var LokaliseUpload = class _LokaliseUpload extends LokaliseFileExchange {
	static defaultPollingParams = {
		pollStatuses: false,
		pollInitialWaitTime: 1e3,
		pollMaximumWaitTime: 12e4,
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
		processUploadFileParams,
	} = {}) {
		this.logMsg("debug", "Uploading translations to Lokalise...");
		const { pollStatuses, pollInitialWaitTime, pollMaximumWaitTime } = {
			..._LokaliseUpload.defaultPollingParams,
			...processUploadFileParams,
		};
		this.logMsg("debug", "Collecting files to upload...");
		const collectedFiles = await this.collectFiles(collectFileParams);
		this.logMsg("debug", "Collected files:", collectedFiles);
		this.logMsg("debug", "Performing parallel upload...");
		const { processes, errors } = await this.parallelUpload(
			collectedFiles,
			uploadFileParams,
			processUploadFileParams,
		);
		let completedProcesses = processes;
		this.logMsg(
			"debug",
			"File uploading queued! IDs:",
			completedProcesses.map((p) => p.process_id),
		);
		if (pollStatuses) {
			this.logMsg("debug", "Polling queued processes...");
			completedProcesses = await this.pollProcesses(
				processes,
				pollInitialWaitTime,
				pollMaximumWaitTime,
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
		fileNamePattern = ".*",
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
			recursive,
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
		return this.withExponentialBackoff(() =>
			this.apiClient.files().upload(this.projectId, uploadParams),
		);
	}
	/**
	 * Processes a file to prepare it for upload, converting it to base64 and extracting its language code.
	 *
	 * @param {string} file - The absolute path to the file.
	 * @param {string} projectRoot - The root directory of the project.
	 * @param {ProcessUploadFileParams} [processParams] - Optional processing settings including inferers.
	 * @returns {Promise<ProcessedFile>} A promise resolving with the processed file details, including base64 content, relative path, and language code.
	 */
	async processFile(file, projectRoot, processParams) {
		let relativePath;
		try {
			relativePath = processParams?.filenameInferer
				? await processParams.filenameInferer(file)
				: "";
			if (!relativePath.trim()) {
				throw new Error("Invalid filename: empty or only whitespace");
			}
		} catch {
			relativePath = path2.posix.relative(
				this.toPosixPath(projectRoot),
				this.toPosixPath(file),
			);
		}
		let languageCode;
		try {
			languageCode = processParams?.languageInferer
				? await processParams.languageInferer(file)
				: "";
			if (!languageCode.trim()) {
				throw new Error("Invalid language code: empty or only whitespace");
			}
		} catch {
			const baseName = path2.basename(relativePath);
			languageCode = baseName.split(".").slice(-2, -1)[0] ?? "unknown";
		}
		const fileContent = await fs2.promises.readFile(file);
		return {
			data: fileContent.toString("base64"),
			filename: relativePath,
			lang_iso: languageCode,
		};
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
						processParams,
					);
					const queued = await this.uploadSingleFile({
						...baseUploadFileParams,
						...processedFileParams,
					});
					queuedProcesses.push(queued);
				} catch (error) {
					errors.push({ file, error });
				}
			},
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
		return extensions.map((ext) =>
			(ext.startsWith(".") ? ext : `.${ext}`).toLowerCase(),
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
		const matchesExtension =
			normalizedExtensions.includes(".*") ||
			normalizedExtensions.includes(fileExt);
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
				continue;
			}
			const entries = await this.safeReadDir(dir);
			for (const entry of entries) {
				const fullPath = path2.resolve(dir, entry.name);
				this.handleEntry(entry, fullPath, queue, found, {
					exts,
					nameRx,
					excludeRx,
					recursive,
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
		if (
			entry.isFile() &&
			this.shouldCollectFile(entry, opts.exts, opts.nameRx)
		) {
			found.push(fullPath);
		}
	}
	toPosixPath(p) {
		return p.split(path2.sep).join(path2.posix.sep);
	}
};
export { LokaliseDownload, LokaliseError, LokaliseUpload };
//# sourceMappingURL=index.js.map
