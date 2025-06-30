import type { QueuedProcess, UploadFileParams } from "@lokalise/node-api";
import type { CollectFileParams } from "../../../lib/interfaces/CollectFileParams.js";
import type { ProcessedFile } from "../../../lib/interfaces/ProcessedFile.js";
import type { ProcessUploadFileParams } from "../../../lib/interfaces/ProcessUploadFileParams.js";
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
		processParams?: ProcessUploadFileParams,
	): Promise<ProcessedFile> {
		return await super.processFile(file, projectRoot, processParams);
	}

	public async collectFiles({
		inputDirs = ["./locales"],
		extensions = [".*"],
		excludePatterns = [],
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
