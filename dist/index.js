// lib/services/LokaliseDownload.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream";
import { promisify } from "node:util";
import yauzl from "yauzl";

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
    this.details = details;
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

// lib/services/LokaliseFileExchange.ts
import {
  LokaliseApi,
  ApiError as LokaliseApiError,
  LokaliseApiOAuth
} from "@lokalise/node-api";
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
   * Default retry parameters for API requests.
   */
  static defaultRetryParams = {
    maxRetries: 3,
    initialSleepTime: 1e3
  };
  PENDING_STATUSES = [
    "queued",
    "pre_processing",
    "running",
    "post_processing"
  ];
  FINISHED_STATUSES = ["finished", "cancelled", "failed"];
  RETRYABLE_CODES = [408, 429];
  /**
   * Creates a new instance of LokaliseFileExchange.
   *
   * @param clientConfig - Configuration for the Lokalise SDK.
   * @param exchangeConfig - The configuration object for file exchange operations.
   * @throws {LokaliseError} If the provided configuration is invalid.
   */
  constructor(clientConfig, { projectId, useOAuth2 = false, retryParams }) {
    if (!clientConfig.apiKey || typeof clientConfig.apiKey !== "string") {
      throw new LokaliseError("Invalid or missing API token.");
    }
    if (useOAuth2) {
      this.apiClient = new LokaliseApiOAuth(clientConfig);
    } else {
      this.apiClient = new LokaliseApi(clientConfig);
    }
    if (!projectId || typeof projectId !== "string") {
      throw new LokaliseError("Invalid or missing Project ID.");
    }
    this.projectId = projectId;
    this.retryParams = {
      ..._LokaliseFileExchange.defaultRetryParams,
      ...retryParams
    };
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
    for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
      try {
        return await operation();
      } catch (error) {
        if (error instanceof LokaliseApiError && this.RETRYABLE_CODES.includes(error.code)) {
          if (attempt === maxRetries + 1) {
            throw new LokaliseError(
              `Maximum retries reached: ${error.message ?? "Unknown error"}`,
              error.code,
              error.details
            );
          }
          await this.sleep(initialSleepTime * 2 ** (attempt - 1));
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
    const startTime = Date.now();
    let waitTime = initialWaitTime;
    const processMap = /* @__PURE__ */ new Map();
    const pendingProcessIds = /* @__PURE__ */ new Set();
    for (const process2 of processes) {
      if (!process2.status) {
        process2.status = "queued";
      }
      processMap.set(process2.process_id, process2);
      if (this.PENDING_STATUSES.includes(process2.status)) {
        pendingProcessIds.add(process2.process_id);
      }
    }
    while (pendingProcessIds.size > 0 && Date.now() - startTime < maxWaitTime) {
      await Promise.all(
        [...pendingProcessIds].map(async (processId) => {
          try {
            const updatedProcess = await this.apiClient.queuedProcesses().get(processId, { project_id: this.projectId });
            if (!updatedProcess.status) {
              updatedProcess.status = "queued";
            }
            processMap.set(processId, updatedProcess);
            if (this.FINISHED_STATUSES.includes(updatedProcess.status)) {
              pendingProcessIds.delete(processId);
            }
          } catch (_error) {
          }
        })
      );
      if (pendingProcessIds.size === 0 || Date.now() - startTime >= maxWaitTime) {
        break;
      }
      await this.sleep(waitTime);
      waitTime = Math.min(waitTime * 2, maxWaitTime - (Date.now() - startTime));
    }
    return Array.from(processMap.values());
  }
  /**
   * Pauses execution for the specified number of milliseconds.
   *
   * @param ms - The time to sleep in milliseconds.
   * @returns A promise that resolves after the specified time.
   */
  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
};

// lib/services/LokaliseDownload.ts
var LokaliseDownload = class _LokaliseDownload extends LokaliseFileExchange {
  streamPipeline = promisify(pipeline);
  static defaultProcessParams = {
    asyncDownload: false,
    pollInitialWaitTime: 1e3,
    pollMaximumWaitTime: 12e4,
    bundleDownloadTimeout: void 0
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
    processDownloadFileParams
  }) {
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
      const downloadProcess = await this.getTranslationsBundleAsync(downloadFileParams);
      const completedProcess = (await this.pollProcesses(
        [downloadProcess],
        pollInitialWaitTime,
        pollMaximumWaitTime
      ))[0];
      if (completedProcess.status === "finished") {
        translationsBundleURL = completedProcess.details.download_url;
      } else {
        throw new LokaliseError(
          `Download process took too long to finalize; gave up after ${pollMaximumWaitTime}ms`,
          500
        );
      }
    } else {
      const translationsBundle = await this.getTranslationsBundle(downloadFileParams);
      translationsBundleURL = translationsBundle.bundle_url;
    }
    const zipFilePath = await this.downloadZip(
      translationsBundleURL,
      bundleDownloadTimeout
    );
    try {
      await this.unpackZip(
        zipFilePath,
        path.resolve(extractParams.outputDir ?? "./")
      );
    } finally {
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
    const createDir = async (dir) => {
      await fs.promises.mkdir(dir, { recursive: true });
    };
    return new Promise((resolve, reject) => {
      yauzl.open(zipFilePath, { lazyEntries: true }, async (err, zipfile) => {
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
        zipfile.on("entry", async (entry) => {
          try {
            const fullPath = path.resolve(outputDir, entry.fileName);
            const relative = path.relative(outputDir, fullPath);
            if (relative.startsWith("..") || path.isAbsolute(relative)) {
              throw new LokaliseError(
                `Malicious ZIP entry detected: ${entry.fileName}`
              );
            }
            if (/\/$/.test(entry.fileName)) {
              await createDir(fullPath);
              zipfile.readEntry();
            } else {
              await createDir(path.dirname(fullPath));
              const writeStream = fs.createWriteStream(fullPath);
              zipfile.openReadStream(entry, (readErr, readStream) => {
                if (readErr || !readStream) {
                  return reject(
                    new LokaliseError(
                      `Failed to read ZIP entry: ${entry.fileName}`
                    )
                  );
                }
                readStream.pipe(writeStream);
                writeStream.on("finish", () => zipfile.readEntry());
                writeStream.on("error", reject);
              });
            }
          } catch (error) {
            return reject(error);
          }
        });
        zipfile.on("end", () => resolve());
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
  async downloadZip(url, downloadTimeout) {
    if (!/^https?:\/\//.test(url)) {
      throw new LokaliseError(`Invalid URL: ${url}`);
    }
    const tempZipPath = path.join(
      os.tmpdir(),
      `lokalise-translations-${Date.now()}.zip`
    );
    const controller = new AbortController();
    let timeoutId = null;
    let response;
    if (downloadTimeout && downloadTimeout > 0) {
      timeoutId = setTimeout(() => controller.abort(), downloadTimeout);
    }
    try {
      response = await fetch(url, {
        signal: controller.signal
      });
    } catch (err) {
      if (err instanceof Error) {
        if (err.name === "AbortError") {
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
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
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
};

// lib/services/LokaliseUpload.ts
import fs2 from "node:fs";
import path2 from "node:path";
var LokaliseUpload = class _LokaliseUpload extends LokaliseFileExchange {
  maxConcurrentProcesses = 6;
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
    const { pollStatuses, pollInitialWaitTime, pollMaximumWaitTime } = {
      ..._LokaliseUpload.defaultPollingParams,
      ...processUploadFileParams
    };
    const collectedFiles = await this.collectFiles(collectFileParams);
    const { processes, errors } = await this.parallelUpload(
      collectedFiles,
      uploadFileParams,
      processUploadFileParams
    );
    let completedProcesses = processes;
    if (pollStatuses) {
      completedProcesses = await this.pollProcesses(
        processes,
        pollInitialWaitTime,
        pollMaximumWaitTime
      );
    }
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
    const collectedFiles = [];
    const queue = [...inputDirs.map((dir) => path2.resolve(dir))];
    const normalizedExtensions = extensions.map(
      (ext) => ext.startsWith(".") ? ext : `.${ext}`
    );
    let fileNameRegex;
    try {
      fileNameRegex = new RegExp(fileNamePattern);
    } catch {
      throw new Error(`Invalid fileNamePattern: ${fileNamePattern}`);
    }
    let excludeRegexes = [];
    try {
      excludeRegexes = excludePatterns.map((pattern) => new RegExp(pattern));
    } catch (err) {
      throw new Error(`Invalid excludePatterns: ${err}`);
    }
    while (queue.length > 0) {
      const dir = queue.shift();
      if (!dir) {
        continue;
      }
      let entries;
      try {
        entries = await fs2.promises.readdir(dir, { withFileTypes: true });
      } catch {
        console.warn(`Skipping inaccessible directory: ${dir}`);
        continue;
      }
      for (const entry of entries) {
        const fullPath = path2.resolve(dir, entry.name);
        if (excludeRegexes.some((regex) => regex.test(fullPath))) {
          continue;
        }
        if (entry.isDirectory() && recursive) {
          queue.push(fullPath);
        } else if (entry.isFile()) {
          const fileExt = path2.extname(entry.name);
          const matchesExtension = normalizedExtensions.includes(".*") || normalizedExtensions.includes(fileExt);
          const matchesFilenamePattern = fileNameRegex.test(entry.name);
          if (matchesExtension && matchesFilenamePattern) {
            collectedFiles.push(fullPath);
          }
        }
      }
    }
    return collectedFiles.sort();
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
      languageCode = path2.parse(path2.basename(relativePath)).name;
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
    const pool = new Array(this.maxConcurrentProcesses).fill(null).map(
      () => (async () => {
        while (files.length > 0) {
          const file = files.shift();
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
};
export {
  LokaliseDownload,
  LokaliseError,
  LokaliseUpload
};
//# sourceMappingURL=index.js.map