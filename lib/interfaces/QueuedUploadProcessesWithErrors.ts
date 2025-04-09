import type { QueuedProcess } from "@lokalise/node-api";
import type { FileUploadError } from "./FileUploadError.js";

export interface QueuedUploadProcessesWithErrors {
	processes: QueuedProcess[];
	errors: FileUploadError[];
}
