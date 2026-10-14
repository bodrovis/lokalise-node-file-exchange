import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { LokaliseError } from "../errors/LokaliseError.js";

const MAX_TIMEOUT_MS = 2_147_483_647;

/**
 * Validates the bundle download timeout.
 * Zero disables the timeout.
 */
export function validateDownloadTimeout(timeout: number): void {
	if (
		!Number.isSafeInteger(timeout) ||
		timeout < 0 ||
		timeout > MAX_TIMEOUT_MS
	) {
		throw new LokaliseError(
			`bundleDownloadTimeout must be an integer between 0 and ${MAX_TIMEOUT_MS}.`,
		);
	}
}

/**
 * Downloads a ZIP bundle into a temporary file.
 *
 * Validates the URL and timeout, removes partial files on failure,
 * and converts download errors into LokaliseError.
 */
export async function downloadBundleZip(
	url: string,
	timeout = 0,
	onWarning?: (message: string, error: unknown) => void,
): Promise<string> {
	validateDownloadTimeout(timeout);

	const bundleURL = parseBundleUrl(url);
	const signal = timeout > 0 ? AbortSignal.timeout(timeout) : undefined;

	const tempZipPath = path.join(tmpdir(), `lokalise-${randomUUID()}.zip`);

	try {
		await fetchZipToDisk(bundleURL, tempZipPath, signal);
		return tempZipPath;
	} catch (error) {
		const normalizedError = normalizeDownloadError(error, signal, timeout);

		await cleanupTempZip(tempZipPath, onWarning);

		throw normalizedError;
	}
}

/**
 * Fetches a ZIP bundle and streams the response body to disk.
 *
 * @throws {LokaliseError} If the HTTP response is unsuccessful
 * or has no body.
 */
async function fetchZipToDisk(
	url: URL,
	destination: string,
	signal?: AbortSignal,
): Promise<void> {
	const response = await fetch(url, signal ? { signal } : undefined);

	if (!response.ok) {
		try {
			await response.body?.cancel();
		} catch {
			// Preserve the original HTTP error.
		}

		throw new LokaliseError(
			`Failed to download ZIP file: ${response.statusText} (${response.status})`,
			response.status,
		);
	}

	if (!response.body) {
		throw new LokaliseError("ZIP response body is missing.");
	}

	await writeZipToDisk(
		response.body as WebReadableStream<Uint8Array>,
		destination,
		signal,
	);
}

/**
 * Removes a temporary ZIP file without masking download errors.
 */
async function cleanupTempZip(
	tempZipPath: string,
	onWarning?: (message: string, error: unknown) => void,
): Promise<void> {
	try {
		await rm(tempZipPath, { force: true });
	} catch (error) {
		try {
			onWarning?.(`Failed to remove temporary ZIP: ${tempZipPath}`, error);
		} catch {
			// Do not mask the original download error.
		}
	}
}

/**
 * Converts download failures into LokaliseError,
 * preserving the original error as its cause.
 */
function normalizeDownloadError(
	error: unknown,
	signal: AbortSignal | undefined,
	timeout: number,
): LokaliseError {
	if (error instanceof LokaliseError) {
		return error;
	}

	if (signal?.aborted && signal.reason?.name === "TimeoutError") {
		const wrapped = new LokaliseError(
			`Bundle download timed out after ${timeout}ms`,
			408,
			{ reason: "timeout" },
		);

		wrapped.cause = error;
		return wrapped;
	}

	const message = error instanceof Error ? error.message : String(error);

	const wrapped = new LokaliseError(
		`Failed to download ZIP bundle: ${message}`,
		500,
		{ reason: "download error" },
	);

	wrapped.cause = error;
	return wrapped;
}

/**
 * Streams a ZIP response body into a temporary file.
 */
async function writeZipToDisk(
	body: WebReadableStream<Uint8Array>,
	destination: string,
	signal?: AbortSignal,
): Promise<void> {
	const readable = Readable.fromWeb(body);

	const writable = createWriteStream(destination, {
		flags: "wx",
		mode: 0o600,
	});

	await pipeline(readable, writable, signal ? { signal } : {});
}

/**
 * Validates the bundle URL protocol.
 */
function parseBundleUrl(value: string): URL {
	let url: URL;

	try {
		url = new URL(value);
	} catch {
		throw new LokaliseError("Invalid bundle download URL.");
	}

	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new LokaliseError("Unsupported bundle URL protocol.");
	}

	return url;
}
