import { LokaliseError } from "../../lib/index.js";
import {
	MockAgent,
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	setGlobalDispatcher,
	vi,
} from "../setup.js";

describe("LokaliseError", () => {
	it("should allow to convert errors to strings", () => {
		const errorWithMessage = new LokaliseError("Sample error without code");
		expect(String(errorWithMessage)).toEqual(
			"LokaliseError: Sample error without code",
		);

		const errorWithCode = new LokaliseError("Sample error with code", 404);
		expect(String(errorWithCode)).toEqual(
			"LokaliseError: Sample error with code (Code: 404)",
		);

		const errorWithDetails = new LokaliseError("Sample error with code", 404, {
			reason: "fake",
		});
		expect(String(errorWithDetails)).toEqual(
			"LokaliseError: Sample error with code (Code: 404) | Details: reason: fake",
		);
	});
});
