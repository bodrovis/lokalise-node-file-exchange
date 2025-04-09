import fs from "node:fs";
import path from "node:path";
import type { QueuedProcess, UploadFileParams } from "@lokalise/node-api";
import type {
	CollectFileParams,
	FileUploadError,
	PartialUploadFileParams,
	ProcessUploadFileParams,
	ProcessedFile,
	QueuedUploadProcessesWithErrors,
	UploadTranslationParams,
} from "../interfaces/index.js";
import { LokaliseFileExchange } from "./LokaliseFileExchange.js";

/**
 * Handles uploading translation files to Lokalise.
 */
export class LokaliseUpload extends LokaliseFileExchange {
	private readonly maxConcurrentProcesses = 6;

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
		const { pollStatuses, pollInitialWaitTime, pollMaximumWaitTime } = {
			...LokaliseUpload.defaultPollingParams,
			...processUploadFileParams,
		};

		const collectedFiles = await this.collectFiles(collectFileParams);

		const { processes, errors } = await this.parallelUpload(
			collectedFiles,
			uploadFileParams,
			processUploadFileParams,
		);

		let completedProcesses = processes;

		if (pollStatuses) {
			completedProcesses = await this.pollProcesses(
				processes,
				pollInitialWaitTime,
				pollMaximumWaitTime,
			);
		}

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
		const collectedFiles: string[] = [];
		const queue: string[] = [...inputDirs.map((dir) => path.resolve(dir))];

		const normalizedExtensions = extensions.map((ext) =>
			ext.startsWith(".") ? ext : `.${ext}`,
		);

		let fileNameRegex: RegExp;
		try {
			fileNameRegex = new RegExp(fileNamePattern);
		} catch {
			throw new Error(`Invalid fileNamePattern: ${fileNamePattern}`);
		}

		let excludeRegexes: RegExp[] = [];
		try {
			excludeRegexes = excludePatterns.map((pattern) => new RegExp(pattern));
		} catch (err) {
			throw new Error(`Invalid excludePatterns: ${err}`);
		}

		while (queue.length > 0) {
			const dir = queue.shift();
			if (!dir) {
				continue;
			}

			let entries: fs.Dirent[];
			try {
				entries = await fs.promises.readdir(dir, { withFileTypes: true });
			} catch {
				console.warn(`Skipping inaccessible directory: ${dir}`);
				continue;
			}

			for (const entry of entries) {
				const fullPath = path.resolve(dir, entry.name);

				if (excludeRegexes.some((regex) => regex.test(fullPath))) {
					continue;
				}

				if (entry.isDirectory() && recursive) {
					queue.push(fullPath);
				} else if (entry.isFile()) {
					const fileExt = path.extname(entry.name);
					const matchesExtension =
						normalizedExtensions.includes(".*") ||
						normalizedExtensions.includes(fileExt);
					const matchesFilenamePattern = fileNameRegex.test(entry.name);

					if (matchesExtension && matchesFilenamePattern) {
						collectedFiles.push(fullPath);
					}
				}
			}
		}

		return collectedFiles.sort(); // Ensure deterministic output
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
			languageCode = path.parse(path.basename(relativePath)).name;
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

		const pool = new Array(this.maxConcurrentProcesses).fill(null).map(() =>
			(async () => {
				while (files.length > 0) {
					const file = files.shift();
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
}
