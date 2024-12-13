import type { UploadFileParams } from "@lokalise/node-api";
import type { CollectFileParams } from "./CollectFileParams.js";
import type { ProcessUploadFileParams } from "./ProcessUploadFileParams.js";

export interface UploadTranslationParams {
	uploadFileParams?: Partial<UploadFileParams>;
	collectFileParams?: CollectFileParams;
	processUploadFileParams?: ProcessUploadFileParams;
}
