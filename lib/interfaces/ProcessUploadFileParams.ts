export interface ProcessUploadFileParams {
	languageInferer?: (filePath: string) => Promise<string> | string;
}
