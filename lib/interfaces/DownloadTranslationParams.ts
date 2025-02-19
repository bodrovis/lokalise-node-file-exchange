import type { DownloadFileParams } from "@lokalise/node-api";
import type { ExtractParams } from "./ExtractParams.js";
import type { ProcessDownloadFileParams } from "./ProcessDownloadFileParams.js";

export interface DownloadTranslationParams {
	downloadFileParams: DownloadFileParams;
	extractParams?: ExtractParams;
	processDownloadFileParams?: ProcessDownloadFileParams;
}
