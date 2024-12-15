import { LokaliseError } from "../../lib/index.js";
import { describe, expect, it } from "../setup.js";

describe("LokaliseError", () => {
	describe("Error String Conversion", () => {
		it("should convert errors without code to strings", () => {
			const error = new LokaliseError("Sample error without code");
			expect(String(error)).toEqual("LokaliseError: Sample error without code");
		});

		it("should convert errors with code to strings", () => {
			const error = new LokaliseError("Sample error with code", 404);
			expect(String(error)).toEqual(
				"LokaliseError: Sample error with code (Code: 404)",
			);
		});

		it("should convert errors with code and details to strings", () => {
			const error = new LokaliseError("Sample error with details", 404, {
				reason: "fake",
				info: "extra detail",
			});
			expect(String(error)).toEqual(
				"LokaliseError: Sample error with details (Code: 404) | Details: reason: fake, info: extra detail",
			);
		});
	});

	describe("Error Properties", () => {
		it("should expose code and details as properties", () => {
			const error = new LokaliseError("Sample error", 500, {
				reason: "server issue",
			});
			expect(error.message).toEqual("Sample error");
			expect(error.code).toEqual(500);
			expect(error.details).toEqual({ reason: "server issue" });
		});

		it("should handle undefined details gracefully", () => {
			const error = new LokaliseError("Error without details", 400);
			expect(error.details).toBeUndefined();
		});
	});

	describe("Edge Cases", () => {
		it("should handle empty message and undefined code/details gracefully", () => {
			const error = new LokaliseError("");
			expect(String(error)).toEqual("LokaliseError: ");
			expect(error.code).toBeUndefined();
			expect(error.details).toBeUndefined();
		});

		it("should handle null or invalid details gracefully", () => {
			const error = new LokaliseError(
				"Error with invalid details",
				400,
				undefined,
			);
			expect(error.details).toBeUndefined();
			expect(String(error)).toEqual(
				"LokaliseError: Error with invalid details (Code: 400)",
			);
		});
	});
});
