import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream";
import { promisify } from "node:util";
import type {
	DownloadBundle,
	DownloadFileParams,
	DownloadedFileProcessDetails,
	QueuedProcess,
} from "@lokalise/node-api";
import yauzl from "yauzl";
import { LokaliseError } from "../errors/LokaliseError.js";
import type { DownloadTranslationParams } from "../interfaces/index.js";
import { LokaliseFileExchange } from "./LokaliseFileExchange.js";

/**
 * Handles downloading and extracting translation files from Lokalise.
 */
export class LokaliseDownload extends LokaliseFileExchange {
	private static readonly defaultProcessParams = {
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

		const {
			asyncDownload,
			pollInitialWaitTime,
			pollMaximumWaitTime,
			bundleDownloadTimeout,
		} = {
			...LokaliseDownload.defaultProcessParams,
			...processDownloadFileParams,
		};

		let translationsBundleURL: string;

		if (asyncDownload) {
			this.logMsg("debug", "Async download mode enabled.");

			const downloadProcess =
				await this.getTranslationsBundleAsync(downloadFileParams);

			this.logMsg(
				"debug",
				`Waiting for download process ID ${downloadProcess.process_id} to complete...`,
			);

			const completedProcess = (
				await this.pollProcesses(
					[downloadProcess],
					pollInitialWaitTime,
					pollMaximumWaitTime,
				)
			)[0];

			this.logMsg("debug", `Download process status is ${completedProcess.status}`);

			if (completedProcess.status === "finished") {
				const completedProcessDetails =
					completedProcess.details as DownloadedFileProcessDetails;
				translationsBundleURL = completedProcessDetails.download_url;
			} else {
				throw new LokaliseError(
					`Download process took too long to finalize; gave up after ${pollMaximumWaitTime}ms`,
					500,
				);
			}
		} else {
			this.logMsg("debug", "Async download mode disabled.");

			const translationsBundle =
				await this.getTranslationsBundle(downloadFileParams);
			translationsBundleURL = translationsBundle.bundle_url;
		}

		this.logMsg(
			"debug",
			`Downloading translation bundle from ${translationsBundleURL}`,
		);

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
	protected async downloadZip(
		url: string,
		downloadTimeout = 0,
	): Promise<string> {
		const bundleURL = this.assertHttpUrl(url);

		const uid = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
		const tempZipPath = path.join(os.tmpdir(), `lokalise-${uid}.zip`);
		let response: Response;

		const signal =
			downloadTimeout > 0 ? AbortSignal.timeout(downloadTimeout) : undefined;

		try {
			response = await fetch(bundleURL, {
				signal,
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
	private async handleZipEntry(
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
	private processZipEntryPath(
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
}
