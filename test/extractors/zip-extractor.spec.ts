import {
	lstat,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { unpackZip } from "../../lib/extractors/zip-extractor.js";
import {
	createZip,
	type ZipFixtureEntry,
} from "../fixtures/zip-files/create-zip.js";
import { afterEach, beforeEach, describe, expect, it } from "../setup.js";

const MiB = 1024 * 1024;

describe("unpackZip()", () => {
	let sandbox: string;
	let archivePath: string;
	let outputDir: string;

	beforeEach(async () => {
		sandbox = await mkdtemp(path.join(tmpdir(), "lokalise-zip-test-"));
		archivePath = path.join(sandbox, "archive.zip");
		outputDir = path.join(sandbox, "output");
	});

	afterEach(async () => {
		await rm(sandbox, { recursive: true, force: true });
	});

	async function archive(entries: readonly ZipFixtureEntry[]): Promise<void> {
		await writeFile(archivePath, createZip(entries));
	}

	async function tempFiles(directory: string): Promise<string[]> {
		return (await readdir(directory)).filter(
			(name) => name.startsWith(".lokalise-") && name.endsWith(".tmp"),
		);
	}

	describe("successful extraction", () => {
		it("extracts stored and deflated entries into nested directories", async () => {
			await archive([
				{ name: "locales/", unixMode: 0o040755 },
				{ name: "locales/en.json", data: '{"hello":"Hi"}', unixMode: 0o100644 },
				{
					name: "locales/fr.json",
					data: '{"hello":"Salut"}',
					compression: "deflate",
				},
			]);

			await unpackZip(archivePath, outputDir);

			expect(
				await readFile(path.join(outputDir, "locales/en.json"), "utf8"),
			).toBe('{"hello":"Hi"}');
			expect(
				await readFile(path.join(outputDir, "locales/fr.json"), "utf8"),
			).toBe('{"hello":"Salut"}');
			expect(await tempFiles(path.join(outputDir, "locales"))).toEqual([]);
		});

		it("creates the output directory for an empty archive", async () => {
			await archive([]);
			await unpackZip(archivePath, outputDir);
			expect(await readdir(outputDir)).toEqual([]);
		});

		it("creates parent directories without explicit directory entries", async () => {
			await archive([{ name: "a/b/c.txt", data: "hello" }]);
			await unpackZip(archivePath, outputDir);
			expect(await readFile(path.join(outputDir, "a/b/c.txt"), "utf8")).toBe(
				"hello",
			);
		});

		it("normalizes backslash separators in ZIP filenames", async () => {
			// yauzl supports ZIPs created by older Windows archivers.
			await archive([{ name: "win\\nested\\file.txt", data: "works" }]);
			await unpackZip(archivePath, outputDir);
			expect(
				await readFile(path.join(outputDir, "win/nested/file.txt"), "utf8"),
			).toBe("works");
		});

		it("replaces an existing file only after successful extraction", async () => {
			await mkdir(outputDir);
			await writeFile(path.join(outputDir, "data.txt"), "old");
			await archive([{ name: "data.txt", data: "new" }]);

			await unpackZip(archivePath, outputDir);

			expect(await readFile(path.join(outputDir, "data.txt"), "utf8")).toBe(
				"new",
			);
			expect(await tempFiles(outputDir)).toEqual([]);
		});

		it("accepts an output directory passed through a symlink", async (ctx) => {
			const realOutput = path.join(sandbox, "real-output");
			await mkdir(realOutput);
			try {
				await symlink(realOutput, outputDir, "dir");
			} catch (error) {
				if (isSymlinkUnavailable(error)) {
					ctx.skip();
					return;
				}
				throw error;
			}
			await archive([{ name: "ok.txt", data: "hello" }]);
			await unpackZip(archivePath, outputDir);
			expect(await readFile(path.join(realOutput, "ok.txt"), "utf8")).toBe(
				"hello",
			);
		});
	});

	describe("ZIP paths and duplicate entries", () => {
		it.each([
			"../outside.txt",
			"../../outside.txt",
			"/absolute.txt",
			"C:/outside.txt",
			"C:outside.txt",
			"sub/../../outside.txt",
			"sub\\..\\outside.txt",
			"evil\0name.txt",
		])("rejects unsafe entry name %j", async (name) => {
			await archive([{ name, data: "attack" }]);
			await expect(unpackZip(archivePath, outputDir)).rejects.toThrow();
			await expect(
				readFile(path.join(sandbox, "outside.txt")),
			).rejects.toThrow();
		});

		it("rejects duplicate files instead of silently overwriting", async () => {
			await archive([
				{ name: "same.txt", data: "first" },
				{ name: "same.txt", data: "second" },
			]);
			await expect(unpackZip(archivePath, outputDir)).rejects.toThrow(
				/Duplicate ZIP entry/,
			);
			expect(await readFile(path.join(outputDir, "same.txt"), "utf8")).toBe(
				"first",
			);
		});

		it("rejects a file when its parent is already a regular file", async () => {
			await archive([
				{ name: "folder", data: "not a directory" },
				{ name: "folder/child.txt", data: "nope" },
			]);
			await expect(unpackZip(archivePath, outputDir)).rejects.toThrow(
				/Unsafe extraction directory/,
			);
		});

		it("rejects directory entries that collide with existing files", async () => {
			await mkdir(outputDir);
			await writeFile(path.join(outputDir, "folder"), "existing");
			await archive([{ name: "folder/" }]);
			await expect(unpackZip(archivePath, outputDir)).rejects.toThrow(
				/Unsafe extraction directory/,
			);
		});
	});

	describe("symlink and UNIX file metadata", () => {
		it("rejects symbolic links declared in ZIP metadata", async () => {
			await archive([
				{
					name: "link",
					data: "../outside.txt",
					unixMode: 0o120777,
				},
			]);
			await expect(unpackZip(archivePath, outputDir)).rejects.toThrow(
				/Unsupported ZIP entry type/,
			);
			await expect(lstat(path.join(outputDir, "link"))).rejects.toThrow();
		});

		it("rejects special UNIX files", async () => {
			await archive([{ name: "named-pipe", unixMode: 0o010644 }]);
			await expect(unpackZip(archivePath, outputDir)).rejects.toThrow(
				/Unsupported ZIP entry type/,
			);
		});

		it.each([
			{ name: "regular.txt", unixMode: 0o040755 },
			{ name: "folder/", unixMode: 0o100644 },
		])("rejects inconsistent type metadata for $name", async (entry) => {
			await archive([entry]);
			await expect(unpackZip(archivePath, outputDir)).rejects.toThrow(
				/Inconsistent ZIP entry type/,
			);
		});

		it("rejects a pre-existing symlink inside the extraction root", async (ctx) => {
			const outside = path.join(sandbox, "outside");
			await mkdir(outside);
			await mkdir(outputDir);
			try {
				await symlink(outside, path.join(outputDir, "linked"), "dir");
			} catch (error) {
				if (isSymlinkUnavailable(error)) {
					ctx.skip();
					return;
				}
				throw error;
			}
			await archive([{ name: "linked/secret.txt", data: "attack" }]);

			await expect(unpackZip(archivePath, outputDir)).rejects.toThrow(
				/Unsafe extraction directory/,
			);
			await expect(
				readFile(path.join(outside, "secret.txt")),
			).rejects.toThrow();
		});

		it("does not follow an existing symlink at the file destination", async (ctx) => {
			const outside = path.join(sandbox, "important.txt");
			await writeFile(outside, "keep me");
			await mkdir(outputDir);
			try {
				await symlink(outside, path.join(outputDir, "data.txt"), "file");
			} catch (error) {
				if (isSymlinkUnavailable(error)) {
					ctx.skip();
					return;
				}
				throw error;
			}
			await archive([{ name: "data.txt", data: "new data" }]);

			// POSIX rename() replaces the link itself, not its target.
			// Windows replacement semantics can differ; skip this assertion there.
			if (process.platform === "win32") {
				ctx.skip();
				return;
			}
			await unpackZip(archivePath, outputDir);
			expect(await readFile(outside, "utf8")).toBe("keep me");
			expect(await readFile(path.join(outputDir, "data.txt"), "utf8")).toBe(
				"new data",
			);
		});
	});

	describe("limits and corrupted archives", () => {
		it("rejects a single entry exceeding the 100 MiB declared-size limit", async () => {
			await archive([
				{
					name: "huge.txt",
					data: "tiny",
					compression: "deflate",
					declaredSize: 100 * MiB + 1,
				},
			]);
			await expect(unpackZip(archivePath, outputDir)).rejects.toThrow(
				/Invalid or oversized ZIP entry/,
			);
		});

		it("rejects a cumulative declared size exceeding 1 GiB without inflating data", async () => {
			// Directory entries are never streamed. Deflate prevents yauzl from
			// rejecting deliberately mismatched size metadata before our budget check.
			await archive(
				Array.from({ length: 11 }, () => ({
					name: "./",
					compression: "deflate" as const,
					declaredSize: 100 * MiB,
				})),
			);
			await expect(unpackZip(archivePath, outputDir)).rejects.toThrow(
				/maximum extracted size/,
			);
		});

		it("rejects archives with more than 10,000 entries", async () => {
			// Repeated root-directory entries avoid creating 10,000 real files.
			await archive(Array.from({ length: 10_001 }, () => ({ name: "./" })));
			await expect(unpackZip(archivePath, outputDir)).rejects.toThrow(
				/too many entries/,
			);
		}, 30_000);

		it("preserves the old destination and removes temporary files on size mismatch", async () => {
			await mkdir(outputDir);
			await writeFile(path.join(outputDir, "data.txt"), "old data");
			await archive([
				{
					name: "data.txt",
					data: "new payload longer than claimed size",
					compression: "deflate",
					declaredSize: 1,
				},
			]);

			await expect(unpackZip(archivePath, outputDir)).rejects.toThrow();
			expect(await readFile(path.join(outputDir, "data.txt"), "utf8")).toBe(
				"old data",
			);
			expect(await tempFiles(outputDir)).toEqual([]);
		});

		it("removes a temporary file if replacing the destination fails", async () => {
			await mkdir(outputDir);
			await mkdir(path.join(outputDir, "already-a-directory"));
			await archive([
				{ name: "already-a-directory", data: "cannot overwrite directory" },
			]);

			await expect(unpackZip(archivePath, outputDir)).rejects.toThrow();
			expect(await tempFiles(outputDir)).toEqual([]);
			expect(
				(
					await lstat(path.join(outputDir, "already-a-directory"))
				).isDirectory(),
			).toBe(true);
		});

		it("rejects corrupted or truncated ZIP files", async () => {
			await writeFile(archivePath, Buffer.from("not a ZIP"));
			await expect(unpackZip(archivePath, outputDir)).rejects.toThrow();
		});

		it("rejects missing archives", async () => {
			await expect(unpackZip(archivePath, outputDir)).rejects.toThrow();
		});
	});
});

function isSymlinkUnavailable(error: unknown): boolean {
	return (
		error instanceof Error &&
		"code" in error &&
		["EPERM", "EACCES", "ENOTSUP", "ENOSYS"].includes(String(error.code))
	);
}
