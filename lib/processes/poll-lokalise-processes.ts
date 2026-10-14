import { setTimeout as sleep } from "node:timers/promises";
import {
	type LokaliseApi,
	ApiError as LokaliseApiError,
	type QueuedProcess,
} from "@lokalise/node-api";
import { MAX_CONCURRENT_PROCESSES, RETRYABLE_CODES } from "../constants.js";
import { LokaliseError } from "../errors/LokaliseError.js";
import { runWithConcurrencyLimit } from "../utils/concurrency.js";
import { isFinishedStatus } from "../utils/process-status.js";

const FAST_FOLLOW_DELAY_MS = 200;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

interface ProcessUpdate {
	id: string;
	process?: QueuedProcess;
}

interface PollLokaliseProcessesOptions {
	processes: readonly QueuedProcess[];
	apiClient: LokaliseApi;
	projectId: string;
	initialWaitTime: number;
	maxWaitTime: number;
	concurrency?: number;
	signal?: AbortSignal;
	onDebug?: (message: string) => void;
	onWarning?: (id: string, error: unknown) => void;
}

interface PollingState {
	latest: Map<string, QueuedProcess>;
	pending: Set<string>;
	startedAt: number;
	nextDelay: number;
	backoff: number;
	fastFollowUsed: boolean;
}

/**
 * Polls Lokalise processes until they reach terminal states
 * or the polling time budget expires.
 *
 * Preserves input order and duplicate process IDs.
 * In-flight API requests may outlive the time budget.
 */
export async function pollLokaliseProcesses(
	options: PollLokaliseProcessesOptions,
): Promise<QueuedProcess[]> {
	const { processes, initialWaitTime, onDebug, signal } = options;
	const concurrency = options.concurrency ?? MAX_CONCURRENT_PROCESSES;

	validatePollingParams({
		initialWaitTime,
		maxWaitTime: options.maxWaitTime,
		concurrency,
	});

	signal?.throwIfAborted();

	const state = createPollingState(processes, initialWaitTime);

	onDebug?.(`Starting polling. Processes: ${processes.length}`);

	await runPollingLoop(state, options, concurrency);

	onDebug?.(`Polling stopped. Pending: ${state.pending.size}`);

	return processes.map(
		(process) => state.latest.get(process.process_id) ?? process,
	);
}

/**
 * Creates the initial polling state from queued processes.
 */
function createPollingState(
	processes: readonly QueuedProcess[],
	initialWaitTime: number,
): PollingState {
	const latest = new Map<string, QueuedProcess>();

	for (const process of processes) {
		if (typeof process.process_id !== "string" || !process.process_id.trim()) {
			throw new LokaliseError("Invalid or missing process ID.");
		}

		latest.set(process.process_id, process);
	}

	return {
		latest,
		pending: new Set(
			[...latest.values()]
				.filter((p) => !isFinishedStatus(p.status))
				.map((p) => p.process_id),
		),
		startedAt: performance.now(),
		nextDelay: 0,
		backoff: Math.min(initialWaitTime, MAX_TIMER_DELAY_MS),
		fastFollowUsed: false,
	};
}

/**
 * Repeatedly fetches and applies process status updates
 * until completion or timeout.
 */
async function runPollingLoop(
	state: PollingState,
	options: PollLokaliseProcessesOptions,
	concurrency: number,
): Promise<void> {
	const { onDebug, signal } = options;

	while (state.pending.size > 0) {
		signal?.throwIfAborted();

		if (!(await waitBeforeNextRound(state, options))) {
			break;
		}

		const ids = [...state.pending];

		onDebug?.(`Polling ${ids.length} pending processes...`);

		const updates = await fetchStatuses(ids, concurrency, options);

		signal?.throwIfAborted();

		applyProcessUpdates(state, updates, onDebug);
	}
}

/**
 * Waits until the next polling round.
 *
 * Returns false when the time budget has expired.
 */
async function waitBeforeNextRound(
	state: PollingState,
	options: PollLokaliseProcessesOptions,
): Promise<boolean> {
	const { maxWaitTime, signal, onDebug } = options;

	const remaining = maxWaitTime - (performance.now() - state.startedAt);

	if (remaining <= 0) return false;
	if (state.nextDelay === 0) return true;

	// Not enough time for another scheduled polling round.
	if (state.nextDelay >= remaining) return false;

	const wait = Math.min(state.nextDelay, MAX_TIMER_DELAY_MS);

	onDebug?.(`Waiting ${wait}ms before polling...`);

	await sleep(wait, undefined, signal ? { signal } : {});

	return performance.now() - state.startedAt < maxWaitTime;
}

/**
 * Updates process states and schedules the next polling delay.
 */
function applyProcessUpdates(
	state: PollingState,
	updates: ProcessUpdate[],
	onDebug?: (message: string) => void,
): void {
	let hasMissingStatus = false;

	for (const { id, process } of updates) {
		if (!process || !state.pending.has(id)) continue;

		if (process.process_id !== id) {
			onDebug?.(`Ignoring mismatched process response for ${id}`);
			continue;
		}

		state.latest.set(id, process);

		if (isFinishedStatus(process.status)) {
			state.pending.delete(id);
			onDebug?.(`Process ${id} completed: ${process.status}`);
		} else if (process.status == null) {
			hasMissingStatus = true;
		}
	}

	if (!state.fastFollowUsed && hasMissingStatus) {
		state.nextDelay = FAST_FOLLOW_DELAY_MS;
		state.fastFollowUsed = true;
		onDebug?.("Fast-follow: rechecking missing statuses.");
	} else {
		state.nextDelay = state.backoff;
		state.backoff = Math.min(state.backoff * 2, MAX_TIMER_DELAY_MS);
	}
}

/**
 * Fetches current process states with limited concurrency.
 *
 * Retryable API errors leave individual processes pending.
 * Other errors propagate to the caller.
 */
async function fetchStatuses(
	ids: string[],
	concurrency: number,
	{ apiClient, projectId, onDebug, onWarning }: PollLokaliseProcessesOptions,
): Promise<ProcessUpdate[]> {
	return runWithConcurrencyLimit(
		ids,
		concurrency,
		async (id): Promise<ProcessUpdate> => {
			onDebug?.(`Requesting process ${id}...`);

			try {
				const process = await apiClient
					.queuedProcesses()
					.get(id, { project_id: projectId });

				onDebug?.(`Process ${id}: ${process.status ?? "missing"}`);

				return { id, process };
			} catch (error) {
				if (
					!(error instanceof LokaliseApiError) ||
					!RETRYABLE_CODES.has(error.code)
				) {
					throw error;
				}

				onWarning?.(id, error);
				return { id };
			}
		},
	);
}

/**
 * Validates polling intervals and concurrency settings.
 *
 * @throws {LokaliseError} If any parameter is invalid.
 */
export function validatePollingParams({
	initialWaitTime,
	maxWaitTime,
	concurrency = MAX_CONCURRENT_PROCESSES,
}: Pick<
	PollLokaliseProcessesOptions,
	"initialWaitTime" | "maxWaitTime" | "concurrency"
>): void {
	if (!Number.isFinite(initialWaitTime) || initialWaitTime <= 0) {
		throw new LokaliseError("initialWaitTime must be a positive finite value.");
	}

	if (!Number.isFinite(maxWaitTime) || maxWaitTime < 0) {
		throw new LokaliseError("maxWaitTime must be a non-negative finite value.");
	}

	if (!Number.isSafeInteger(concurrency) || concurrency <= 0) {
		throw new LokaliseError("concurrency must be a positive safe integer.");
	}
}
