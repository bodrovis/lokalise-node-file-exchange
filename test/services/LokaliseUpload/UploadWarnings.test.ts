import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { QueuedProcess } from "@lokalise/node-api";
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher } from "undici";
import { LokaliseUpload } from "../../../lib/services/LokaliseUpload.js";
import { afterEach, describe, expect, it, vi } from "../../setup.js";

const apiKey = "test-api-key";
const projectId = "803826145ba90b42d5d860.46800099";

type LoggableUpload = {
	logMsg: (level: string, message: string, error?: unknown) => void;
};

type PollableUpload = {
	pollUploadedProcesses: (
		processes: QueuedProcess[],
		initialWaitTime: number,
		maxWaitTime: number,
	) => Promise<QueuedProcess[]>;
};

describe("LokaliseUpload: warning forwarding", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("forwards collector warnings to logMsg()", async () => {
		const root = await fs.promises.mkdtemp(
			path.join(os.tmpdir(), "lokalise-upload-warning-"),
		);
		const nested = path.join(root, "nested");

		try {
			await fs.promises.mkdir(nested);

			const readError = Object.assign(new Error("Access denied"), {
				code: "EACCES",
			});
			const realReaddir = fs.promises.readdir.bind(fs.promises);

			vi.spyOn(fs.promises, "readdir").mockImplementation(((
				dir: string,
				options: { withFileTypes: true },
			) =>
				dir === nested
					? Promise.reject(readError)
					: realReaddir(dir, options)) as typeof fs.promises.readdir);

			const uploader = new LokaliseUpload({ apiKey }, { projectId });
			const logSpy = vi
				.spyOn(uploader as unknown as LoggableUpload, "logMsg")
				.mockImplementation(() => {});

			await uploader.uploadTranslations({
				collectFileParams: { inputDirs: [root], recursive: true },
			});

			expect(logSpy).toHaveBeenCalledWith(
				"warn",
				`Skipping inaccessible directory: ${nested}`,
				readError,
			);
		} finally {
			vi.restoreAllMocks();
			await fs.promises.rm(root, { recursive: true, force: true });
		}
	});

	it("forwards recoverable polling errors to logMsg()", async () => {
		const processId = "queued-upload-123";
		const processPath = `/api2/projects/${projectId}/processes/${processId}`;
		const previousDispatcher = getGlobalDispatcher();
		const agent = new MockAgent();

		agent.disableNetConnect();
		const pool = agent.get("https://api.lokalise.com");
		setGlobalDispatcher(agent);

		try {
			pool.intercept({ method: "GET", path: processPath }).reply(429, {
				code: 429,
				message: "Too Many Requests",
			});

			// queuedProcesses().get() expects the `process` wrapper.
			pool.intercept({ method: "GET", path: processPath }).reply(200, {
				process: {
					process_id: processId,
					type: "file-upload",
					status: "finished",
				},
			});

			const uploader = new LokaliseUpload({ apiKey }, { projectId });
			const logSpy = vi
				.spyOn(uploader as unknown as LoggableUpload, "logMsg")
				.mockImplementation(() => {});

			const queued = {
				process_id: processId,
				type: "file-upload",
				status: "queued",
			} as QueuedProcess;

			const result = await (
				uploader as unknown as PollableUpload
			).pollUploadedProcesses([queued], 1, 2_000);

			expect(result[0]?.status).toBe("finished");
			expect(logSpy).toHaveBeenCalledWith(
				"warn",
				`Failed to fetch process ${processId}:`,
				expect.objectContaining({ code: 429 }),
			);
			agent.assertNoPendingInterceptors();
		} finally {
			setGlobalDispatcher(previousDispatcher);
			await agent.close();
		}
	});
});
