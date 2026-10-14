import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { collectFiles } from "../../lib/collectors/file-collector.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "../setup.js";

describe("collectFiles()", () => {
	let root: string;

	async function createFile(relativePath: string): Promise<string> {
		const absolutePath = path.join(root, relativePath);
		await fs.promises.mkdir(path.dirname(absolutePath), { recursive: true });
		await fs.promises.writeFile(absolutePath, "fixture");
		return absolutePath;
	}

	function mockDirectoryError(directory: string, code: string): Error {
		const error = Object.assign(new Error(`Simulated ${code}`), { code });
		const realReaddir = fs.promises.readdir.bind(fs.promises);

		// The production collector always calls readdir(path, { withFileTypes: true }).
		// Cast to the overloaded Node API type only at this mock boundary.
		vi.spyOn(fs.promises, "readdir").mockImplementation(((
			target: string,
			options: { withFileTypes: true },
		) => {
			if (target === directory) return Promise.reject(error);
			return realReaddir(target, options);
		}) as typeof fs.promises.readdir);

		return error;
	}

	beforeEach(async () => {
		root = await fs.promises.mkdtemp(
			path.join(os.tmpdir(), "lokalise-file-collector-"),
		);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await fs.promises.rm(root, { recursive: true, force: true });
	});

	it("collects files recursively by default, including hidden and extensionless files", async () => {
		const files = [
			await createFile("en.json"),
			await createFile("README"),
			await createFile(".env"),
			await createFile("nested/fr.json"),
		];

		await expect(collectFiles({ inputDirs: [root] })).resolves.toEqual(
			files.sort(),
		);
	});

	it("normalizes extensions and compares them case-insensitively", async () => {
		const en = await createFile("en.JSON");
		const fr = await createFile("fr.json");
		await createFile("notes.txt");
		await createFile("no-extension");

		await expect(
			collectFiles({ inputDirs: [root], extensions: ["JSON", ".json"] }),
		).resolves.toEqual([en, fr].sort());
	});

	it("returns no files when the extension filter is empty", async () => {
		await createFile("en.json");

		await expect(
			collectFiles({ inputDirs: [root], extensions: [] }),
		).resolves.toEqual([]);
	});

	it("does not descend into child directories when recursive is false", async () => {
		const topLevel = await createFile("en.json");
		await createFile("nested/fr.json");

		await expect(
			collectFiles({ inputDirs: [root], recursive: false }),
		).resolves.toEqual([topLevel]);
	});

	it("matches fileNamePattern against filenames, not complete paths", async () => {
		const en = await createFile("one/messages.json");
		const fr = await createFile("two/messages.json");
		await createFile("two/other.json");

		await expect(
			collectFiles({
				inputDirs: [root],
				fileNamePattern: "^messages\\.json$",
			}),
		).resolves.toEqual([en, fr].sort());
	});

	it("excludes individual files and entire subdirectories", async () => {
		const included = await createFile("nested/keep.json");
		await createFile("nested/ignore.json");
		await createFile("blocked/deep/secret.json");
		await createFile("notes.txt");

		await expect(
			collectFiles({
				inputDirs: [root],
				extensions: ["json"],
				excludePatterns: ["nested/ignore\\.json$", "blocked"],
			}),
		).resolves.toEqual([included]);
	});

	it("resets lastIndex for global regular expressions", async () => {
		const first = await createFile("locale-1.json");
		const second = await createFile("locale-2.json");
		await createFile("other.json");

		await expect(
			collectFiles({
				inputDirs: [root],
				fileNamePattern: /^locale-\d+\.json$/g,
			}),
		).resolves.toEqual([first, second].sort());
	});

	it("deduplicates overlapping input directories and sorts absolute paths", async () => {
		const parentFile = await createFile("top.json");
		const childFile = await createFile("nested/child.json");

		const files = await collectFiles({
			inputDirs: [
				path.join(root, "nested"),
				root,
				path.join(root, "."),
				path.relative(process.cwd(), root),
			],
		});

		expect(files).toEqual([parentFile, childFile].sort());
		expect(new Set(files).size).toBe(files.length);
		expect(files.every((file) => path.isAbsolute(file))).toBe(true);
	});

	it.skipIf(process.platform === "win32")(
		"does not follow file or directory symbolic links",
		async () => {
			const realFile = await createFile("real/en.json");
			await fs.promises.symlink(
				path.join(root, "real"),
				path.join(root, "linked-directory"),
				"dir",
			);
			await fs.promises.symlink(
				realFile,
				path.join(root, "linked-file.json"),
				"file",
			);

			await expect(collectFiles({ inputDirs: [root] })).resolves.toEqual([
				realFile,
			]);
		},
	);

	it("returns an empty array for empty input or empty directories", async () => {
		await expect(collectFiles({ inputDirs: [] })).resolves.toEqual([]);
		await expect(collectFiles({ inputDirs: [root] })).resolves.toEqual([]);
	});

	it("throws for a missing explicitly requested root directory", async () => {
		const missing = path.join(root, "missing");
		const onWarning = vi.fn();

		await expect(
			collectFiles({ inputDirs: [missing] }, { onWarning }),
		).rejects.toMatchObject({
			message: `Failed to read directory: ${missing}`,
			cause: expect.objectContaining({ code: "ENOENT" }),
		});

		expect(onWarning).not.toHaveBeenCalled();
	});

	it("throws when an explicitly requested root is a file", async () => {
		const file = await createFile("en.json");

		await expect(collectFiles({ inputDirs: [file] })).rejects.toMatchObject({
			message: `Failed to read directory: ${file}`,
			cause: expect.objectContaining({ code: "ENOTDIR" }),
		});
	});

	it.each(["ENOENT", "EACCES", "EPERM", "ENOTDIR"])(
		"skips nested directory errors with code %s and emits a warning",
		async (code) => {
			const included = await createFile("good.json");
			const blocked = path.join(root, "blocked");
			await fs.promises.mkdir(blocked);
			const error = mockDirectoryError(blocked, code);
			const onWarning = vi.fn();

			await expect(
				collectFiles({ inputDirs: [root] }, { onWarning }),
			).resolves.toEqual([included]);

			expect(onWarning).toHaveBeenCalledTimes(1);
			expect(onWarning).toHaveBeenCalledWith(
				`Skipping inaccessible directory: ${blocked}`,
				error,
			);
		},
	);

	it("propagates unexpected nested directory errors", async () => {
		const blocked = path.join(root, "blocked");
		await fs.promises.mkdir(blocked);
		const error = mockDirectoryError(blocked, "EIO");
		const onWarning = vi.fn();

		await expect(
			collectFiles({ inputDirs: [root] }, { onWarning }),
		).rejects.toMatchObject({
			message: `Failed to read directory: ${blocked}`,
			cause: error,
		});

		expect(onWarning).not.toHaveBeenCalled();
	});

	it("rejects an invalid filename regular expression with its cause", async () => {
		await expect(
			collectFiles({ inputDirs: [root], fileNamePattern: "[" }),
		).rejects.toMatchObject({
			message: "Invalid fileNamePattern: [",
			cause: expect.any(SyntaxError),
		});
	});

	it("rejects an invalid exclusion regular expression", async () => {
		await expect(
			collectFiles({ inputDirs: [root], excludePatterns: ["("] }),
		).rejects.toMatchObject({
			message: "Invalid excludePatterns: (",
			cause: expect.any(SyntaxError),
		});
	});
});
