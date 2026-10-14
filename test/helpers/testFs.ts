import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export type TestFsTree = {
	[name: string]: string | Buffer | TestFsTree;
};

/**
 * Resolves a path within the temporary test directory.
 */
function resolveInside(root: string, ...parts: string[]): string {
	const target = path.resolve(root, ...parts);
	const relative = path.relative(root, target);

	if (
		relative === ".." ||
		relative.startsWith(`..${path.sep}`) ||
		path.isAbsolute(relative)
	) {
		throw new Error(`Path is outside the test directory: ${target}`);
	}

	return target;
}

/**
 * Recursively creates directories and files from a tree.
 */
async function writeTree(
	root: string,
	tree: TestFsTree,
	parts: string[] = [],
): Promise<void> {
	const dir = resolveInside(root, ...parts);
	await mkdir(dir, { recursive: true });

	for (const [name, value] of Object.entries(tree)) {
		const nextParts = [...parts, name];
		const target = resolveInside(root, ...nextParts);

		if (typeof value === "string" || Buffer.isBuffer(value)) {
			await mkdir(path.dirname(target), { recursive: true });
			await writeFile(target, value);
		} else {
			await writeTree(root, value, nextParts);
		}
	}
}

/**
 * Creates a temporary filesystem for tests.
 */
export async function createTestFs(tree: TestFsTree = {}) {
	const root = await mkdtemp(
		path.join(tmpdir(), "lokalise-file-exchange-test-"),
	);

	try {
		await writeTree(root, tree);
	} catch (error) {
		await rm(root, { recursive: true, force: true });
		throw error;
	}

	return {
		root,

		path(...parts: string[]) {
			return resolveInside(root, ...parts);
		},

		async write(tree: TestFsTree, ...parts: string[]) {
			await writeTree(root, tree, parts);
		},

		useAsCwd() {
			const previousCwd = process.cwd();

			process.chdir(root);

			return () => {
				process.chdir(previousCwd);
			};
		},

		async cleanup() {
			await rm(root, { recursive: true, force: true });
		},
	};
}

export type TestFs = Awaited<ReturnType<typeof createTestFs>>;
