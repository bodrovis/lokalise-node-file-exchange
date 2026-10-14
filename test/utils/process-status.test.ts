import { FINISHED_STATUSES } from "../../lib/constants.js";
import {
	isFinishedStatus,
	isPendingStatus,
} from "../../lib/utils/process-status.js";
import { describe, expect, it } from "../setup.js";

describe("process status helpers", () => {
	it.each([...FINISHED_STATUSES])(
		"recognizes '%s' as a terminal status",
		(status) => {
			expect(isFinishedStatus(status)).toBe(true);
			expect(isPendingStatus(status)).toBe(false);
		},
	);

	it.each(["queued", "running", "pending", "unknown", ""])(
		"treats '%s' as a non-terminal status",
		(status) => {
			expect(isFinishedStatus(status)).toBe(false);
			expect(isPendingStatus(status)).toBe(true);
		},
	);

	it.each([undefined, null])("treats %s as a pending status", (status) => {
		expect(isFinishedStatus(status)).toBe(false);
		expect(isPendingStatus(status)).toBe(true);
	});
});
