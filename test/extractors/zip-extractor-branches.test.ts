import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { vi } from "vitest";
import { unpackZip } from "../../lib/extractors/zip-extractor.js";
import { afterEach, beforeEach, describe, expect, it } from "../setup.js";

// A separate test file intentionally bypasses yauzl's own validations.
// These tests exercise our extractor's defensive fallback branches.
const mocks = vi.hoisted(() => ({
	openPromise: vi.fn(),
	failMkdirAt: { path: "" },
}));

vi.mock("yauzl", () => ({
	default: { openPromise: mocks.openPromise },
}));

vi.mock("node:fs/promises", async (importOriginal) => {
	const realFs = await importOriginal<typeof import("node:fs/promises")>();

	return {
		...realFs,
		mkdir: async (directory: string, options?: { recursive?: boolean }) => {
			if (directory === mocks.failMkdirAt.path) {
				throw Object.assign(new Error("Permission denied"), {
					code: "EACCES",
				});
			}
			return realFs.mkdir(directory, options);
		},
	};
});

describe("unpackZip(): defensive branches", () => {
	let sandbox: string;
	let outputDir: string;

	beforeEach(async () => {
		sandbox = await mkdtemp(path.join(tmpdir(), "lokalise-zip-branches-"));
		outputDir = path.join(sandbox, "output");
	});

	afterEach(async () => {
		mocks.openPromise.mockReset();
		mocks.failMkdirAt.path = "";
		await rm(sandbox, { recursive: true, force: true });
	});

	// Fake only the yauzl interface used by unpackZip().
	// This lets us test defensive branches normally intercepted by yauzl itself.
	function mockZipEntry(
		filename: string,
		declaredSize: number,
		chunks: Buffer[] = [],
	) {
		const entry = {
			fileName: filename,
			uncompressedSize: declaredSize,
			versionMadeBy: 20,
			externalFileAttributes: 0,
		};

		const openReadStreamPromise = vi.fn(async () => Readable.from(chunks));
		const close = vi.fn();

		mocks.openPromise.mockResolvedValue({
			async *eachEntry() {
				yield entry;
			},
			openReadStreamPromise,
			close,
		});

		return { openReadStreamPromise, close };
	}

	it("rejects an entry escaping the root in the path.relative guard", async () => {
		const zip = mockZipEntry("../outside.txt", 1);

		await expect(unpackZip("mock.zip", outputDir)).rejects.toThrow(
			"Malicious ZIP entry: ../outside.txt",
		);

		expect(zip.openReadStreamPromise).not.toHaveBeenCalled();
		expect(zip.close).toHaveBeenCalledOnce();
	});

	it("rejects oversized streamed content and cleans up the temporary file", async () => {
		const zip = mockZipEntry("data.txt", 1, [Buffer.from("too much data")]);

		await expect(unpackZip("mock.zip", outputDir)).rejects.toThrow(
			"ZIP entry exceeds size limit: data.txt",
		);

		expect(zip.openReadStreamPromise).toHaveBeenCalledOnce();
		expect(await readdir(outputDir)).toEqual([]);
		expect(zip.close).toHaveBeenCalledOnce();
	});

	it("propagates mkdir errors other than EEXIST", async () => {
		const zip = mockZipEntry("blocked/data.txt", 4);
		mocks.failMkdirAt.path = path.join(outputDir, "blocked");

		await expect(unpackZip("mock.zip", outputDir)).rejects.toMatchObject({
			code: "EACCES",
			message: "Permission denied",
		});

		expect(zip.openReadStreamPromise).not.toHaveBeenCalled();
		expect(zip.close).toHaveBeenCalledOnce();
	});
});
