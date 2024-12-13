import type { QueuedProcess, UploadFileParams } from "@lokalise/node-api";
import type { CollectFileParams } from "../../../lib/interfaces/CollectFileParams.js";
import type { ProcessedFile } from "../../../lib/interfaces/ProcessedFile.js";
import { LokaliseUpload } from "../../../lib/services/LokaliseUpload.js";

// Public morozov
export class FakeLokaliseUpload extends LokaliseUpload {
	async fakeUploadSingleFile(
		uploadParams: UploadFileParams,
	): Promise<QueuedProcess> {
		return await this.uploadSingleFile(uploadParams);
	}

	async fakeProcessFile(
		file: string,
		projectRoot: string,
		languageInferer?: (filePath: string) => Promise<string> | string,
	): Promise<ProcessedFile> {
		return await this.processFile(file, projectRoot, languageInferer);
	}

	async fakeCollectFiles({
		inputDirs = ["./locales"],
		extensions = [".*"],
		excludePatterns = ["node_modules", "dist"],
		recursive = true,
		fileNamePattern = ".*",
	}: CollectFileParams = {}): Promise<string[]> {
		return await this.collectFiles({
			inputDirs,
			extensions,
			excludePatterns,
			recursive,
			fileNamePattern,
		});
	}
}
