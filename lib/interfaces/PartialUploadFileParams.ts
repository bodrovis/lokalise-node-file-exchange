import type { UploadFileParams } from "@lokalise/node-api";

type UploadFileParamsBase = Omit<
	UploadFileParams,
	"data" | "filename" | "lang_iso"
>;

export interface PartialUploadFileParams extends UploadFileParamsBase {}
