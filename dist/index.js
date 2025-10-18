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
import { pipeline } from "stream";
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
    initialSleepTime: 1e3
  };
  static PENDING_STATUSES = [
    "queued",
    "pre_processing",
    "running",
    "post_processing"
  ];
  static FINISHED_STATUSES = [
    "finished",
    "cancelled",
    "failed"
  ];
  static RETRYABLE_CODES = [408, 429];
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
        ...lokaliseApiConfig
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
      ...retryParams
    };
    this.validateParams();
  }
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
  async withExponentialBackoff(operation) {
    const { maxRetries, initialSleepTime } = this.retryParams;
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
              `Maximum retries reached: ${error.message ?? "Unknown error"}`,
              error.code,
              error.details
            );
          }
          const backoff = initialSleepTime * 2 ** (attempt - 1);
          this.logMsg("debug", `Waiting ${backoff}ms before retry...`);
          await _LokaliseFileExchange.sleep(backoff);
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
   *
   * @param {QueuedProcess[]} processes - The array of processes to poll.
   * @param {number} initialWaitTime - The initial wait time before polling in milliseconds.
   * @param {number} maxWaitTime - The maximum time to wait for processes in milliseconds.
   * @returns {Promise<QueuedProcess[]>} A promise resolving to the updated array of processes with their final statuses.
   */
  async pollProcesses(processes, initialWaitTime, maxWaitTime) {
    this.logMsg(
      "debug",
      `Start polling processes. Total processes count: ${processes.length}`
    );
    const startTime = Date.now();
    let waitTime = initialWaitTime;
    const processMap = /* @__PURE__ */ new Map();
    const pendingProcessIds = /* @__PURE__ */ new Set();
    for (const process2 of processes) {
      if (!process2.status) {
        process2.status = "queued";
      }
      processMap.set(process2.process_id, process2);
      if (_LokaliseFileExchange.PENDING_STATUSES.includes(process2.status)) {
        pendingProcessIds.add(process2.process_id);
      }
    }
    while (pendingProcessIds.size > 0 && Date.now() - startTime < maxWaitTime) {
      this.logMsg("debug", `Polling... Pending IDs: ${pendingProcessIds.size}`);
      await Promise.all(
        [...pendingProcessIds].map(async (processId) => {
          try {
            const updatedProcess = await this.getUpdatedProcess(processId);
            processMap.set(processId, updatedProcess);
            if (_LokaliseFileExchange.FINISHED_STATUSES.includes(
              updatedProcess.status
            )) {
              this.logMsg("debug", `Process ${processId} completed.`);
              pendingProcessIds.delete(processId);
            }
          } catch (error) {
            this.logMsg("warn", `Failed to fetch process ${processId}:`, error);
          }
        })
      );
      if (pendingProcessIds.size === 0 || Date.now() - startTime >= maxWaitTime) {
        this.logMsg(
          "debug",
          `Finished polling. Pending processes IDs: ${pendingProcessIds.size}`
        );
        break;
      }
      this.logMsg("debug", `Waiting ${waitTime}...`);
      await _LokaliseFileExchange.sleep(waitTime);
      waitTime = Math.min(waitTime * 2, maxWaitTime - (Date.now() - startTime));
    }
    return Array.from(processMap.values());
  }
  /**
   * Determines if a given error is eligible for retry.
   *
   * @param error - The error object returned from the Lokalise API.
   * @returns `true` if the error is retryable, otherwise `false`.
   */
  isRetryable(error) {
    return _LokaliseFileExchange.RETRYABLE_CODES.includes(error.code);
  }
  /**
   * Logs a message with a specified level and the current threshold.
   *
   * @param level - Severity level of the message (e.g. "info", "error").
   * @param args - Values to log. Strings, objects, errors, etc.
   */
  logMsg(level, ...args) {
    this.logger(
      { level, threshold: this.logThreshold, withTimestamp: true },
      ...args
    );
  }
  /**
   * Retrieves the latest state of a queued process from the API.
   *
   * @param processId - The ID of the queued process to fetch.
   * @returns A promise that resolves to the updated queued process.
   */
  async getUpdatedProcess(processId) {
    const updatedProcess = await this.apiClient.queuedProcesses().get(processId, { project_id: this.projectId });
    if (!updatedProcess.status) {
      updatedProcess.status = "queued";
    }
    return updatedProcess;
  }
  /**
   * Validates the required client configuration parameters.
   *
   * Checks for a valid `projectId` and ensures that retry parameters
   * such as `maxRetries` and `initialSleepTime` meet the required conditions.
   *
   * @throws {LokaliseError} If `projectId` or `retryParams` is invalid.
   */
  validateParams() {
    if (!this.projectId || typeof this.projectId !== "string") {
      throw new LokaliseError("Invalid or missing Project ID.");
    }
    if (this.retryParams.maxRetries < 0) {
      throw new LokaliseError(
        "maxRetries must be greater than or equal to zero."
      );
    }
    if (this.retryParams.initialSleepTime <= 0) {
      throw new LokaliseError("initialSleepTime must be a positive value.");
    }
  }
  /**
   * Pauses execution for the specified number of milliseconds.
   *
   * @param ms - The time to sleep in milliseconds.
   * @returns A promise that resolves after the specified time.
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
    const {
      asyncDownload,
      pollInitialWaitTime,
      pollMaximumWaitTime,
      bundleDownloadTimeout
    } = {
      ..._LokaliseDownload.defaultProcessParams,
      ...processDownloadFileParams
    };
    let translationsBundleURL;
    if (asyncDownload) {
      this.logMsg("debug", "Async download mode enabled.");
      const downloadProcess = await this.getTranslationsBundleAsync(downloadFileParams);
      this.logMsg(
        "debug",
        `Waiting for download process ID ${downloadProcess.process_id} to complete...`
      );
      const completedProcess = (await this.pollProcesses(
        [downloadProcess],
        pollInitialWaitTime,
        pollMaximumWaitTime
      ))[0];
      this.logMsg(
        "debug",
        `Download process status is ${completedProcess.status}`
      );
      if (completedProcess.status === "finished") {
        const completedProcessDetails = completedProcess.details;
        translationsBundleURL = completedProcessDetails.download_url;
      } else {
        throw new LokaliseError(
          `Download process took too long to finalize; gave up after ${pollMaximumWaitTime}ms`,
          500
        );
      }
    } else {
      this.logMsg("debug", "Async download mode disabled.");
      const translationsBundle = await this.getTranslationsBundle(downloadFileParams);
      translationsBundleURL = translationsBundle.bundle_url;
    }
    this.logMsg(
      "debug",
      `Downloading translation bundle from ${translationsBundleURL}`
    );
    const zipFilePath = await this.downloadZip(
      translationsBundleURL,
      bundleDownloadTimeout
    );
    const unpackTo = path.resolve(extractParams.outputDir ?? "./");
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
        if (!zipfile) {
          return reject(
            new LokaliseError(`ZIP file is invalid or empty: ${zipFilePath}`)
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
   * Downloads a ZIP file from the given URL.
   *
   * @param url - The URL of the ZIP file.
   * @returns The file path of the downloaded ZIP file.
   * @throws {LokaliseError} If the download fails or the response body is empty.
   */
  async downloadZip(url, downloadTimeout = 0) {
    const bundleURL = this.assertHttpUrl(url);
    const uid = `${process.pid}-${Date.now()}-${crypto.randomBytes(8).toString("hex")}`;
    const tempZipPath = path.join(os.tmpdir(), `lokalise-${uid}.zip`);
    let response;
    const signal = downloadTimeout > 0 ? AbortSignal.timeout(downloadTimeout) : void 0;
    try {
      response = await fetch(bundleURL, {
        ...signal ? { signal } : {}
      });
    } catch (err) {
      if (err instanceof Error) {
        if (err.name === "TimeoutError") {
          throw new LokaliseError(
            `Request timed out after ${downloadTimeout}ms`,
            408,
            {
              reason: "timeout"
            }
          );
        }
        throw new LokaliseError(err.message, 500, {
          reason: "network or fetch error"
        });
      }
      throw new LokaliseError("An unknown error occurred", 500, {
        reason: String(err)
      });
    }
    if (!response.ok) {
      throw new LokaliseError(
        `Failed to download ZIP file: ${response.statusText} (${response.status})`
      );
    }
    const body = response.body;
    if (!body) {
      throw new LokaliseError(
        `Response body is null. Cannot download ZIP file from URL: ${url}`
      );
    }
    await this.streamPipeline(body, fs.createWriteStream(tempZipPath));
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
};

