import { afterEach, describe, expect, it, vi } from "vitest";
import { downloadBundleZip } from "../../lib/downloaders/bundle-downloader.js";

const { rmMock } = vi.hoisted(() => ({
	rmMock: vi.fn(),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();

	return {
		...actual,
		rm: rmMock,
	};
});

describe("downloadBundleZip: cleanup failures", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		rmMock.mockReset();
	});

	it("calls onWarning when temporary file cleanup fails", async () => {
		const downloadError = new Error("Connection lost");
		const cleanupError = new Error("Permission denied");
		const onWarning = vi.fn();

		vi.spyOn(globalThis, "fetch").mockRejectedValue(downloadError);
		rmMock.mockRejectedValue(cleanupError);

		await expect(
			downloadBundleZip("https://example.com/download.zip", 0, onWarning),
		).rejects.toMatchObject({
			code: 500,
			cause: downloadError,
		});

		expect(rmMock).toHaveBeenCalledWith(expect.stringContaining("lokalise-"), {
			force: true,
		});

		expect(onWarning).toHaveBeenCalledExactlyOnceWith(
			expect.stringContaining("Failed to remove temporary ZIP:"),
			cleanupError,
		);
	});

	it("preserves the download error when onWarning throws", async () => {
		const downloadError = new Error("Connection lost");

		vi.spyOn(globalThis, "fetch").mockRejectedValue(downloadError);
		rmMock.mockRejectedValue(new Error("Cleanup failed"));

		const onWarning = vi.fn(() => {
			throw new Error("Logger failed");
		});

		await expect(
			downloadBundleZip("https://example.com/download.zip", 0, onWarning),
		).rejects.toMatchObject({
			message: "Failed to download ZIP bundle: Connection lost",
			code: 500,
			cause: downloadError,
		});

		expect(onWarning).toHaveBeenCalledOnce();
	});
});
