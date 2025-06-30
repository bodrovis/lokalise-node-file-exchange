import fs from "node:fs";
import path from "node:path";
import type { QueuedProcess, UploadFileParams } from "@lokalise/node-api";
import type {
	CollectFileParams,
	FileUploadError,
	PartialUploadFileParams,
	ProcessedFile,
	ProcessUploadFileParams,
	QueuedUploadProcessesWithErrors,
	UploadTranslationParams,
} from "../interfaces/index.js";
import { LokaliseFileExchange } from "./LokaliseFileExchange.js";

/**
 * Handles uploading translation files to Lokalise.
 */
export class LokaliseUpload extends LokaliseFileExchange {
	private static readonly maxConcurrentProcesses = 6;

	private static readonly defaultPollingParams = {
		pollStatuses: false,
		pollInitialWaitTime: 1000,
		pollMaximumWaitTime: 120_000,
	};

	/**
	 * Collects files, uploads them to Lokalise, and optionally polls for process completion, returning both processes and errors.
	 *
	 * @param {UploadTranslationParams} uploadTranslationParams - Parameters for collecting and uploading files.
	 * @returns {Promise<{ processes: QueuedProcess[]; errors: FileUploadError[] }>} A promise resolving with successful processes and upload errors.
	 */
	async uploadTranslations({
		uploadFileParams,
		collectFileParams,
		processUploadFileParams,
	}: UploadTranslationParams = {}): Promise<QueuedUploadProcessesWithErrors> {
		this.logMsg("debug", "Uploading translations to Lokalise...");

		const { pollStatuses, pollInitialWaitTime, pollMaximumWaitTime } = {
			...LokaliseUpload.defaultPollingParams,
			...processUploadFileParams,
		};

		this.logMsg("debug", "Collecting files to upload...");
		const collectedFiles = await this.collectFiles(collectFileParams);
		this.logMsg("debug", "Collected files:", collectedFiles);

		this.logMsg("debug", "Performing parallel upload...");
		const { processes, errors } = await this.parallelUpload(
			collectedFiles,
			uploadFileParams,
			processUploadFileParams,
		);

		let completedProcesses = processes;
		this.logMsg(
			"debug",
			"File uploading queued! IDs:",
			completedProcesses.map((p) => p.process_id),
		);

		if (pollStatuses) {
			this.logMsg("debug", "Polling queued processes...");

			completedProcesses = await this.pollProcesses(
				processes,
				pollInitialWaitTime,
				pollMaximumWaitTime,
			);

			this.logMsg("debug", "Polling completed!");
		}

		this.logMsg("debug", "Upload successful!");

		return { processes: completedProcesses, errors };
	}

	/**
	 * Collects files from the filesystem based on the given parameters.
	 *
	 * @param {CollectFileParams} collectFileParams - Parameters for file collection, including directories, extensions, and patterns.
	 * @returns {Promise<string[]>} A promise resolving with the list of collected file paths.
	 */
	protected async collectFiles({
		inputDirs = ["./locales"],
		extensions = [".*"],
		excludePatterns = [],
		recursive = true,
		fileNamePattern = ".*",
	}: CollectFileParams = {}): Promise<string[]> {
		const queue = this.makeQueue(inputDirs);
		const normalizedExtensions = this.normalizeExtensions(extensions);
		const fileNameRegex = this.makeFilenameRegexp(fileNamePattern);
		const excludeRegexes = this.makeExcludeRegExes(excludePatterns);

		const files = await this.processCollectionQueue(
			queue,
			normalizedExtensions,
			fileNameRegex,
			excludeRegexes,
			recursive,
		);

		return files.sort();
	}

	/**
	 * Uploads a single file to Lokalise.
	 *
	 * @param {UploadFileParams} uploadParams - Parameters for uploading the file.
	 * @returns {Promise<QueuedProcess>} A promise resolving with the upload process details.
	 */
	protected async uploadSingleFile(
		uploadParams: UploadFileParams,
	): Promise<QueuedProcess> {
		return this.withExponentialBackoff(() =>
			this.apiClient.files().upload(this.projectId, uploadParams),
		);
	}

