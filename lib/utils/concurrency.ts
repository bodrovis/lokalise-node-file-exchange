import { LokaliseError } from "../errors/LokaliseError.js";

/**
 * Runs asynchronous tasks with limited concurrency.
 *
 * Preserves input order. On failure, stops scheduling
 * new tasks and waits for active tasks to settle.
 *
 * @param items - Items to process.
 * @param limit - Maximum concurrent operations.
 * @param worker - Async task handler.
 * @returns Results in input order.
 */
export async function runWithConcurrencyLimit<T, R>(
	items: readonly T[],
	limit: number,
	worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	if (!Number.isSafeInteger(limit) || limit <= 0) {
		throw new LokaliseError(
			"Concurrency limit must be a positive safe integer.",
		);
	}

	const count = items.length;
	const results = new Array<R>(count);

	const state: {
		nextIndex: number;
		failure?: { error: unknown };
	} = {
		nextIndex: 0,
	};

	const runWorker = async (): Promise<void> => {
		while (!state.failure) {
			const index = state.nextIndex++;

			if (index >= count) return;

			if (!(index in items)) {
				state.failure ??= {
					error: new Error(`Missing item at index ${index}`),
				};
				return;
			}

			try {
				results[index] = await worker(items[index] as T, index);
			} catch (error) {
				state.failure ??= { error };
				return;
			}
		}
	};

	const workers = Array.from({ length: Math.min(limit, count) }, () =>
		runWorker(),
	);

	await Promise.all(workers);

	if (state.failure) {
		throw state.failure.error;
	}

	return results;
}
