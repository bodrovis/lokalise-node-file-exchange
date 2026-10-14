import { setTimeout as sleep } from "node:timers/promises";
import {
	type LokaliseApi,
	ApiError as LokaliseApiError,
	type QueuedProcess,
} from "@lokalise/node-api";
import { LokaliseError } from "../../lib/errors/LokaliseError.js";
import {
	pollLokaliseProcesses,
	validatePollingParams,
} from "../../lib/processes/poll-lokalise-processes.js";
import { describe, expect, it, vi } from "../setup.js";

const projectId = "123.test";

function processWithStatus(id: string, status?: string): QueuedProcess {
	return {
		process_id: id,
		type: "async-export",
		...(status === undefined ? {} : { status }),
	} as QueuedProcess;
}

/** Only the SDK method used by the poller is stubbed. */
function createClient(
	handler: (
		id: string,
		params: { project_id: string },
	) => Promise<QueuedProcess>,
) {
	const get = vi.fn(handler);
	const apiClient = {
		queuedProcesses: () => ({ get }),
	} as unknown as LokaliseApi;

	return { apiClient, get };
}

type PollOverrides = {
	initialWaitTime?: number;
	maxWaitTime?: number;
	concurrency?: number;
	signal?: AbortSignal;
	onDebug?: (message: string) => void;
	onWarning?: (id: string, error: unknown) => void;
};

function poll(
	apiClient: LokaliseApi,
	processes: readonly QueuedProcess[],
	overrides: PollOverrides = {},
): Promise<QueuedProcess[]> {
	return pollLokaliseProcesses({
		apiClient,
		projectId,
		processes,
		initialWaitTime: 2,
		maxWaitTime: 1_000,
		...overrides,
	});
}

