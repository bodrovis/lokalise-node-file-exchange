import fs from "node:fs/promises";
import path from "node:path";
import { LokaliseError } from "../errors/LokaliseError.js";
import type {
	ProcessedFile,
	ProcessUploadFileParams,
} from "../interfaces/index.js";

/**
 * Prepares a file for uploading to Lokalise.
 *
 * Infers its filename and language code, then reads
 * the contents as a base64-encoded string.
 */
export async function processUploadFile(
	file: string,
	projectRoot: string,
	params?: ProcessUploadFileParams,
): Promise<ProcessedFile> {
	const filename = await inferUploadFilename(file, projectRoot, params);
	const lang_iso = await inferLanguageCode(file, filename, params);
	const data = (await fs.readFile(file)).toString("base64");

	return { data, filename, lang_iso };
}

/**
 * Infers the upload filename using a custom inferer or
 * the path relative to the project root.
 */
async function inferUploadFilename(
	file: string,
	projectRoot: string,
	params?: ProcessUploadFileParams,
): Promise<string> {
	const inferred = await params?.filenameInferer?.(file);

	if (inferred !== undefined) {
		if (typeof inferred !== "string") {
			throw new LokaliseError("filenameInferer must return a string.");
		}

		if (inferred.trim()) {
			return inferred.replaceAll("\\", "/");
		}
	}

	const relative = path.relative(projectRoot, file);

	if (
		!relative ||
		relative === ".." ||
		relative.startsWith(`..${path.sep}`) ||
		path.isAbsolute(relative)
	) {
		throw new LokaliseError(`File is outside the project root: ${file}`);
	}

	return relative.split(path.sep).join("/");
}

/**
 * Infers the language code using a custom inferer or
 * the filename segment before the final extension.
 */
async function inferLanguageCode(
	file: string,
	filename: string,
	params?: ProcessUploadFileParams,
): Promise<string> {
	const inferred = await params?.languageInferer?.(file);

	if (inferred !== undefined) {
		if (typeof inferred !== "string") {
			throw new LokaliseError("languageInferer must return a string.");
		}

		if (inferred.trim()) {
			return inferred;
		}
	}

	const baseName = path.posix.basename(filename);
	const lang = baseName.split(".").at(-2);

	if (!lang?.trim()) {
		throw new LokaliseError(
			`Cannot infer language code from filename: ${filename}`,
		);
	}

	return lang;
}