	/**
	 * Processes a file to prepare it for upload, converting it to base64 and extracting its language code.
	 *
	 * @param {string} file - The absolute path to the file.
	 * @param {string} projectRoot - The root directory of the project.
	 * @param {ProcessUploadFileParams} [processParams] - Optional processing settings including inferers.
	 * @returns {Promise<ProcessedFile>} A promise resolving with the processed file details, including base64 content, relative path, and language code.
	 */
	protected async processFile(
		file: string,
		projectRoot: string,
		processParams?: ProcessUploadFileParams,
	): Promise<ProcessedFile> {
		let relativePath: string;
		try {
			relativePath = processParams?.filenameInferer
				? await processParams.filenameInferer(file)
				: "";
			if (!relativePath.trim()) {
				throw new Error("Invalid filename: empty or only whitespace");
			}
		} catch {
			const toPosixPath = (p: string) => p.split(path.sep).join(path.posix.sep);
			relativePath = path.posix.relative(
				toPosixPath(projectRoot),
				toPosixPath(file),
			);
		}

		let languageCode: string;
		try {
			languageCode = processParams?.languageInferer
				? await processParams.languageInferer(file)
				: "";
			if (!languageCode.trim()) {
				throw new Error("Invalid language code: empty or only whitespace");
			}
		} catch {
			const baseName = path.basename(relativePath);
			languageCode = baseName.split(".").slice(-2, -1)[0] ?? "unknown";
		}

		const fileContent = await fs.promises.readFile(file);

		return {
			data: fileContent.toString("base64"),
			filename: relativePath,
			lang_iso: languageCode,
		};
	}

	/**
	 * Uploads files in parallel with a limit on the number of concurrent uploads.
	 *
	 * @param {string[]} files - List of file paths to upload.
	 * @param {Partial<UploadFileParams>} baseUploadFileParams - Base parameters for uploads.
	 * @param {ProcessUploadFileParams} [processParams] - Optional processing settings including inferers.
	 * @returns {Promise<{ processes: QueuedProcess[]; errors: FileUploadError[] }>} A promise resolving with successful processes and upload errors.
	 */
	private async parallelUpload(
		files: string[],
		baseUploadFileParams: PartialUploadFileParams = {},
		processParams?: ProcessUploadFileParams,
	): Promise<QueuedUploadProcessesWithErrors> {
		const projectRoot = process.cwd();
		const queuedProcesses: QueuedProcess[] = [];
		const errors: FileUploadError[] = [];
		const fileQueue = [...files];

		const pool = new Array(LokaliseUpload.maxConcurrentProcesses)
			.fill(null)
			.map(() =>
				(async () => {
					while (fileQueue.length > 0) {
						const file = fileQueue.shift();
						if (!file) {
							break;
						}

						try {
							const processedFileParams = await this.processFile(
								file,
								projectRoot,
								processParams,
							);
							const queuedProcess = await this.uploadSingleFile({
								...baseUploadFileParams,
								...processedFileParams,
							});
							queuedProcesses.push(queuedProcess);
						} catch (error) {
							errors.push({ file, error });
						}
					}
				})(),
			);

		await Promise.all(pool);
		return { processes: queuedProcesses, errors };
	}

	/**
	 * Normalizes an array of file extensions by ensuring each starts with a dot and is lowercase.
	 *
	 * @param extensions - The list of file extensions to normalize.
	 * @returns A new array with normalized file extensions.
	 */
	private normalizeExtensions(extensions: string[]): string[] {
		return extensions.map((ext) =>
			(ext.startsWith(".") ? ext : `.${ext}`).toLowerCase(),
		);
	}

	/**
	 * Determines whether a file should be collected based on its extension and name pattern.
	 *
	 * @param entry - The directory entry to evaluate.
	 * @param normalizedExtensions - List of allowed file extensions.
	 * @param fileNameRegex - Regular expression to match valid filenames.
	 * @returns `true` if the file matches both extension and name pattern, otherwise `false`.
	 */
	private shouldCollectFile(
		entry: fs.Dirent,
		normalizedExtensions: string[],
		fileNameRegex: RegExp,
	): boolean {
		const fileExt = path.extname(entry.name).toLowerCase();
		const matchesExtension =
			normalizedExtensions.includes(".*") ||
			normalizedExtensions.includes(fileExt);
		const matchesFilenamePattern = fileNameRegex.test(entry.name);

		return matchesExtension && matchesFilenamePattern;
	}

	/**
	 * Creates a regular expression from a given pattern string or RegExp.
	 *
	 * @param fileNamePattern - The filename pattern to convert into a RegExp.
	 * @returns A valid RegExp object.
	 * @throws {Error} If the pattern string is invalid and cannot be compiled.
	 */
	private makeFilenameRegexp(fileNamePattern: string | RegExp): RegExp {
		try {
			return new RegExp(fileNamePattern);
		} catch {
			throw new Error(`Invalid fileNamePattern: ${fileNamePattern}`);
		}
	}

