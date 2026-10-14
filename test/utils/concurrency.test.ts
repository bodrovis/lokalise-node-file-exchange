import { setImmediate as nextTurn } from "node:timers/promises";
import { LokaliseError } from "../../lib/errors/LokaliseError.js";
import { runWithConcurrencyLimit } from "../../lib/utils/concurrency.js";
import { describe, expect, it, vi } from "../setup.js";

function createGate(): { promise: Promise<void>; release: () => void } {
	let release = (): void => {};
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});

	return { promise, release };
}

describe("runWithConcurrencyLimit()", () => {
	it("passes each item and its original index to the worker", async () => {
		const worker = vi.fn(
			async (item: string, index: number) => `${index}:${item}`,
		);

		const results = await runWithConcurrencyLimit(["a", "b", "c"], 2, worker);

		expect(results).toEqual(["0:a", "1:b", "2:c"]);
		expect(worker).toHaveBeenCalledTimes(3);
		expect(worker).toHaveBeenNthCalledWith(1, "a", 0);
		expect(worker).toHaveBeenNthCalledWith(2, "b", 1);
		expect(worker).toHaveBeenNthCalledWith(3, "c", 2);
	});

	it("preserves input order when tasks finish out of order", async () => {
		const gates = [createGate(), createGate(), createGate()] as const;
		const completionOrder: number[] = [];

		const resultPromise = runWithConcurrencyLimit(
			gates,
			3,
			async (gate, index) => {
				await gate.promise;
				completionOrder.push(index);
				return `result-${index}`;
			},
		);

		gates[2].release();
		await nextTurn();

		gates[1].release();
		await nextTurn();

		gates[0].release();

		expect(await resultPromise).toEqual(["result-0", "result-1", "result-2"]);

		expect(completionOrder).toEqual([2, 1, 0]);
	});

	it("never exceeds the requested concurrency limit", async () => {
		const gate = createGate();
		const started: number[] = [];
		let active = 0;
		let maxActive = 0;

		const resultPromise = runWithConcurrencyLimit(
			[0, 1, 2, 3, 4, 5],
			2,
			async (item) => {
				started.push(item);
				active++;
				maxActive = Math.max(maxActive, active);

				try {
					await gate.promise;
					return item * 2;
				} finally {
					active--;
				}
			},
		);

		expect(started).toEqual([0, 1]);
		expect(active).toBe(2);

		gate.release();

		await expect(resultPromise).resolves.toEqual([0, 2, 4, 6, 8, 10]);
		expect(maxActive).toBe(2);
		expect(active).toBe(0);
		expect(started).toEqual([0, 1, 2, 3, 4, 5]);
	});

	it("runs tasks sequentially with a limit of one", async () => {
		const events: string[] = [];

		const results = await runWithConcurrencyLimit(
			[1, 2, 3],
			1,
			async (item) => {
				events.push(`start-${item}`);
				await Promise.resolve();
				events.push(`end-${item}`);
				return item;
			},
		);

		expect(results).toEqual([1, 2, 3]);
		expect(events).toEqual([
			"start-1",
			"end-1",
			"start-2",
			"end-2",
			"start-3",
			"end-3",
		]);
	});

	it("handles an empty input without invoking the worker", async () => {
		const worker = vi.fn(async (value: number) => value);

		await expect(runWithConcurrencyLimit([], 3, worker)).resolves.toEqual([]);
		expect(worker).not.toHaveBeenCalled();
	});

	it("handles a concurrency limit greater than the input size", async () => {
		const worker = vi.fn(async (value: number) => value * 10);

		await expect(runWithConcurrencyLimit([1, 2], 100, worker)).resolves.toEqual(
			[10, 20],
		);
		expect(worker).toHaveBeenCalledTimes(2);
	});

	it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
		"rejects an invalid concurrency limit: %s",
		async (limit) => {
			const worker = vi.fn(async (value: number) => value);

			await expect(
				runWithConcurrencyLimit([1], limit, worker),
			).rejects.toBeInstanceOf(LokaliseError);
			expect(worker).not.toHaveBeenCalled();
		},
	);

	it("rejects invalid limits even for empty inputs", async () => {
		const worker = vi.fn(async (value: number) => value);

		await expect(runWithConcurrencyLimit([], 0, worker)).rejects.toThrow(
			"Concurrency limit must be a positive safe integer.",
		);
		expect(worker).not.toHaveBeenCalled();
	});

	it("stops scheduling new tasks on failure and waits for active tasks", async () => {
		const firstGate = createGate();
		const secondGate = createGate();
		const failure = new Error("First task failed");
		const started: number[] = [];
		const finished: number[] = [];
		let settled = false;

		const resultPromise = runWithConcurrencyLimit(
			[0, 1, 2, 3],
			2,
			async (item) => {
				started.push(item);

				if (item === 0) {
					await firstGate.promise;
					throw failure;
				}

				if (item === 1) {
					await secondGate.promise;
					finished.push(item);
				}

				return item;
			},
		);

		// Observe settlement without producing a second unhandled rejection.
		const observation = resultPromise.then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);

		expect(started).toEqual([0, 1]);

		firstGate.release();
		await nextTurn();

		expect(started).toEqual([0, 1]);
		expect(settled).toBe(false);
		expect(finished).toEqual([]);

		secondGate.release();

		await expect(resultPromise).rejects.toBe(failure);
		await observation;

		expect(finished).toEqual([1]);
		expect(started).toEqual([0, 1]);
	});

	it("propagates a synchronously thrown worker error", async () => {
		const failure = new Error("Synchronous failure");
		const started: number[] = [];

		await expect(
			runWithConcurrencyLimit([1, 2, 3], 1, (item): Promise<number> => {
				started.push(item);
				throw failure;
			}),
		).rejects.toBe(failure);

		expect(started).toEqual([1]);
	});

	it("preserves a rejection whose value is undefined", async () => {
		await expect(
			runWithConcurrencyLimit([1], 1, async () => {
				throw undefined;
			}),
		).rejects.toBeUndefined();
	});

	it("rejects sparse arrays rather than silently skipping missing items", async () => {
		const items: number[] = [];
		items[0] = 10;
		items[2] = 30;
		const worker = vi.fn(async (value: number) => value);

		await expect(runWithConcurrencyLimit(items, 1, worker)).rejects.toThrow(
			"Missing item at index 1",
		);

		expect(worker).toHaveBeenCalledTimes(1);
		expect(worker).toHaveBeenCalledWith(10, 0);
	});

	it("does not process items appended after execution starts", async () => {
		const items = [1, 2];

		const results = await runWithConcurrencyLimit(items, 1, async (item) => {
			if (item === 1) items.push(3);
			return item;
		});

		expect(results).toEqual([1, 2]);
		expect(items).toEqual([1, 2, 3]);
	});
});
