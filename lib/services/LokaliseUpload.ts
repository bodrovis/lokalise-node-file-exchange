import type { QueuedProcess, UploadFileParams } from "@lokalise/node-api";
import { collectFiles } from "../collectors/file-collector.js";
import { MAX_CONCURRENT_PROCESSES } from "../constants.js";
import type {
	FileUploadError,
	PartialUploadFileParams,
	ProcessUploadFileParams,
	QueuedUploadProcessesWithErrors,
	UploadTranslationParams,
} from "../interfaces/index.js";
import {
	pollLokaliseProcesses,
	validatePollingParams,
} from "../processes/poll-lokalise-processes.js";
import { processUploadFile } from "../processors/upload-file.js";
import { runWithConcurrencyLimit } from "../utils/concurrency.js";
import { isFinishedStatus } from "../utils/process-status.js";
import { withExponentialBackoff } from "../utils/retry.js";
import { LokaliseFileExchange } from "./LokaliseFileExchange.js";

interface ResolvedPollingParams {
	pollStatuses: boolean;
	pollInitialWaitTime: number;
	pollMaximumWaitTime: number;
}

type UploadOutcome =
	| { ok: true; process: QueuedProcess }
	| { ok: false; error: FileUploadError };

/**
 * Handles uploading translation files to Lokalise.
 */
export class LokaliseUpload extends LokaliseFileExchange {
	private static readonly defaultPollingParams = {
		pollStatuses: false,
		pollInitialWaitTime: 1000,
		pollMaximumWaitTime: 120_000,
	};

	/**
	 * Collects and uploads translation files to Lokalise.
	 * Optionally polls queued processes and returns their statuses
	 * along with any upload errors.
	 *
	 * @param params - File collection, upload, and processing options.
	 * @returns Queued processes and upload errors.
	 */
	async uploadTranslations({
		uploadFileParams,
		collectFileParams,
		processUploadFileParams,
	}: UploadTranslationParams = {}): Promise<QueuedUploadProcessesWithErrors> {
		this.logMsg("debug", "Uploading translations to Lokalise...");

		const polling = this.resolvePollingParams(processUploadFileParams);

		const files = await collectFiles(collectFileParams, {
			onWarning: (message, error) => this.logMsg("warn", message, error),
		});

		const { processes, errors } = await this.parallelUpload(
			files,
			uploadFileParams,
			processUploadFileParams,
		);

		const shouldPoll = polling.pollStatuses && processes.length > 0;

		const completedProcesses = shouldPoll
			? await this.pollUploadedProcesses(
					processes,
					polling.pollInitialWaitTime,
					polling.pollMaximumWaitTime,
				)
			: processes;

		this.logUploadSummary(completedProcesses, errors, shouldPoll);

		return { processes: completedProcesses, errors };
	}

	/**
	 * Uploads a single file to Lokalise with retry support.
	 *
	 * @param uploadParams - File upload parameters.
	 * @returns The queued upload process.
	 */
	protected async uploadSingleFile(
		uploadParams: UploadFileParams,
	): Promise<QueuedProcess> {
		return withExponentialBackoff(
			() => this.apiClient.files().upload(this.projectId, uploadParams),
			this.retryParams,
			{
				onDebug: (message) => this.logMsg("debug", message),
			},
		);
	}

	/**
	 * Uploads files concurrently while preserving input order
	 * in the resulting process and error arrays.
	 *
	 * Individual file failures do not stop other uploads.
	 */
	private async parallelUpload(
		files: string[],
		baseUploadFileParams: PartialUploadFileParams = {},
		processParams?: ProcessUploadFileParams,
	): Promise<QueuedUploadProcessesWithErrors> {
		const projectRoot = process.cwd();

		const results = await runWithConcurrencyLimit(
			files,
			MAX_CONCURRENT_PROCESSES,
			async (file): Promise<UploadOutcome> => {
				try {
					const processed = await processUploadFile(
						file,
						projectRoot,
						processParams,
					);

					const process = await this.uploadSingleFile({
						...baseUploadFileParams,
						...processed,
					});

					return { ok: true, process };
				} catch (error) {
					return { ok: false, error: { file, error } };
				}
			},
		);

		const processes: QueuedProcess[] = [];
		const errors: FileUploadError[] = [];

		for (const result of results) {
			if (result.ok) {
				processes.push(result.process);
			} else {
				errors.push(result.error);
			}
		}

		return { processes, errors };
	}

	private async pollUploadedProcesses(
		processes: QueuedProcess[],
		initialWaitTime: number,
		maxWaitTime: number,
	): Promise<QueuedProcess[]> {
		return pollLokaliseProcesses({
			processes,
			apiClient: this.apiClient,
			projectId: this.projectId,
			initialWaitTime,
			maxWaitTime,
			onDebug: (message) => this.logMsg("debug", message),
			onWarning: (id, error) =>
				this.logMsg("warn", `Failed to fetch process ${id}:`, error),
		});
	}

	/**
	 * Resolves polling options and validates enabled polling settings.
	 *
	 * @param params - Optional polling configuration.
	 * @returns Polling configuration with all defaults applied.
	 */
	private resolvePollingParams(
		params?: ProcessUploadFileParams,
	): ResolvedPollingParams {
		const defaults = LokaliseUpload.defaultPollingParams;

		const resolved = {
			pollStatuses: params?.pollStatuses ?? defaults.pollStatuses,
			pollInitialWaitTime:
				params?.pollInitialWaitTime ?? defaults.pollInitialWaitTime,
			pollMaximumWaitTime:
				params?.pollMaximumWaitTime ?? defaults.pollMaximumWaitTime,
		};

		if (resolved.pollStatuses) {
			validatePollingParams({
				initialWaitTime: resolved.pollInitialWaitTime,
				maxWaitTime: resolved.pollMaximumWaitTime,
			});
		}

		return resolved;
	}

	/**
	 * Logs upload results and, if polling was performed,
	 * summarizes the latest process statuses.
	 *
	 * @param processes - Queued processes with their latest states.
	 * @param errors - Errors encountered while uploading files.
	 * @param wasPolled - Whether process polling was performed.
	 */
	private logUploadSummary(
		processes: QueuedProcess[],
		errors: FileUploadError[],
		wasPolled: boolean,
	): void {
		this.logMsg("debug", `Upload processes received: ${processes.length}.`);

		if (errors.length > 0) {
			this.logMsg("warn", `Upload completed with ${errors.length} error(s).`);
		}

		if (!wasPolled) return;

		const failedCount = processes.filter(
			(p) => p.status === "failed" || p.status === "cancelled",
		).length;

		const pendingCount = processes.filter(
			(p) => !isFinishedStatus(p.status),
		).length;

		this.logMsg(
			"debug",
			`Polling stopped. Failed/cancelled: ${failedCount}, pending: ${pendingCount}.`,
		);
	}
}