	/**
	 * Converts an array of exclude patterns into an array of RegExp objects.
	 *
	 * @param excludePatterns - An array of strings or regular expressions to exclude.
	 * @returns An array of compiled RegExp objects.
	 * @throws {Error} If any pattern is invalid and cannot be compiled.
	 */
	private makeExcludeRegExes(excludePatterns: string[] | RegExp[]): RegExp[] {
		if (excludePatterns.length === 0) {
			return [];
		}
		try {
			return excludePatterns.map((pattern) => new RegExp(pattern));
		} catch (err) {
			throw new Error(`Invalid excludePatterns: ${err}`);
		}
	}

	/**
	 * Safely reads the contents of a directory, returning an empty array if access fails.
	 *
	 * Logs a warning if the directory cannot be read (e.g. due to permissions or non-existence).
	 *
	 * @param dir - The directory path to read.
	 * @returns A promise that resolves to an array of directory entries, or an empty array on failure.
	 */
	private async safeReadDir(dir: string): Promise<fs.Dirent[]> {
		try {
			return await fs.promises.readdir(dir, { withFileTypes: true });
		} catch {
			this.logMsg("warn", `Skipping inaccessible directory: ${dir}...`);
			return [];
		}
	}

	/**
	 * Checks if a file path matches any of the provided exclusion patterns.
	 *
	 * @param filePath - The path of the file to check.
	 * @param excludeRegexes - An array of RegExp patterns to test against.
	 * @returns `true` if the file path matches any exclude pattern, otherwise `false`.
	 */
	private shouldExclude(filePath: string, excludeRegexes: RegExp[]): boolean {
		return excludeRegexes.some((regex) => regex.test(filePath));
	}

	/**
	 * Creates a queue of absolute paths from the provided input directories.
	 *
	 * @param inputDirs - An array of input directory paths (relative or absolute).
	 * @returns An array of resolved absolute directory paths.
	 */
	private makeQueue(inputDirs: string[]): string[] {
		return [...inputDirs.map((dir) => path.resolve(dir))];
	}

	/**
	 * Processes a queue of directories to collect files matching given criteria.
	 *
	 * Recursively reads directories (if enabled), filters files by extension,
	 * filename pattern, and exclusion rules, and collects matching file paths.
	 *
	 * @param queue - The list of directories to process.
	 * @param exts - Allowed file extensions (normalized).
	 * @param nameRx - Regular expression to match valid filenames.
	 * @param excludeRx - Array of exclusion patterns.
	 * @param recursive - Whether to traverse subdirectories.
	 * @returns A promise that resolves to an array of matched file paths.
	 */
	private async processCollectionQueue(
		queue: string[],
		exts: string[],
		nameRx: RegExp,
		excludeRx: RegExp[],
		recursive: boolean,
	): Promise<string[]> {
		const found: string[] = [];

		while (queue.length) {
			const dir = queue.shift();
			if (!dir) {
				continue;
			}

			const entries = await this.safeReadDir(dir);
			for (const entry of entries) {
				const fullPath = path.resolve(dir, entry.name);
				this.handleEntry(entry, fullPath, queue, found, {
					exts,
					nameRx,
					excludeRx,
					recursive,
				});
			}
		}
		return found;
	}

	/**
	 * Handles a single directory entry during file collection.
	 *
	 * Applies exclusion rules, optionally queues directories for recursion,
	 * and collects files that match the specified extension and filename pattern.
	 *
	 * @param entry - The directory entry to handle.
	 * @param fullPath - The absolute path to the entry.
	 * @param queue - The processing queue for directories.
	 * @param found - The list to store matched file paths.
	 * @param opts - Options including extensions, name pattern, exclusions, and recursion flag.
	 */
	private handleEntry(
		entry: fs.Dirent,
		fullPath: string,
		queue: string[],
		found: string[],
		opts: {
			exts: string[];
			nameRx: RegExp;
			excludeRx: RegExp[];
			recursive: boolean;
		},
	): void {
		if (this.shouldExclude(fullPath, opts.excludeRx)) {
			return;
		}

		if (entry.isDirectory()) {
			if (opts.recursive) {
				queue.push(fullPath);
			}
			return;
		}

		if (
			entry.isFile() &&
			this.shouldCollectFile(entry, opts.exts, opts.nameRx)
		) {
			found.push(fullPath);
		}
	}
}
