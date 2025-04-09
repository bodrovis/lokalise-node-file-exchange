export interface CollectFileParams {
	inputDirs?: string[];
	extensions?: string[];
	excludePatterns?: string[] | RegExp[];
	recursive?: boolean;
	fileNamePattern?: string | RegExp;
}
