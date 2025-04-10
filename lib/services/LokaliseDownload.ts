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
	private readonly streamPipeline = promisify(pipeline);
	private static readonly defaultProcessParams = {
		asyncDownload: false,
		pollInitialWaitTime: 1000,
		pollMaximumWaitTime: 120_000,
		bundleDownloadTimeout: undefined,
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
		processDownloadFileParams,
	}: DownloadTranslationParams): Promise<void> {
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
			const downloadProcess =
				await this.getTranslationsBundleAsync(downloadFileParams);

			const completedProcess = (
				await this.pollProcesses(
					[downloadProcess],
					pollInitialWaitTime,
					pollMaximumWaitTime,
				)
			)[0];

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
			const translationsBundle =
				await this.getTranslationsBundle(downloadFileParams);
			translationsBundleURL = translationsBundle.bundle_url;
		}

		const zipFilePath = await this.downloadZip(
			translationsBundleURL,
			bundleDownloadTimeout,
		);

		try {
			await this.unpackZip(
				zipFilePath,
				path.resolve(extractParams.outputDir ?? "./"),
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
	protected async unpackZip(
		zipFilePath: string,
		outputDir: string,
	): Promise<void> {
		const createDir = async (dir: string): Promise<void> => {
			await fs.promises.mkdir(dir, { recursive: true });
		};

		return new Promise((resolve, reject) => {
			yauzl.open(zipFilePath, { lazyEntries: true }, async (err, zipfile) => {
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
				zipfile.on("entry", async (entry) => {
					try {
						// Validate paths to avoid path traversal issues
						const fullPath = path.resolve(outputDir, entry.fileName);
						const relative = path.relative(outputDir, fullPath);
						if (relative.startsWith("..") || path.isAbsolute(relative)) {
							throw new LokaliseError(
								`Malicious ZIP entry detected: ${entry.fileName}`,
							);
						}

						if (/\/$/.test(entry.fileName)) {
							// Directory
							await createDir(fullPath);
							zipfile.readEntry();
						} else {
							// File
							await createDir(path.dirname(fullPath));
							const writeStream = fs.createWriteStream(fullPath);
							zipfile.openReadStream(entry, (readErr, readStream) => {
								if (readErr || !readStream) {
									return reject(
										new LokaliseError(
											`Failed to read ZIP entry: ${entry.fileName}`,
										),
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
	protected async downloadZip(
		url: string,
		downloadTimeout: number | undefined,
	): Promise<string> {
		if (!/^https?:\/\//.test(url)) {
			throw new LokaliseError(`Invalid URL: ${url}`);
		}

		const tempZipPath = path.join(
			os.tmpdir(),
			`lokalise-translations-${Date.now()}.zip`,
		);

		const controller = new AbortController();
		let timeoutId: NodeJS.Timeout | null = null;
		let response: Response;

		if (downloadTimeout && downloadTimeout > 0) {
			timeoutId = setTimeout(() => controller.abort(), downloadTimeout);
		}

		try {
			response = await fetch(url, {
				signal: controller.signal,
			});
		} catch (err) {
			if (err instanceof Error) {
				if (err.name === "AbortError") {
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
		} finally {
			if (timeoutId) {
				clearTimeout(timeoutId);
			}
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
}
