import { FINISHED_STATUSES } from "../constants.js";

export function isFinishedStatus(status?: string | null): boolean {
	return status != null && FINISHED_STATUSES.has(status);
}

export function isPendingStatus(status?: string | null): boolean {
	return !isFinishedStatus(status);
}
