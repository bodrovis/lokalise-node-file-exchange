import type { LokaliseApi } from "@lokalise/node-api";
import type { QueuedProcess } from "@lokalise/node-api";
import type { LogFunction, LogThreshold } from "kliedz";
import type { LogLevel } from "kliedz";
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

	public async withExponentialBackoff<T>(
		operation: () => Promise<T>,
	): Promise<T> {
		return await super.withExponentialBackoff(operation);
	}

	public async getUpdatedProcess(processId: string): Promise<QueuedProcess> {
		return await super.getUpdatedProcess(processId);
	}

	public async pollProcesses(
		processes: QueuedProcess[],
		initialWaitTime: number,
		maxWaitTime: number,
	): Promise<QueuedProcess[]> {
		return await super.pollProcesses(processes, initialWaitTime, maxWaitTime);
	}

	public logMsg(level: LogLevel, ...args: unknown[]): void {
		super.logMsg(level, ...args);
	}
}
