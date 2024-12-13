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
import { LokaliseApi } from "@lokalise/node-api";
import { ApiError as LokaliseApiError } from "@lokalise/node-api";
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
  /**
   * Creates a new instance of LokaliseFileExchange.
   *
   * @param {ClientParams} clientConfig - Configuration for the Lokalise SDK.
   * @param {LokaliseExchangeConfig} exchangeConfig - The configuration object for file exchange operations.
   * @throws {Error} If the provided configuration is invalid.
   */
  constructor(clientConfig, exchangeConfig) {
    if (!clientConfig.apiKey || typeof clientConfig.apiKey !== "string") {
      throw new Error("Invalid or missing API token.");
    }
    if (!exchangeConfig.projectId || typeof exchangeConfig.projectId !== "string") {
      throw new Error("Invalid or missing Project ID.");
    }
    const mergedRetryParams = {
      ..._LokaliseFileExchange.defaultRetryParams,
      ...exchangeConfig.retryParams
    };
    if (mergedRetryParams.maxRetries < 0) {
      throw new Error("maxRetries must be greater than or equal to zero.");
    }
    this.apiClient = new LokaliseApi(clientConfig);
    this.projectId = exchangeConfig.projectId;
    this.retryParams = mergedRetryParams;
  }
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
  async withExponentialBackoff(operation) {
    const { maxRetries, initialSleepTime } = this.retryParams;
    for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
      try {
        return await operation();
      } catch (error) {
        if (error instanceof LokaliseApiError && (error.code === 429 || error.code === 408)) {
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
   * Pauses execution for the specified number of milliseconds.
   *
   * @param {number} ms - The time to sleep in milliseconds.
   * @returns {Promise<void>} A promise that resolves after the specified time.
   */
  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
};

// lib/services/LokaliseDownload.ts
var LokaliseDownload = class extends LokaliseFileExchange {
  streamPipeline = promisify(pipeline);
  /**
   * Downloads translations from Lokalise, saving them to a ZIP file and then extracting them.
   *
   * @param {DownloadTranslationParams} downloadTranslationParams - Configuration for download, extraction, and retries.
   * @throws {LokaliseError} If any step fails (e.g., download or extraction fails).
   */
  async downloadTranslations(downloadTranslationParams) {
    const { downloadFileParams, extractParams = {} } = downloadTranslationParams;
    const outputDir = extractParams.outputDir ?? "./locales";
    const translationsBundle = await this.getTranslationsBundle(downloadFileParams);
    const zipFilePath = await this.downloadZip(translationsBundle.bundle_url);
    try {
      await this.unpackZip(zipFilePath, outputDir);
    } finally {
      await fs.promises.unlink(zipFilePath);
    }
  }
  /**
   * Unpacks a ZIP file into the specified directory.
   *
   * @param {string} zipFilePath - Path to the ZIP file.
   * @param {string} outputDir - Directory to extract the files into.
   * @throws {LokaliseError, Error} If extraction fails for any reason.
   */
  async unpackZip(zipFilePath, outputDir) {
    const createDir = async (dir) => {
      await fs.promises.mkdir(dir, { recursive: true });
    };
    return new Promise((resolve, reject) => {
      yauzl.open(zipFilePath, { lazyEntries: true }, async (err, zipfile) => {
        if (err) {
          return reject(err);
        }
        if (!zipfile) {
          return reject(new LokaliseError("Failed to open ZIP file"));
        }
        zipfile.readEntry();
        zipfile.on("entry", async (entry) => {
          try {
            const fullPath = path.join(outputDir, entry.fileName);
            if (/\/$/.test(entry.fileName)) {
              await createDir(fullPath);
              zipfile.readEntry();
            } else {
              await createDir(path.dirname(fullPath));
              const writeStream = fs.createWriteStream(fullPath);
              zipfile.openReadStream(entry, (readErr, readStream) => {
                if (readErr || !readStream) {
                  return reject(new LokaliseError("Failed to read ZIP entry."));
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
   * @param {string} url - The URL of the ZIP file.
   * @returns {Promise<string>} The file path of the downloaded ZIP file.
   * @throws {LokaliseError} If the download fails or the response body is empty.
   */
  async downloadZip(url) {
    const tempZipPath = path.join(
      os.tmpdir(),
      `lokalise-translations-${Date.now()}.zip`
    );
    const response = await fetch(url);
    if (!response.ok) {
      throw new LokaliseError(
        `Failed to download ZIP file: ${response.statusText}`
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
   * @param {DownloadFileParams} downloadFileParams - Parameters for Lokalise API file download.
   * @returns {Promise<DownloadBundle>} The downloaded bundle metadata.
   * @throws {LokaliseError} If retries are exhausted or an API error occurs.
   */
  async getTranslationsBundle(downloadFileParams) {
    return this.withExponentialBackoff(
      () => this.apiClient.files().download(this.projectId, downloadFileParams)
    );
  }
};

// lib/services/LokaliseUpload.ts
import fs2 from "node:fs";
import path2 from "node:path";
var LokaliseUpload = class extends LokaliseFileExchange {
  maxConcurrentProcesses = 6;
  /**
   * Collects files and uploads them to Lokalise, returning both processes and errors.
   *
   * @param {UploadTranslationParams} uploadTranslationParams - Parameters for collecting and uploading files.
   * @returns {Promise<{ processes: QueuedProcess[]; errors: FileUploadError[] }>} A promise resolving with successful processes and upload errors.
   */
  async uploadTranslations(uploadTranslationParams) {
    const { uploadFileParams, collectFileParams, processUploadFileParams } = uploadTranslationParams;
    const collectedFiles = await this.collectFiles(collectFileParams);
    return this.parallelUpload(
      collectedFiles,
      uploadFileParams,
      processUploadFileParams
    );
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
    excludePatterns = ["node_modules", "dist"],
    recursive = true,
    fileNamePattern = ".*"
  } = {}) {
    const collectedFiles = [];
    const traverseDirectory = async (dir) => {
      let entries;
      try {
        entries = await fs2.promises.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      const tasks = entries.map(async (entry) => {
        const fullPath = path2.resolve(dir, entry.name);
        if (excludePatterns.some((pattern) => fullPath.includes(pattern))) {
          return;
        }
        if (entry.isDirectory() && recursive) {
          await traverseDirectory(fullPath);
        } else if (entry.isFile()) {
          const fileExt = path2.extname(entry.name);
          const matchesExtension = extensions.some(
            (ext) => ext === ".*" || ext === fileExt
          );
          const matchesPattern = new RegExp(fileNamePattern).test(entry.name);
          if (matchesExtension && matchesPattern) {
            collectedFiles.push(fullPath);
          }
        }
      });
      await Promise.all(tasks);
    };
    const startTasks = inputDirs.map(async (dir) => {
      try {
        const stats = await fs2.promises.lstat(dir);
        if (stats.isDirectory()) {
          await traverseDirectory(path2.resolve(dir));
        }
      } catch {
        return;
      }
    });
    await Promise.all(startTasks);
    return collectedFiles;
  }
  /**
   * Uploads files in parallel with a limit on the number of concurrent uploads.
   *
   * @param {string[]} files - List of file paths to upload.
   * @param {Partial<UploadFileParams>} baseUploadFileParams - Base parameters for uploads.
   * @param {ProcessUploadFileParams} processUploadFileParams - Parameters for processing files before upload.
   * @returns {Promise<{ processes: QueuedProcess[]; errors: FileUploadError[] }>} A promise resolving with successful processes and upload errors.
   */
  async parallelUpload(files, baseUploadFileParams = {}, processUploadFileParams = {}) {
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
              processUploadFileParams.languageInferer
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
   * @param {(filePath: string) => Promise<string> | string} [languageInferer] - Optional function to infer the language code from the file path. Can be asynchronous.
   * @returns {Promise<ProcessedFile>} A promise resolving with the processed file details, including base64 content, relative path, and language code.
   */
  async processFile(file, projectRoot, languageInferer) {
    const fileContent = await fs2.promises.readFile(file);
    const base64Data = fileContent.toString("base64");
    const relativePath = path2.posix.relative(
      projectRoot.split(path2.sep).join(path2.posix.sep),
      file.split(path2.sep).join(path2.posix.sep)
    );
    let languageCode;
    try {
      languageCode = languageInferer ? await languageInferer(file) : "";
      if (!languageCode.trim()) {
        throw new Error("Invalid language code: empty or only whitespace");
      }
    } catch {
      languageCode = path2.parse(path2.basename(relativePath)).name;
    }
    return {
      data: base64Data,
      filename: relativePath,
      lang_iso: languageCode
    };
  }
};
export {
  LokaliseDownload,
  LokaliseError,
  LokaliseFileExchange,
  LokaliseUpload
};
//# sourceMappingURL=index.js.map