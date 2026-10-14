import fs from "node:fs";
import path from "node:path";
import type {
	DownloadBundle,
	DownloadedFileProcessDetails,
	DownloadFileParams,
	QueuedProcess,
} from "@lokalise/node-api";
import {
	downloadBundleZip,
	validateDownloadTimeout,
} from "../downloaders/bundle-downloader.js";
import { LokaliseError } from "../errors/LokaliseError.js";
import { unpackZip } from "../extractors/zip-extractor.js";
import type {
	DownloadTranslationParams,
	ProcessDownloadFileParams,
} from "../interfaces/index.js";
import {
	pollLokaliseProcesses,
	validatePollingParams,
} from "../processes/poll-lokalise-processes.js";
import { withExponentialBackoff } from "../utils/retry.js";
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

		validateDownloadTimeout(processParams.bundleDownloadTimeout);

		if (processParams.asyncDownload) {
			validatePollingParams({
				initialWaitTime: processParams.pollInitialWaitTime,
				maxWaitTime: processParams.pollMaximumWaitTime,
			});
		}
		const translationsBundleURL = await this.fetchTranslationBundleURL(
			downloadFileParams,
			processParams,
		);

		const zipFilePath = await downloadBundleZip(
			translationsBundleURL,
			processParams.bundleDownloadTimeout,
			(message, error) => this.logMsg("warn", message, error),
		);

		await this.processZip(
			zipFilePath,
			path.resolve(extractParams.outputDir ?? "./"),
		);
	}

	/**
	 * Retrieves translation bundle metadata from Lokalise
	 * with exponential-backoff retry support.
	 *
	 * @param downloadFileParams - Parameters for the Lokalise API request.
	 * @returns The translation bundle metadata.
	 * @throws {LokaliseError} If the API request fails.
	 */
	protected async getTranslationsBundle(
		downloadFileParams: DownloadFileParams,
	): Promise<DownloadBundle> {
		return withExponentialBackoff(
			() => this.apiClient.files().download(this.projectId, downloadFileParams),
			this.retryParams,
			{
				onDebug: (message) => this.logMsg("debug", message),
			},
		);
	}

	/**
	 * Starts an asynchronous translation bundle download
	 * with exponential-backoff retry support.
	 *
	 * @param downloadFileParams - Parameters for the Lokalise API request.
	 * @returns The queued download process.
	 * @throws {LokaliseError} If the API request fails.
	 */
	protected async getTranslationsBundleAsync(
		downloadFileParams: DownloadFileParams,
	): Promise<QueuedProcess> {
		return withExponentialBackoff(
			() =>
				this.apiClient
					.files()
					.async_download(this.projectId, downloadFileParams),
			this.retryParams,
			{
				onDebug: (message) => this.logMsg("debug", message),
			},
		);
	}

	/**
	 * Resolves download process parameters using default values
	 * for any missing options.
	 *
	 * @param overrides - Optional process configuration overrides.
	 * @returns Fully resolved process parameters.
	 */
	private buildProcessParams(
		overrides?: Partial<ProcessDownloadFileParams>,
	): Required<ProcessDownloadFileParams> {
		const defaults = LokaliseDownload.defaultProcessParams;

		return {
			asyncDownload: overrides?.asyncDownload ?? defaults.asyncDownload,
			pollInitialWaitTime:
				overrides?.pollInitialWaitTime ?? defaults.pollInitialWaitTime,
			pollMaximumWaitTime:
				overrides?.pollMaximumWaitTime ?? defaults.pollMaximumWaitTime,
			bundleDownloadTimeout:
				overrides?.bundleDownloadTimeout ?? defaults.bundleDownloadTimeout,
		};
	}

	/**
	 * Extracts the downloaded ZIP archive and removes
	 * the temporary archive afterward.
	 *
	 * Cleanup failures are logged without masking extraction errors.
	 *
	 * @param zipFilePath - Path to the temporary ZIP archive.
	 * @param unpackTo - Destination directory.
	 */
	private async processZip(
		zipFilePath: string,
		unpackTo: string,
	): Promise<void> {
		this.logMsg("debug", `Unpacking translations to ${unpackTo}`);

		try {
			await unpackZip(zipFilePath, unpackTo);
			this.logMsg(
				"debug",
				"Translations downloaded and unpacked successfully.",
			);
		} finally {
			try {
				await fs.promises.unlink(zipFilePath);
			} catch (error) {
				this.logMsg(
					"warn",
					`Unable to remove temporary archive ${zipFilePath}`,
					error,
				);
			}
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
	 * Polls an asynchronous download process and returns
	 * its latest known state.
	 *
	 * @param downloadProcess - Initially queued download process.
	 * @param initialWait - Initial polling interval in milliseconds.
	 * @param maxWait - Maximum polling time in milliseconds.
	 * @returns The latest process state.
	 */
	protected async pollAsyncDownload(
		downloadProcess: QueuedProcess,
		initialWait: number,
		maxWait: number,
	): Promise<QueuedProcess> {
		this.logMsg(
			"debug",
			`Waiting for download process ${downloadProcess.process_id}...`,
		);

		const results = await pollLokaliseProcesses({
			processes: [downloadProcess],
			apiClient: this.apiClient,
			projectId: this.projectId,
			initialWaitTime: initialWait,
			maxWaitTime: maxWait,
			onDebug: (message) => this.logMsg("debug", message),
			onWarning: (id, error) =>
				this.logMsg("warn", `Failed to fetch process ${id}:`, error),
		});

		const completedProcess = results[0];

		if (
			!completedProcess ||
			completedProcess.process_id !== downloadProcess.process_id
		) {
			throw new LokaliseError(
				`Process ${downloadProcess.process_id} not found after polling`,
				500,
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
	 * Resolves the bundle URL from a completed async process.
	 *
	 * Throws when the process failed, was cancelled,
	 * or did not finish within the polling time budget.
	 */
	private resolveAsyncBundleUrl(
		process: QueuedProcess,
		maxWait: number,
	): string {
		const { process_id, status } = process;

		if (status === "finished") {
			const details = process.details as
				| (DownloadedFileProcessDetails & { download_url?: string })
				| undefined;

			const url = details?.download_url;

			if (typeof url !== "string" || !url.trim()) {
				throw new LokaliseError(
					`Process ${process_id} finished without a valid download_url`,
					502,
				);
			}

			return url.trim();
		}

		if (status === "failed" || status === "cancelled") {
			const message = process.message?.trim();

			throw new LokaliseError(
				`Process ${process_id} ended with status=${status}` +
					(message ? `: ${message}` : ""),
				502,
			);
		}

		throw new LokaliseError(
			`Download process ${process_id} did not finish within ${maxWait}ms` +
				` (last status=${status ?? "missing"})`,
			504,
		);
	}

	/**
	 * Queues an asynchronous translation bundle download,
	 * polls the process, and returns the generated bundle URL.
	 *
	 * @param downloadFileParams - Lokalise API download parameters.
	 * @param processParams - Resolved download process configuration.
	 * @returns Direct URL of the generated ZIP bundle.
	 */
	protected async fetchBundleURLAsync(
		downloadFileParams: DownloadFileParams,
		processParams: Required<ProcessDownloadFileParams>,
	): Promise<string> {
		this.logMsg("debug", "Async download mode enabled.");

		const downloadProcess =
			await this.getTranslationsBundleAsync(downloadFileParams);

		const completedProcess = await this.pollAsyncDownload(
			downloadProcess,
			processParams.pollInitialWaitTime,
			processParams.pollMaximumWaitTime,
		);

		this.logMsg(
			"debug",
			`Download process status: ${completedProcess.status ?? "missing"}`,
		);

		return this.resolveAsyncBundleUrl(
			completedProcess,
			processParams.pollMaximumWaitTime,
		);
	}
}
