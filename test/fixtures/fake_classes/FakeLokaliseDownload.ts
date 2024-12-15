import type { DownloadBundle, DownloadFileParams } from "@lokalise/node-api";
import { LokaliseDownload } from "../../../lib/services/LokaliseDownload.js";

// Public morozov
export class FakeLokaliseDownload extends LokaliseDownload {
	public async getTranslationsBundle(
		downloadFileParams: DownloadFileParams,
	): Promise<DownloadBundle> {
		return await super.getTranslationsBundle(downloadFileParams);
	}

	public async downloadZip(url: string): Promise<string> {
		return await super.downloadZip(url);
	}

	public async unpackZip(
		zipFilePath: string,
		outputDir: string,
	): Promise<void> {
		return await super.unpackZip(zipFilePath, outputDir);
	}
}