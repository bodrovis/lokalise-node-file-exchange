import fs from "node:fs";
import path from "node:path";
import type { CollectFileParams } from "../interfaces/index.js";

interface CollectorOptions {
	onWarning?: (message: string, error: unknown) => void;
}

interface FileFilters {
	extensions: ReadonlySet<string>;
	nameRegex: RegExp;
	excludeRegexes: RegExp[];
	recursive: boolean;
}

interface QueuedDirectory {
	path: string;
	isRoot: boolean;
}

const SKIPPABLE_ERRORS = new Set(["ENOENT", "EACCES", "EPERM", "ENOTDIR"]);

/**
 * Collects matching files from one or more directories.
 *
 * Returns unique absolute paths in sorted order.
 * Symbolic links are not followed during recursive traversal.
 */
export async function collectFiles(
	{
		inputDirs = ["./locales"],
		extensions = [".*"],
		excludePatterns = [],
		recursive = true,
		fileNamePattern = ".*",
	}: CollectFileParams = {},
	options: CollectorOptions = {},
): Promise<string[]> {
	const filters: FileFilters = {
		extensions: new Set(
			extensions.map((ext) =>
				(ext.startsWith(".") ? ext : `.${ext}`).toLowerCase(),
			),
		),
		nameRegex: compileRegex(fileNamePattern, "fileNamePattern"),
		excludeRegexes: excludePatterns.map((pattern) =>
			compileRegex(pattern, "excludePatterns"),
		),
		recursive,
	};

	return walkDirectories(inputDirs, filters, options);
}

/**
 * Traverses directories using a queue and collects matching files.
 */
async function walkDirectories(
	inputDirs: string[],
	filters: FileFilters,
	options: CollectorOptions,
): Promise<string[]> {
	const queue: QueuedDirectory[] = inputDirs.map((dir) => ({
		path: path.resolve(dir),
		isRoot: true,
	}));

	const visited = new Set<string>();
	const found = new Set<string>();

	for (const { path: dir, isRoot } of queue) {
		if (visited.has(dir)) continue;
		visited.add(dir);

		const entries = await readDirectory(dir, isRoot, options);

		for (const entry of entries) {
			const fullPath = path.resolve(dir, entry.name);

			if (shouldExclude(fullPath, filters.excludeRegexes)) {
				continue;
			}

			if (entry.isDirectory()) {
				if (filters.recursive) {
					queue.push({ path: fullPath, isRoot: false });
				}
			} else if (entry.isFile() && matchesFile(entry, filters)) {
				found.add(fullPath);
			}
		}
	}

	return [...found].sort();
}

/**
 * Reads a directory, allowing recoverable failures in nested directories.
 * Errors for explicitly requested root directories are always propagated.
 */
async function readDirectory(
	dir: string,
	isRoot: boolean,
	{ onWarning }: CollectorOptions,
): Promise<fs.Dirent[]> {
	try {
		return await fs.promises.readdir(dir, { withFileTypes: true });
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;

		if (!isRoot && code && SKIPPABLE_ERRORS.has(code)) {
			onWarning?.(`Skipping inaccessible directory: ${dir}`, error);
			return [];
		}

		throw new Error(`Failed to read directory: ${dir}`, { cause: error });
	}
}

/**
 * Checks filename and extension filters.
 */
function matchesFile(entry: fs.Dirent, filters: FileFilters): boolean {
	const extension = path.extname(entry.name).toLowerCase();

	return (
		(filters.extensions.has(".*") || filters.extensions.has(extension)) &&
		testRegex(filters.nameRegex, entry.name)
	);
}

/**
 * Checks exclusions against native and POSIX paths.
 */
function shouldExclude(filePath: string, regexes: RegExp[]): boolean {
	const posixPath = filePath.split(path.sep).join("/");

	return regexes.some(
		(regex) => testRegex(regex, filePath) || testRegex(regex, posixPath),
	);
}

/**
 * Compiles a pattern while preserving the original error.
 */
function compileRegex(pattern: string | RegExp, name: string): RegExp {
	try {
		return new RegExp(pattern);
	} catch (error) {
		throw new Error(`Invalid ${name}: ${String(pattern)}`, {
			cause: error,
		});
	}
}

/**
 * Tests a regular expression without retaining lastIndex state.
 */
function testRegex(regex: RegExp, value: string): boolean {
	regex.lastIndex = 0;
	return regex.test(value);
}
