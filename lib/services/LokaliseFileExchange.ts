import type { ClientParams } from "@lokalise/node-api";
import { LokaliseApi, LokaliseApiOAuth } from "@lokalise/node-api";
import {
	type LogFunction,
	type LogLevel,
	type LogThreshold,
	logWithColor,
	logWithLevel,
} from "kliedz";
import { LokaliseError } from "../errors/LokaliseError.js";
import type {
	LokaliseExchangeConfig,
	RetryParams,
} from "../interfaces/index.js";
import { resolveRetryParams, validateRetryParams } from "../utils/retry.js";

/**
 * A utility class for exchanging files with the Lokalise API.
 */
export abstract class LokaliseFileExchange {
	/**
	 * The Lokalise API client instance.
	 */
	protected readonly apiClient: LokaliseApi;

	/**
	 * The ID of the project in Lokalise.
	 */
	protected readonly projectId: string;

	/**
	 * Retry parameters for API requests.
	 */
	protected readonly retryParams: Required<RetryParams>;

	/**
	 * Logger function.
	 */
	protected readonly logger: LogFunction;

	/**
	 * Log threshold (do not print messages with severity less than the specified value).
	 */
	protected readonly logThreshold: LogThreshold;

	/**
	 * Creates a new instance of LokaliseFileExchange.
	 *
	 * @param clientConfig - Configuration for the Lokalise SDK.
	 * @param exchangeConfig - The configuration object for file exchange operations.
	 * @throws {LokaliseError} If the provided configuration is invalid.
	 */
	constructor(
		clientConfig: ClientParams,
		{
			projectId,
			useOAuth2 = false,
			retryParams,
			logThreshold = "info",
			logColor = true,
		}: LokaliseExchangeConfig,
	) {
		this.projectId = projectId;
		this.logThreshold = logThreshold;
		this.logger = this.chooseLogger(logColor);
		this.retryParams = resolveRetryParams(retryParams);

		this.validateParams();

		const apiConfig = this.buildLokaliseClientConfig(
			clientConfig,
			logThreshold,
		);
		this.apiClient = this.createApiClient(apiConfig, useOAuth2);
	}

	/**
	 * Validates the project ID and retry configuration.
	 *
	 * @throws {LokaliseError} If any configuration value is invalid.
	 */
	private validateParams(): void {
		if (
			typeof this.projectId !== "string" ||
			this.projectId.trim().length === 0
		) {
			throw new LokaliseError("Invalid or missing Project ID.");
		}

		validateRetryParams(this.retryParams);
	}

	/**
	 * Builds the final Lokalise client configuration,
	 * enabling silent mode when the log threshold is `"silent"`.
	 *
	 * @param clientConfig - Base client parameters.
	 * @param logThreshold - Active logging threshold.
	 * @returns The adjusted client configuration.
	 */
	private buildLokaliseClientConfig(
		clientConfig: ClientParams,
		logThreshold: LogThreshold,
	): ClientParams {
		if (logThreshold === "silent") {
			return {
				...clientConfig,
				silent: true,
			};
		}

		return { ...clientConfig };
	}

	/**
	 * Creates the appropriate Lokalise API client instance,
	 * choosing between OAuth2 and token-based authentication.
	 *
	 * @param lokaliseApiConfig - Configuration passed to the client.
	 * @param useOAuth2 - Whether OAuth2 authentication should be used.
	 * @returns A Lokalise API client instance.
	 */
	private createApiClient(
		lokaliseApiConfig: ClientParams,
		useOAuth2: boolean,
	): LokaliseApi | LokaliseApiOAuth {
		if (useOAuth2) {
			this.logMsg("debug", "Using OAuth 2 Lokalise API client");
			return new LokaliseApiOAuth(lokaliseApiConfig);
		}

		this.logMsg("debug", "Using regular (token-based) Lokalise API client");
		return new LokaliseApi(lokaliseApiConfig);
	}

	/**
	 * Selects the logger implementation based on whether color output is enabled.
	 *
	 * @param logColor - If true, uses the colorized logger.
	 * @returns The chosen log function.
	 */
	private chooseLogger(logColor: boolean): LogFunction {
		return logColor ? logWithColor : logWithLevel;
	}

	/**
	 * Logs a message using the configured logger, respecting the current log threshold.
	 *
	 * Wraps the raw logger call by attaching metadata such as:
	 * - `level` — severity of the log entry,
	 * - `threshold` — active log level threshold used to filter messages,
	 * - `withTimestamp` — instructs the logger to prepend a timestamp.
	 *
	 * All variadic `args` are forwarded directly to the logger.
	 *
	 * @param level - Log level of the message being emitted.
	 * @param args - Additional values to pass to the logger.
	 */
	protected logMsg(level: LogLevel, ...args: unknown[]): void {
		this.logger.withParams(
			{ level, threshold: this.logThreshold, withTimestamp: true },
			...args,
		);
	}
}