describe("pollLokaliseProcesses()", () => {
	it("returns an empty array without calling the API", async () => {
		const { apiClient, get } = createClient(async (id) =>
			processWithStatus(id, "finished"),
		);

		await expect(poll(apiClient, [])).resolves.toEqual([]);
		expect(get).not.toHaveBeenCalled();
	});

	it("does not poll initially terminal processes", async () => {
		const processes = [
			processWithStatus("a", "finished"),
			processWithStatus("b", "failed"),
			processWithStatus("c", "cancelled"),
		];
		const { apiClient, get } = createClient(async (id) =>
			processWithStatus(id, "finished"),
		);

		await expect(poll(apiClient, processes)).resolves.toEqual(processes);
		expect(get).not.toHaveBeenCalled();
	});

	it("fetches a pending process and passes the correct project ID", async () => {
		const { apiClient, get } = createClient(async (id) =>
			processWithStatus(id, "finished"),
		);

		const result = await poll(apiClient, [processWithStatus("a", "queued")]);

		expect(result[0]?.status).toBe("finished");
		expect(get).toHaveBeenCalledTimes(1);
		expect(get).toHaveBeenCalledWith("a", { project_id: projectId });
	});

	it.each(["failed", "cancelled"])(
		"treats an updated %s status as terminal",
		async (status) => {
			const { apiClient, get } = createClient(async (id) =>
				processWithStatus(id, status),
			);

			const result = await poll(apiClient, [processWithStatus("a", "queued")]);

			expect(result[0]?.status).toBe(status);
			expect(get).toHaveBeenCalledTimes(1);
		},
	);

	it("keeps input order and duplicates but fetches each ID only once", async () => {
		const initial = [
			processWithStatus("b", "queued"),
			processWithStatus("a", "queued"),
			processWithStatus("b", "queued"),
		];
		const { apiClient, get } = createClient(async (id) =>
			processWithStatus(id, "finished"),
		);

		const result = await poll(apiClient, initial);

		expect(result.map((item) => item.process_id)).toEqual(["b", "a", "b"]);
		expect(result.every((item) => item.status === "finished")).toBe(true);
		expect(get).toHaveBeenCalledTimes(2);
		expect(get.mock.calls.map(([id]) => id)).toEqual(["b", "a"]);
	});

	it("polls only processes that are not already terminal", async () => {
		const { apiClient, get } = createClient(async (id) =>
			processWithStatus(id, "finished"),
		);

		const result = await poll(apiClient, [
			processWithStatus("done", "finished"),
			processWithStatus("pending", "queued"),
		]);

		expect(result.map((item) => item.status)).toEqual(["finished", "finished"]);
		expect(get).toHaveBeenCalledTimes(1);
		expect(get).toHaveBeenCalledWith("pending", { project_id: projectId });
	});

	it("stops polling processes as they reach terminal states", async () => {
		const calls = new Map<string, number>();
		const { apiClient, get } = createClient(async (id) => {
			const count = (calls.get(id) ?? 0) + 1;
			calls.set(id, count);
			return processWithStatus(
				id,
				id === "a" || count === 2 ? "finished" : "queued",
			);
		});

		const result = await poll(apiClient, [
			processWithStatus("a", "queued"),
			processWithStatus("b", "queued"),
		]);

		expect(result.map((item) => item.status)).toEqual(["finished", "finished"]);
		expect(get.mock.calls.map(([id]) => id)).toEqual(["a", "b", "b"]);
	});

	it("uses increasing delays on successive ordinary rounds", async () => {
		const logs: string[] = [];
		let attempt = 0;
		const { apiClient, get } = createClient(async (id) => {
			attempt++;
			return processWithStatus(id, attempt === 3 ? "finished" : "queued");
		});

		const result = await poll(apiClient, [processWithStatus("a", "queued")], {
			initialWaitTime: 5,
			onDebug: (message) => logs.push(message),
		});

		expect(result[0]?.status).toBe("finished");
		expect(get).toHaveBeenCalledTimes(3);
		expect(logs).toContain("Waiting 5ms before polling...");
		expect(logs).toContain("Waiting 10ms before polling...");
	});

	it("performs a single 200ms fast-follow for a missing status", async () => {
		const logs: string[] = [];
		let attempt = 0;
		const { apiClient, get } = createClient(async (id) => {
			attempt++;
			return processWithStatus(id, attempt === 1 ? undefined : "finished");
		});

		const result = await poll(apiClient, [processWithStatus("a", "queued")], {
			initialWaitTime: 500,
			maxWaitTime: 2_000,
			onDebug: (message) => logs.push(message),
		});

		expect(result[0]?.status).toBe("finished");
		expect(get).toHaveBeenCalledTimes(2);
		expect(logs).toContain("Fast-follow: rechecking missing statuses.");
		expect(logs).toContain("Waiting 200ms before polling...");
	});

	it("uses fast-follow at most once even if statuses remain missing", async () => {
		const logs: string[] = [];
		let attempt = 0;
		const { apiClient, get } = createClient(async (id) => {
			attempt++;
			return processWithStatus(id, attempt < 3 ? undefined : "finished");
		});

		const result = await poll(apiClient, [processWithStatus("a", "queued")], {
			initialWaitTime: 5,
			maxWaitTime: 1_000,
			onDebug: (message) => logs.push(message),
		});

		expect(result[0]?.status).toBe("finished");
		expect(get).toHaveBeenCalledTimes(3);
		expect(
			logs.filter((message) => message.startsWith("Fast-follow:")),
		).toHaveLength(1);
		expect(logs).toContain("Waiting 200ms before polling...");
		expect(logs).toContain("Waiting 5ms before polling...");
	});

	it("does not fast-follow after a recoverable HTTP error", async () => {
		const logs: string[] = [];
		let attempt = 0;
		const { apiClient } = createClient(async (id) => {
			attempt++;
			if (attempt === 1) throw new LokaliseApiError("Rate limited", 429);
			return processWithStatus(id, "finished");
		});

		await poll(apiClient, [processWithStatus("a", "queued")], {
			initialWaitTime: 5,
			onDebug: (message) => logs.push(message),
		});

		expect(logs).not.toContain("Fast-follow: rechecking missing statuses.");
		expect(logs).toContain("Waiting 5ms before polling...");
	});

	it.each([408, 429])(
		"continues after recoverable SDK error %i and warns",
		async (code) => {
			const error = new LokaliseApiError("Temporary failure", code);
			const onWarning = vi.fn();
			let attempt = 0;
			const { apiClient, get } = createClient(async (id) => {
				attempt++;
				if (attempt === 1) throw error;
				return processWithStatus(id, "finished");
			});

			const result = await poll(apiClient, [processWithStatus("a", "queued")], {
				onWarning,
			});

			expect(result[0]?.status).toBe("finished");
			expect(get).toHaveBeenCalledTimes(2);
			expect(onWarning).toHaveBeenCalledTimes(1);
			expect(onWarning).toHaveBeenCalledWith("a", error);
		},
	);

	it("propagates non-retryable SDK errors without warning", async () => {
		const error = new LokaliseApiError("Unauthorized", 401);
		const onWarning = vi.fn();
		const { apiClient, get } = createClient(async () => {
			throw error;
		});

		await expect(
			poll(apiClient, [processWithStatus("a", "queued")], { onWarning }),
		).rejects.toBe(error);

		expect(get).toHaveBeenCalledTimes(1);
		expect(onWarning).not.toHaveBeenCalled();
	});

	it("propagates non-SDK errors", async () => {
		const error = new Error("Connection lost");
		const { apiClient, get } = createClient(async () => {
			throw error;
		});

		await expect(
			poll(apiClient, [processWithStatus("a", "queued")]),
		).rejects.toBe(error);
		expect(get).toHaveBeenCalledTimes(1);
	});

	it("ignores a response with a mismatched process ID", async () => {
		const logs: string[] = [];
		let attempt = 0;
		const { apiClient, get } = createClient(async (id) => {
			attempt++;
			return processWithStatus(attempt === 1 ? "wrong-id" : id, "finished");
		});

		const result = await poll(apiClient, [processWithStatus("a", "queued")], {
			onDebug: (message) => logs.push(message),
		});

		expect(result[0]?.process_id).toBe("a");
		expect(result[0]?.status).toBe("finished");
		expect(get).toHaveBeenCalledTimes(2);
		expect(logs).toContain("Ignoring mismatched process response for a");
	});

	it("returns the initial state immediately when maxWaitTime is zero", async () => {
		const initial = processWithStatus("a", "queued");
		const { apiClient, get } = createClient(async (id) =>
			processWithStatus(id, "finished"),
		);

		await expect(
			poll(apiClient, [initial], { maxWaitTime: 0 }),
		).resolves.toEqual([initial]);
		expect(get).not.toHaveBeenCalled();
	});

	it("returns the latest nonterminal state after the time budget expires", async () => {
		const { apiClient, get } = createClient(async (id) =>
			processWithStatus(id, "running"),
		);

		const result = await poll(apiClient, [processWithStatus("a", "queued")], {
			initialWaitTime: 200,
			maxWaitTime: 100,
		});

		expect(result[0]?.status).toBe("running");
		expect(get).toHaveBeenCalledTimes(1);
	});

	it("skips the next poll when the wait exceeds the remaining budget", async () => {
		const { apiClient, get } = createClient(async (id) =>
			processWithStatus(id, "queued"),
		);

		const result = await poll(apiClient, [processWithStatus("a", "queued")], {
			initialWaitTime: Number.MAX_SAFE_INTEGER,
			maxWaitTime: 100,
		});

		expect(result[0]?.status).toBe("queued");
		expect(get).toHaveBeenCalledTimes(1);
	});

	it("allows an in-flight API request to finish beyond the polling deadline", async () => {
		const { apiClient, get } = createClient(async (id) => {
			await sleep(120);
			return processWithStatus(id, "finished");
		});

		const result = await poll(apiClient, [processWithStatus("a", "queued")], {
			maxWaitTime: 50,
		});

		expect(result[0]?.status).toBe("finished");
		expect(get).toHaveBeenCalledTimes(1);
	});

	it("rejects an already aborted signal before making requests", async () => {
		const controller = new AbortController();
		const reason = new Error("Aborted before polling");
		controller.abort(reason);
		const { apiClient, get } = createClient(async (id) =>
			processWithStatus(id, "finished"),
		);

		await expect(
			poll(apiClient, [processWithStatus("a", "queued")], {
				signal: controller.signal,
			}),
		).rejects.toBe(reason);
		expect(get).not.toHaveBeenCalled();
	});

	it("checks the abort signal after an in-flight batch", async () => {
		const controller = new AbortController();
		const reason = new Error("Aborted during request");
		const { apiClient } = createClient(async (id) => {
			controller.abort(reason);
			return processWithStatus(id, "finished");
		});

		await expect(
			poll(apiClient, [processWithStatus("a", "queued")], {
				signal: controller.signal,
			}),
		).rejects.toBe(reason);
	});

	it("aborts while sleeping between rounds", async () => {
		const controller = new AbortController();
		const { apiClient, get } = createClient(async (id) =>
			processWithStatus(id, "queued"),
		);

		await expect(
			poll(apiClient, [processWithStatus("a", "queued")], {
				initialWaitTime: 100,
				signal: controller.signal,
				onDebug: (message) => {
					if (message.startsWith("Waiting ")) controller.abort();
				},
			}),
		).rejects.toMatchObject({ name: "AbortError" });

		expect(get).toHaveBeenCalledTimes(1);
	});

	it("never exceeds the configured concurrency limit", async () => {
		let active = 0;
		let peak = 0;
		const ids = Array.from({ length: 7 }, (_, index) => `p-${index}`);
		const { apiClient, get } = createClient(async (id) => {
			active++;
			peak = Math.max(peak, active);
			try {
				await sleep(8);
				return processWithStatus(id, "finished");
			} finally {
				active--;
			}
		});

		const result = await poll(
			apiClient,
			ids.map((id) => processWithStatus(id, "queued")),
			{ concurrency: 2 },
		);

		expect(peak).toBe(2);
		expect(get).toHaveBeenCalledTimes(ids.length);
		expect(result.map((p) => p.process_id)).toEqual(ids);
		expect(result.every((p) => p.status === "finished")).toBe(true);
	});

	it.each(["", " ", "\t"])("rejects invalid process IDs: %j", async (id) => {
		const { apiClient, get } = createClient(async (value) =>
			processWithStatus(value, "finished"),
		);

		await expect(
			poll(apiClient, [processWithStatus(id, "queued")]),
		).rejects.toThrow("Invalid or missing process ID.");
		expect(get).not.toHaveBeenCalled();
	});

	it("rejects a process missing the ID", async () => {
		const missingId = {
			type: "async-export",
			status: "queued",
		} as QueuedProcess;

		const { apiClient, get } = createClient(async (id) =>
			processWithStatus(id, "finished"),
		);

		await expect(poll(apiClient, [missingId])).rejects.toBeInstanceOf(
			LokaliseError,
		);

		expect(get).not.toHaveBeenCalled();
	});
});

