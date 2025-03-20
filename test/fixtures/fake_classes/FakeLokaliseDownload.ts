import type {
	DownloadBundle,
	DownloadFileParams,
	QueuedProcess,
} from "@lokalise/node-api";
import { LokaliseDownload } from "../../../lib/services/LokaliseDownload.js";

// Public morozov
export class FakeLokaliseDownload extends LokaliseDownload {
	public async getTranslationsBundle(
		downloadFileParams: DownloadFileParams,
	): Promise<DownloadBundle> {
		return await super.getTranslationsBundle(downloadFileParams);
	}

	public async getTranslationsBundleAsync(
		downloadFileParams: DownloadFileParams,
	): Promise<QueuedProcess> {
		return await super.getTranslationsBundleAsync(downloadFileParams);
	}

	public async downloadZip(
		url: string,
		downloadTimeout?: number | undefined,
	): Promise<string> {
		return await super.downloadZip(url, downloadTimeout);
	}

	public async unpackZip(
		zipFilePath: string,
		outputDir: string,
	): Promise<void> {
		return await super.unpackZip(zipFilePath, outputDir);
	}

	public async pollProcesses(
		processes: QueuedProcess[],
		initialWaitTime: number,
		maxWaitTime: number,
	): Promise<QueuedProcess[]> {
		return await super.pollProcesses(processes, initialWaitTime, maxWaitTime);
	}
}
