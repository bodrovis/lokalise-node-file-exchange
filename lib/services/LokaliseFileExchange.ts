import { LokaliseApi } from "@lokalise/node-api";
import type { ILokaliseConfig } from "../interfaces/ILokaliseConfig.js";

export class LokaliseFileExchange {
	private readonly apiKey: string;
	protected readonly projectId: string;
	protected readonly apiClient: LokaliseApi;

	constructor(config: ILokaliseConfig) {
		if (!config.apiKey || typeof config.apiKey !== "string") {
			throw new Error("Invalid or missing API token.");
		}
		if (!config.projectId || typeof config.projectId !== "string") {
			throw new Error("Invalid or missing Project ID.");
		}

		this.apiKey = config.apiKey;
		this.projectId = config.projectId;
		this.apiClient = new LokaliseApi({ apiKey: this.apiKey });
		// console.log(this.apiClient, this.projectId);
	}
}