// lib/services/LokaliseUpload.ts
import fs2 from "fs";
import path2 from "path";
var LokaliseUpload = class _LokaliseUpload extends LokaliseFileExchange {
  static maxConcurrentProcesses = 6;
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
   * @param {string} file - The absolute path to the file.
   * @param {string} projectRoot - The root directory of the project.
   * @param {ProcessUploadFileParams} [processParams] - Optional processing settings including inferers.
   * @returns {Promise<ProcessedFile>} A promise resolving with the processed file details, including base64 content, relative path, and language code.
   */
  async processFile(file, projectRoot, processParams) {
    let relativePath;
    try {
      relativePath = processParams?.filenameInferer ? await processParams.filenameInferer(file) : "";
      if (!relativePath.trim()) {
        throw new Error("Invalid filename: empty or only whitespace");
      }
    } catch {
      const toPosixPath = (p) => p.split(path2.sep).join(path2.posix.sep);
      relativePath = path2.posix.relative(
        toPosixPath(projectRoot),
        toPosixPath(file)
      );
    }
    let languageCode;
    try {
      languageCode = processParams?.languageInferer ? await processParams.languageInferer(file) : "";
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
      lang_iso: languageCode
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
    const fileQueue = [...files];
    const pool = new Array(_LokaliseUpload.maxConcurrentProcesses).fill(null).map(
      () => (async () => {
        while (fileQueue.length > 0) {
          const file = fileQueue.shift();
          if (!file) {
            break;
          }
          try {
            const processedFileParams = await this.processFile(
              file,
              projectRoot,
              processParams
            );
            const queuedProcess = await this.uploadSingleFile({
              ...baseUploadFileParams,
              ...processedFileParams
            });
            queuedProcesses.push(queuedProcess);
          } catch (error) {
            errors.push({ file, error });
          }
        }
      })()
    );
    await Promise.all(pool);
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
      throw new Error(`Invalid excludePatterns: ${err}`);
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
  shouldExclude(filePath, excludeRegexes) {
    return excludeRegexes.some((regex) => regex.test(filePath));
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
};
export {
  LokaliseDownload,
  LokaliseError,
  LokaliseUpload
};
//# sourceMappingURL=index.js.map