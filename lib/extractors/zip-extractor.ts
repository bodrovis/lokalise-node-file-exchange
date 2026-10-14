import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { lstat, mkdir, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import yauzl from "yauzl";
import { LokaliseError } from "../errors/LokaliseError.js";

const MAX_ENTRIES = 10_000;
const MAX_ENTRY_BYTES = 100 * 1024 * 1024;
const MAX_TOTAL_BYTES = 1024 * 1024 * 1024;

/**
 * Extracts a ZIP archive into the specified directory.
 *
 * Validates entry paths, limits decompressed data,
 * and processes entries sequentially.
 */
export async function unpackZip(
	zipFilePath: string,
	outputDir: string,
): Promise<void> {
	const zipfile = await yauzl.openPromise(zipFilePath, {
		autoClose: true,
		validateEntrySizes: true,
	});

	try {
		await mkdir(outputDir, { recursive: true });

		// Resolve the caller-supplied output directory once.
		const root = await realpath(outputDir);

		const seenFiles = new Set<string>();
		let entryCount = 0;
		let totalBytes = 0;

		for await (const entry of zipfile.eachEntry()) {
			if (++entryCount > MAX_ENTRIES) {
				throw new LokaliseError("ZIP contains too many entries.");
			}

			if (
				!Number.isSafeInteger(entry.uncompressedSize) ||
				entry.uncompressedSize < 0 ||
				entry.uncompressedSize > MAX_ENTRY_BYTES
			) {
				throw new LokaliseError(
					`Invalid or oversized ZIP entry: ${entry.fileName}`,
				);
			}

			totalBytes += entry.uncompressedSize;

			if (totalBytes > MAX_TOTAL_BYTES) {
				throw new LokaliseError("ZIP exceeds maximum extracted size.");
			}

			await extractZipEntry(entry, zipfile, root, seenFiles);
		}
	} finally {
		zipfile.close();
	}
}

/**
 * Validates and extracts a ZIP entry.
 *
 * Handles directories, rejects duplicate files, and delegates
 * file extraction to a dedicated function.
 */
async function extractZipEntry(
	entry: yauzl.Entry,
	zipfile: yauzl.ZipFile,
	root: string,
	seenFiles: Set<string>,
): Promise<void> {
	const destination = resolveZipEntryPath(root, entry.fileName);
	const isDirectory = entry.fileName.endsWith("/");

	validateZipEntryType(entry, isDirectory);

	if (isDirectory) {
		await ensureSafeDirectory(root, destination);
		return;
	}

	const key =
		process.platform === "win32" ? destination.toLowerCase() : destination;

	if (seenFiles.has(key)) {
		throw new LokaliseError(`Duplicate ZIP entry: ${entry.fileName}`);
	}

	seenFiles.add(key);

	await ensureSafeDirectory(root, path.dirname(destination));
	await writeZipEntry(entry, zipfile, destination);
}

/**
 * Rejects symbolic links, special files, and inconsistent
 * UNIX file types in ZIP entries.
 */
function validateZipEntryType(entry: yauzl.Entry, isDirectory: boolean): void {
	// UNIX-created ZIP entries.
	if (entry.versionMadeBy >>> 8 !== 3) return;

	const mode = entry.externalFileAttributes >>> 16;
	const fileType = mode & 0o170000;

	const isRegularFile = fileType === 0o100000;
	const isUnixDirectory = fileType === 0o040000;

	if (fileType !== 0 && !isRegularFile && !isUnixDirectory) {
		throw new LokaliseError(`Unsupported ZIP entry type: ${entry.fileName}`);
	}

	if ((isUnixDirectory && !isDirectory) || (isRegularFile && isDirectory)) {
		throw new LokaliseError(`Inconsistent ZIP entry type: ${entry.fileName}`);
	}
}

/**
 * Extracts an entry into a temporary file and replaces
 * the destination only after successful extraction.
 */
async function writeZipEntry(
	entry: yauzl.Entry,
	zipfile: yauzl.ZipFile,
	destination: string,
): Promise<void> {
	const tempFile = path.join(
		path.dirname(destination),
		`.lokalise-${randomUUID()}.tmp`,
	);

	try {
		const readStream = await zipfile.openReadStreamPromise(entry);

		await pipeline(
			readStream,
			createSizeLimiter(entry),
			createWriteStream(tempFile, {
				flags: "wx",
				mode: 0o600,
			}),
		);

		await rename(tempFile, destination);
	} finally {
		await rm(tempFile, { force: true });
	}
}

/**
 * Creates a stream transform that rejects ZIP entries
 * exceeding their declared or configured size limits.
 */
function createSizeLimiter(entry: yauzl.Entry): Transform {
	let bytesRead = 0;

	return new Transform({
		transform(chunk: Buffer, _encoding, callback) {
			bytesRead += chunk.length;

			if (bytesRead > entry.uncompressedSize || bytesRead > MAX_ENTRY_BYTES) {
				callback(
					new LokaliseError(`ZIP entry exceeds size limit: ${entry.fileName}`),
				);
				return;
			}

			callback(null, chunk);
		},
	});
}

/**
 * Ensures that a ZIP entry stays within the extraction root.
 */
function resolveZipEntryPath(root: string, filename: string): string {
	if (
		filename.includes("\0") ||
		path.posix.isAbsolute(filename) ||
		path.win32.isAbsolute(filename) ||
		/^[A-Za-z]:/.test(filename)
	) {
		throw new LokaliseError(`Malicious ZIP entry: ${filename}`);
	}

	const destination = path.resolve(root, filename);
	const relative = path.relative(root, destination);

	if (
		relative === ".." ||
		relative.startsWith(`..${path.sep}`) ||
		path.isAbsolute(relative)
	) {
		throw new LokaliseError(`Malicious ZIP entry: ${filename}`);
	}

	return destination;
}

/**
 * Creates directories while rejecting symbolic links
 * within the extraction root.
 */
async function ensureSafeDirectory(
	root: string,
	directory: string,
): Promise<void> {
	const relative = path.relative(root, directory);

	if (!relative) return;

	let current = root;

	for (const segment of relative.split(path.sep)) {
		current = path.join(current, segment);

		try {
			await mkdir(current);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
				throw error;
			}
		}

		const stat = await lstat(current);

		if (!stat.isDirectory() || stat.isSymbolicLink()) {
			throw new LokaliseError(`Unsafe extraction directory: ${current}`);
		}
	}
}
