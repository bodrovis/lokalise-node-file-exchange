import type { LokaliseApi } from "@lokalise/node-api";
import type { LogFunction, LogThreshold } from "kliedz";
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
}
