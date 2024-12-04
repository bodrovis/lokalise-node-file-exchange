import type { DownloadBundle, DownloadFileParams } from "@lokalise/node-api";
import type { IDownloadOptions } from "../interfaces/IDownloadOptions.js";
import type { IRequestError } from "../interfaces/IRequestError.js";
import { LokaliseFileExchange } from "./LokaliseFileExchange.js";

export class LokaliseDownload extends LokaliseFileExchange {
	async download(
		downloadFileParams: DownloadFileParams,
		downloadOpts: IDownloadOptions = {},
	): Promise<DownloadBundle | IRequestError> {
		const { maxRetries = 3, initialSleepTime = 100 } = downloadOpts;
		let attempt = 0;

		while (attempt < maxRetries) {
			try {
				return await this.apiClient
					.files()
					.download(this.projectId, downloadFileParams);
			} catch (error: any) {
				if (error.message && error.code) {
					if (error.code === 429) {
						attempt++;
						const delay = initialSleepTime * 2 ** (attempt - 1);
						await this.sleep(delay);

						if (attempt === maxRetries) {
							return { message: "Maximum retries reached", code: 429 };
						}
						continue;
					}

					// For other known errors, return the error
					return { message: error.message, code: error.code };
				}

				// Handle unexpected errors
				return { message: "An unexpected error occurred", code: 500 };
			}
		}

		// Should never reach here
		throw new Error("Unexpected error handling logic");
	}

	private sleep(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}
}
