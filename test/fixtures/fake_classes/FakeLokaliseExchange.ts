import type { LokaliseApi, QueuedProcess } from "@lokalise/node-api";
import type { LogFunction, LogLevel, LogThreshold } from "kliedz";
import type { RetryParams } from "../../../lib/interfaces/index.js";
import { LokaliseFileExchange } from "../../../lib/services/LokaliseFileExchange.js";

// Public morozov
export class FakeLokaliseFileExchange extends LokaliseFileExchange {
	getLogger(): LogFunction {
		return this.logger;
	}

	getApiClient(): LokaliseApi {
		return this.apiClient;
	}

	getLogThreshold(): LogThreshold {
		return this.logThreshold;
	}

	public override async withExponentialBackoff<T>(
		operation: () => Promise<T>,
	): Promise<T> {
		return await super.withExponentialBackoff(operation);
	}

	public override async getUpdatedProcess(
		processId: string,
	): Promise<QueuedProcess> {
		return await super.getUpdatedProcess(processId);
	}

	public override async pollProcesses(
		processes: QueuedProcess[],
		initialWaitTime: number,
		maxWaitTime: number,
	): Promise<QueuedProcess[]> {
		return await super.pollProcesses(processes, initialWaitTime, maxWaitTime);
	}

	public override logMsg(level: LogLevel, ...args: unknown[]): void {
		super.logMsg(level, ...args);
	}

	public override async fetchProcessesBatch(
		processIds: string[],
		concurrency = LokaliseFileExchange.maxConcurrentProcesses,
	): Promise<Array<{ id: string; process?: QueuedProcess }>> {
		return await super.fetchProcessesBatch(processIds, concurrency);
	}

	public override calculateSleepMs(
		retryParams: RetryParams,
		attempt: number,
	): number {
		return super.calculateSleepMs(retryParams, attempt);
	}

	public override async runWithConcurrencyLimit<T, R>(
		items: T[],
		limit: number,
		worker: (item: T, index: number) => Promise<R>,
	): Promise<R[]> {
		return super.runWithConcurrencyLimit(items, limit, worker);
	}
}
