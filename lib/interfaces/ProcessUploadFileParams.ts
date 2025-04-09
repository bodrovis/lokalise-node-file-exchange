type Inferer = (filePath: string) => Promise<string> | string;

export interface ProcessUploadFileParams {
	languageInferer?: Inferer;
	filenameInferer?: Inferer;
	pollStatuses?: boolean;
	pollInitialWaitTime?: number;
	pollMaximumWaitTime?: number;
}
