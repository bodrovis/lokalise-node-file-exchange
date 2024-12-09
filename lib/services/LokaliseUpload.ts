import fs from "node:fs";
import path from "node:path";
import type { QueuedProcess, UploadFileParams } from "@lokalise/node-api";
import type { CollectFileParams } from "../interfaces/CollectFileParams.js";
import type { FileUploadError } from "../interfaces/FileUploadError.js";
import type { ProcessUploadFileParams } from "../interfaces/ProcessUploadFileParams.js";
import type { ProcessedFile } from "../interfaces/ProcessedFile.js";
import type { UploadTranslationParams } from "../interfaces/UploadTranslationParams.js";
import { LokaliseFileExchange } from "./LokaliseFileExchange.js";

/**
 * Handles uploading translation files to Lokalise.
 */
export class LokaliseUpload extends LokaliseFileExchange {
	private readonly maxConcurrentProcesses = 6;

	/**
	 * Collects files and uploads them to Lokalise, returning both processes and errors.
	 *
	 * @param {UploadTranslationParams} uploadTranslationParams - Parameters for collecting and uploading files.
	 * @returns {Promise<{ processes: QueuedProcess[]; errors: FileUploadError[] }>} A promise resolving with successful processes and upload errors.
	 */
	async uploadTranslations(
		uploadTranslationParams: UploadTranslationParams,
	): Promise<{
		processes: QueuedProcess[];
		errors: FileUploadError[];
	}> {
		const { uploadFileParams, collectFileParams, processUploadFileParams } =
			uploadTranslationParams;

		const collectedFiles = await this.collectFiles(collectFileParams);
		return this.parallelUpload(
			collectedFiles,
			uploadFileParams,
			processUploadFileParams,
		);
	}

	/**
	 * Collects files from the filesystem based on the given parameters.
	 *
	 * @param {CollectFileParams} collectFileParams - Parameters for file collection, including directories, extensions, and patterns.
	 * @returns {Promise<string[]>} A promise resolving with the list of collected file paths.
	 */
	async collectFiles({
		inputDirs = ["./locales"],
		extensions = [".*"],
		excludePatterns = ["node_modules", "dist"],
		recursive = true,
		fileNamePattern = ".*",
	}: CollectFileParams = {}): Promise<string[]> {
		const collectedFiles: string[] = [];

		const traverseDirectory = async (dir: string) => {
			let entries: fs.Dirent[];

			try {
				entries = await fs.promises.readdir(dir, { withFileTypes: true });
			} catch {
				return; // Skip inaccessible directories
			}

			const tasks = entries.map(async (entry) => {
				const fullPath = path.resolve(dir, entry.name);

				if (excludePatterns.some((pattern) => fullPath.includes(pattern))) {
					return;
				}

				if (entry.isDirectory() && recursive) {
					await traverseDirectory(fullPath);
				} else if (entry.isFile()) {
					const fileExt = path.extname(entry.name);
					const matchesExtension = extensions.some(
						(ext) => ext === ".*" || ext === fileExt,
					);
					const matchesPattern = new RegExp(fileNamePattern).test(entry.name);

					if (matchesExtension && matchesPattern) {
						collectedFiles.push(fullPath);
					}
				}
			});

			await Promise.all(tasks); // Wait for all tasks to complete
		};

		const startTasks = inputDirs.map(async (dir) => {
			try {
				const stats = await fs.promises.lstat(dir);
				if (stats.isDirectory()) {
					await traverseDirectory(path.resolve(dir));
				}
			} catch {
				return; // Skip invalid directories
			}
		});

		await Promise.all(startTasks); // Wait for root directories to be processed
		return collectedFiles;
	}

	/**
	 * Uploads files in parallel with a limit on the number of concurrent uploads.
	 *
	 * @param {string[]} files - List of file paths to upload.
	 * @param {Partial<UploadFileParams>} baseUploadFileParams - Base parameters for uploads.
	 * @param {ProcessUploadFileParams} processUploadFileParams - Parameters for processing files before upload.
	 * @returns {Promise<{ processes: QueuedProcess[]; errors: FileUploadError[] }>} A promise resolving with successful processes and upload errors.
	 */
	async parallelUpload(
		files: string[],
		baseUploadFileParams: Partial<UploadFileParams> = {},
		processUploadFileParams: ProcessUploadFileParams = {},
	): Promise<{
		processes: QueuedProcess[];
		errors: FileUploadError[];
	}> {
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
							processUploadFileParams.languageInferer,
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
	 * Uploads a single file to Lokalise.
	 *
	 * @param {UploadFileParams} uploadParams - Parameters for uploading the file.
	 * @returns {Promise<QueuedProcess>} A promise resolving with the upload process details.
	 */
	async uploadSingleFile(
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
	 * @param {(filePath: string) => Promise<string> | string} [languageInferer] - Optional function to infer the language code from the file path. Can be asynchronous.
	 * @returns {Promise<ProcessedFile>} A promise resolving with the processed file details, including base64 content, relative path, and language code.
	 */
	async processFile(
		file: string,
		projectRoot: string,
		languageInferer?: (filePath: string) => Promise<string> | string,
	): Promise<ProcessedFile> {
		const fileContent = await fs.promises.readFile(file);
		const base64Data = fileContent.toString("base64");

		const relativePath = path.posix.relative(
			projectRoot.split(path.sep).join(path.posix.sep),
			file.split(path.sep).join(path.posix.sep),
		);

		let languageCode: string;
		try {
			languageCode = languageInferer ? await languageInferer(file) : "";
			if (!languageCode.trim()) {
				throw new Error("Invalid language code: empty or only whitespace");
			}
		} catch {
			languageCode = path.parse(path.basename(relativePath)).name;
		}

		return {
			data: base64Data,
			filename: relativePath,
			lang_iso: languageCode,
		};
	}
}
