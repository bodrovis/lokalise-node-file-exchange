import type { DownloadFileParams } from "@lokalise/node-api";
import type { ExtractParams } from "./ExtractParams.js";

export interface DownloadTranslationParams {
	downloadFileParams: DownloadFileParams;
	extractParams?: ExtractParams;
}