describe("validatePollingParams()", () => {
	it("accepts zero maximum wait and the default concurrency", () => {
		expect(() =>
			validatePollingParams({
				initialWaitTime: 1,
				maxWaitTime: 0,
			}),
		).not.toThrow();
	});

	it.each([
		{ initialWaitTime: 0, maxWaitTime: 100, concurrency: 1 },
		{ initialWaitTime: -1, maxWaitTime: 100, concurrency: 1 },
		{ initialWaitTime: Number.NaN, maxWaitTime: 100, concurrency: 1 },
		{
			initialWaitTime: Number.POSITIVE_INFINITY,
			maxWaitTime: 100,
			concurrency: 1,
		},
		{ initialWaitTime: 1, maxWaitTime: -1, concurrency: 1 },
		{ initialWaitTime: 1, maxWaitTime: Number.NaN, concurrency: 1 },
		{
			initialWaitTime: 1,
			maxWaitTime: Number.POSITIVE_INFINITY,
			concurrency: 1,
		},
		{ initialWaitTime: 1, maxWaitTime: 100, concurrency: 0 },
		{ initialWaitTime: 1, maxWaitTime: 100, concurrency: 1.5 },
		{ initialWaitTime: 1, maxWaitTime: 100, concurrency: Number.NaN },
	])("rejects invalid polling configuration: %j", (params) => {
		expect(() => validatePollingParams(params)).toThrow(LokaliseError);
	});
});
