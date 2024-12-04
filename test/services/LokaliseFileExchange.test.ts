import { LokaliseFileExchange } from "../../lib/services/LokaliseFileExchange.js";
import { describe, expect, it } from "../setup.js";

describe("LokaliseFileExchange", () => {
	it("is expected to create an instance successfully with valid parameters", () => {
		const exchange = new LokaliseFileExchange({
			apiKey: "abc123",
			projectId: "123.abc",
		});
		expect(exchange).to.be.an.instanceOf(LokaliseFileExchange);
	});

	describe("error handling", () => {
		it("is expected to throw an error if the API key is not provided", () => {
			expect(() => {
				new LokaliseFileExchange({ apiKey: "", projectId: "123.abc" });
			}).to.throw(Error, "Invalid or missing API token.");
		});

		it("is expected to throw an error if the project ID is not provided", () => {
			expect(() => {
				new LokaliseFileExchange({ apiKey: "abc123", projectId: "" });
			}).to.throw(Error, "Invalid or missing Project ID.");
		});

		it("is expected to throw an error if the API key is not a string", () => {
			expect(() => {
				new LokaliseFileExchange({
					apiKey: 12345 as any,
					projectId: "123.abc",
				});
			}).to.throw(Error, "Invalid or missing API token.");
		});

		it("is expected to throw an error if the project ID is not a string", () => {
			expect(() => {
				new LokaliseFileExchange({ apiKey: "abc123", projectId: 67890 as any });
			}).to.throw(Error, "Invalid or missing Project ID.");
		});
	});
});
