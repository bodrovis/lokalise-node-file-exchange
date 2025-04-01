import type { QueuedProcess, UploadFileParams } from "@lokalise/node-api";
import type { CollectFileParams } from "../../../lib/interfaces/CollectFileParams.js";
import type { ProcessedFile } from "../../../lib/interfaces/ProcessedFile.js";
import { LokaliseUpload } from "../../../lib/services/LokaliseUpload.js";

// Public morozov
export class FakeLokaliseUpload extends LokaliseUpload {
	public async uploadSingleFile(
		uploadParams: UploadFileParams,
	): Promise<QueuedProcess> {
		return await super.uploadSingleFile(uploadParams);
	}

	public async processFile(
		file: string,
		projectRoot: string,
		languageInferer?: (filePath: string) => Promise<string> | string,
		filenameInferer?: (filePath: string) => Promise<string> | string,
	): Promise<ProcessedFile> {
		return await super.processFile(
			file,
			projectRoot,
			languageInferer,
			filenameInferer,
		);
	}

	public async collectFiles({
		inputDirs = ["./locales"],
		extensions = [".*"],
		excludePatterns = ["node_modules", "dist"],
		recursive = true,
		fileNamePattern = ".*",
	}: CollectFileParams = {}): Promise<string[]> {
		return await super.collectFiles({
			inputDirs,
			extensions,
			excludePatterns,
			recursive,
			fileNamePattern,
		});
	}
}
