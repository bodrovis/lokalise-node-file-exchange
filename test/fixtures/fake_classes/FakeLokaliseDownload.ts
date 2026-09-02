import type {
	DownloadBundle,
	DownloadFileParams,
	QueuedProcess,
} from "@lokalise/node-api";
import type { LogLevel } from "kliedz";
import type yauzl from "yauzl";
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

	public override async downloadZip(
		url: string,
		downloadTimeout?: number | undefined,
	): Promise<string> {
		return await super.downloadZip(url, downloadTimeout);
	}

	public override async unpackZip(
		zipFilePath: string,
		outputDir: string,
	): Promise<void> {
		return await super.unpackZip(zipFilePath, outputDir);
	}

	public override async pollProcesses(
		processes: QueuedProcess[],
		initialWaitTime: number,
		maxWaitTime: number,
	): Promise<QueuedProcess[]> {
		return await super.pollProcesses(processes, initialWaitTime, maxWaitTime);
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

	public override processZipEntryPath(
		outputDir: string,
		entryFilename: string,
	): string {
		return super.processZipEntryPath(outputDir, entryFilename);
	}

	public override async handleZipEntry(
		entry: yauzl.Entry,
		zipfile: yauzl.ZipFile,
		outputDir: string,
	): Promise<void> {
		return super.handleZipEntry(entry, zipfile, outputDir);
	}

	public override async fetchZipResponse(
		bundleURL: URL,
		signal: AbortSignal | undefined,
		downloadTimeout: number,
	): Promise<Response> {
		return super.fetchZipResponse(bundleURL, signal, downloadTimeout);
	}

	public override buildTempZipPath(): string {
		return super.buildTempZipPath();
	}
}
