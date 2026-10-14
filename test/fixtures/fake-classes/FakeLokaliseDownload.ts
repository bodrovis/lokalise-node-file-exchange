import type {
	DownloadBundle,
	DownloadFileParams,
	QueuedProcess,
} from "@lokalise/node-api";
import type { LogLevel } from "kliedz";
import type { ProcessDownloadFileParams } from "../../../lib/interfaces/index.js";
import { LokaliseDownload } from "../../../lib/services/LokaliseDownload.js";

// Public morozov
export class FakeLokaliseDownload extends LokaliseDownload {
	public override async getTranslationsBundle(
		downloadFileParams: DownloadFileParams,
	): Promise<DownloadBundle> {
		return await super.getTranslationsBundle(downloadFileParams);
	}

	public override async getTranslationsBundleAsync(
		downloadFileParams: DownloadFileParams,
	): Promise<QueuedProcess> {
		return await super.getTranslationsBundleAsync(downloadFileParams);
	}

	public override async pollAsyncDownload(
		downloadProcess: QueuedProcess,
		initialWait: number,
		maxWait: number,
	): Promise<QueuedProcess> {
		return super.pollAsyncDownload(downloadProcess, initialWait, maxWait);
	}

	public override logMsg(level: LogLevel, ...args: unknown[]): void {
		super.logMsg(level, ...args);
	}

	public override async fetchBundleURLAsync(
		downloadFileParams: DownloadFileParams,
		processParams: Required<ProcessDownloadFileParams>,
	): Promise<string> {
		return super.fetchBundleURLAsync(downloadFileParams, processParams);
	}
}
