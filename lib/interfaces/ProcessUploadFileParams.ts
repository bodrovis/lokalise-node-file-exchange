export interface ProcessUploadFileParams {
	languageInferer?: (filePath: string) => Promise<string> | string;
	pollStatuses?: boolean;
	pollInitialWaitTime?: number;
	pollMaximumWaitTime?: number;
}
