import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export type TestFsTree = {
	[name: string]: string | Buffer | TestFsTree;
};

async function writeTree(root: string, tree: TestFsTree): Promise<void> {
	await mkdir(root, { recursive: true });

	for (const [name, value] of Object.entries(tree)) {
		const target = path.join(root, name);

		if (typeof value === "string" || Buffer.isBuffer(value)) {
			await mkdir(path.dirname(target), { recursive: true });
			await writeFile(target, value);
		} else {
			await writeTree(target, value);
		}
	}
}

export async function createTestFs(tree: TestFsTree = {}) {
	const root = await mkdtemp(
		path.join(tmpdir(), "lokalise-file-exchange-test-"),
	);

	await writeTree(root, tree);

	return {
		root,

		path(...parts: string[]) {
			return path.join(root, ...parts);
		},

		async write(tree: TestFsTree, ...parts: string[]) {
			await writeTree(path.join(root, ...parts), tree);
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
