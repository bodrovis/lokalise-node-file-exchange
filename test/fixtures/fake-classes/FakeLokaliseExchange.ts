import type { LokaliseApi } from "@lokalise/node-api";
import type { LogFunction, LogLevel, LogThreshold } from "kliedz";
import type { RetryParams } from "../../../lib/interfaces/index.js";
import { LokaliseFileExchange } from "../../../lib/services/LokaliseFileExchange.js";

// Public morozov
export class FakeLokaliseFileExchange extends LokaliseFileExchange {
	getApiClient(): LokaliseApi {
		return this.apiClient;
	}

	getLogger(): LogFunction {
		return this.logger;
	}

	getLogThreshold(): LogThreshold {
		return this.logThreshold;
	}

	getRetryParams(): Readonly<Required<RetryParams>> {
		return this.retryParams;
	}

	public override logMsg(level: LogLevel, ...args: unknown[]): void {
		super.logMsg(level, ...args);
	}
}
