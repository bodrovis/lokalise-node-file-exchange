import fs from "node:fs";
import path from "node:path";
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher } from "undici";

import { LokaliseError } from "../../../lib/errors/LokaliseError.js";
import { FakeLokaliseUpload } from "../../fixtures/fake-classes/FakeLokaliseUpload.js";
import { createTestFs, type TestFs } from "../../helpers/testFs.js";
import type { Interceptable } from "../../setup.js";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "../../setup.js";

describe("LokaliseUpload: uploadTranslations()", () => {
	const projectId = "803826145ba90b42d5d860.46800099";
	const apiKey = "test-api-key";
	const uploadPath = `/api2/projects/${projectId}/files/upload`;

	let uploader: FakeLokaliseUpload;
	let mockAgent: MockAgent;
	let mockPool: Interceptable;
	let previousDispatcher: ReturnType<typeof getGlobalDispatcher>;

	let testFs: TestFs;
	let restoreCwd: () => void;

	beforeEach(async () => {
		previousDispatcher = getGlobalDispatcher();

		mockAgent = new MockAgent();
		mockAgent.disableNetConnect();
		setGlobalDispatcher(mockAgent);

		mockPool = mockAgent.get("https://api.lokalise.com");

		testFs = await createTestFs({
			locales: {
				"en.json": '{"key": "value"}',
				"fake.weird_json": '{"en_GB": {"key": "value"}}',
				"en_US.json": '{"key": "value"}',
				"en_GB.json": '{"key": "value"}',
				"fr.json": '{"clé": "valeur"}',
				"backup.txt": "Not a JSON file",
				subdir: {
					"es.json": '{"clave": "valor"}',
					nested: {
						"de.json": '{"schlüssel": "wert"}',
						"it.json": '{"chiave": "valore"}',
					},
				},
			},
		});

		restoreCwd = testFs.useAsCwd();
		uploader = new FakeLokaliseUpload({ apiKey }, { projectId });
	});

	afterEach(async () => {
		try {
			mockAgent.assertNoPendingInterceptors();
		} finally {
			setGlobalDispatcher(previousDispatcher);
			await mockAgent.close();
			restoreCwd();
			await testFs.cleanup();
			vi.restoreAllMocks();
		}
	});

	describe("Basic Behavior", () => {
		it("collects and uploads matching files", async () => {
			const fileCount = 8;
			const requests: Array<{
				filename: string;
				lang_iso: string;
				data: string;
				replace_modified?: boolean;
			}> = [];

			mockPool
				.intercept({ path: uploadPath, method: "POST" })
				.reply(({ body }) => {
					if (typeof body !== "string") {
						throw new Error("Expected JSON request body.");
					}

					const payload = JSON.parse(body);
					requests.push(payload);

					return {
						statusCode: 200,
						data: {
							process: {
								process_id: `process-${requests.length}`,
								status: "queued",
							},
						},
					};
				})
				.times(fileCount);

			const { processes, errors } = await uploader.uploadTranslations({
				collectFileParams: {
					inputDirs: ["./locales"],
					extensions: [".json", ".weird_json"],
				},
				uploadFileParams: { replace_modified: true },
				processUploadFileParams: {
					filenameInferer: (filePath) =>
						path.extname(filePath) === ".weird_json" ? "en.json" : "",
					languageInferer: async (filePath) => {
						if (path.extname(filePath) !== ".weird_json") {
							return "";
						}

						const content = await fs.promises.readFile(filePath, "utf8");
						const translations = JSON.parse(content);

						return Object.keys(translations)[0] ?? "";
					},
				},
			});

			expect(processes).toHaveLength(fileCount);
			expect(errors).toHaveLength(0);
			expect(requests).toHaveLength(fileCount);
			expect(processes.every((p) => p.status === "queued")).toBe(true);

			expect(
				requests.every((request) => request.replace_modified === true),
			).toBe(true);

			expect(requests).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						filename: "en.json",
						lang_iso: "en_GB",
						data: Buffer.from('{"en_GB": {"key": "value"}}').toString("base64"),
					}),
					expect.objectContaining({
						filename: "locales/subdir/nested/de.json",
						lang_iso: "de",
					}),
				]),
			);
		});

		it("returns empty results when no files match", async () => {
			const result = await uploader.uploadTranslations({
				collectFileParams: {
					inputDirs: ["./locales"],
					extensions: [".fake_ext"],
				},
			});

			expect(result).toEqual({ processes: [], errors: [] });
		});

		it("preserves file order when uploads finish out of order", async () => {
			mockPool
				.intercept({
					path: uploadPath,
					method: "POST",
					body: (body) => JSON.parse(body).filename === "locales/en.json",
				})
				.reply(200, {
					process: { process_id: "en", status: "queued" },
				})
				.delay(100);

			mockPool
				.intercept({
					path: uploadPath,
					method: "POST",
					body: (body) => JSON.parse(body).filename === "locales/fr.json",
				})
				.reply(200, {
					process: { process_id: "fr", status: "queued" },
				});

			const { processes, errors } = await uploader.uploadTranslations({
				collectFileParams: {
					inputDirs: ["./locales"],
					extensions: [".json"],
					fileNamePattern: "^(en|fr)\\.json$",
				},
			});

			expect(errors).toHaveLength(0);
			expect(processes.map((p) => p.process_id)).toEqual(["en", "fr"]);
		});

		it("rejects an invalid polling configuration before collecting files", async () => {
			const readdirSpy = vi.spyOn(fs.promises, "readdir");

			await expect(
				uploader.uploadTranslations({
					processUploadFileParams: {
						pollStatuses: true,
						pollInitialWaitTime: -1,
					},
				}),
			).rejects.toThrow("initialWaitTime must be a positive finite value.");

			expect(readdirSpy).not.toHaveBeenCalled();
		});
	});

	describe("Error Handling", () => {
		it("continues uploading when one file fails", async () => {
			const fileCount = 7;
			let uploadCount = 0;

			mockPool
				.intercept({ path: uploadPath, method: "POST" })
				.reply(() => {
					uploadCount++;

					if (uploadCount === 2) {
						return {
							statusCode: 500,
							data: JSON.stringify({
								message: "Internal Server Error",
								code: 500,
							}),
						};
					}

					return {
						statusCode: 200,
						data: JSON.stringify({
							process: {
								process_id: `process-${uploadCount}`,
								status: "queued",
							},
						}),
					};
				})
				.times(fileCount);

			const { processes, errors } = await uploader.uploadTranslations({
				collectFileParams: {
					inputDirs: ["./locales"],
					extensions: [".json"],
				},
			});

			expect(uploadCount).toBe(fileCount);
			expect(processes).toHaveLength(fileCount - 1);
			expect(errors).toHaveLength(1);
			expect(errors[0]?.file).toMatch(/\.json$/);
			expect(errors[0]?.error).toBeInstanceOf(LokaliseError);
		});

		it("reports a custom language inferer failure", async () => {
			const { processes, errors } = await uploader.uploadTranslations({
				collectFileParams: {
					inputDirs: ["./locales"],
					fileNamePattern: "^en\\.json$",
				},
				processUploadFileParams: {
					languageInferer: () => {
						throw new Error("Cannot read language metadata.");
					},
				},
			});

			expect(processes).toHaveLength(0);
			expect(errors).toHaveLength(1);
			expect(errors[0]?.error).toMatchObject({
				message: "Cannot read language metadata.",
			});
		});

		it("rejects a missing input directory", async () => {
			await expect(
				uploader.uploadTranslations({
					collectFileParams: {
						inputDirs: ["./missing-locales"],
					},
				}),
			).rejects.toThrow("Failed to read directory:");
		});
	});

	describe("Polling", () => {
		it("polls each queued process until it reaches a terminal status", async () => {
			const fileCount = 7;
			let uploadCount = 0;

			const pollCounts = new Map<string, number>();
			const terminalStatuses = ["finished", "cancelled", "failed"];

			mockPool
				.intercept({ path: uploadPath, method: "POST" })
				.reply(() => {
					uploadCount++;

					return {
						statusCode: 200,
						data: {
							process: {
								process_id: `poll-process-${uploadCount}`,
								// Status intentionally missing.
							},
						},
					};
				})
				.times(fileCount);

			mockPool
				.intercept({
					method: "GET",
					path: /^\/api2\/projects\/[^/]+\/processes\/[^/?]+/,
				})
				.reply(({ path: requestPath }) => {
					const id = requestPath.split("?")[0]?.split("/").at(-1);

					if (!id) {
						throw new Error("Missing process ID in request.");
					}

					const count = (pollCounts.get(id) ?? 0) + 1;
					pollCounts.set(id, count);

					const index = Number(id.split("-").at(-1));
					const status =
						count === 1
							? "queued"
							: terminalStatuses[index % terminalStatuses.length];

					return {
						statusCode: 200,
						data: {
							process: {
								process_id: id,
								status,
							},
						},
					};
				})
				.times(fileCount * 2);

			const { processes, errors } = await uploader.uploadTranslations({
				collectFileParams: {
					inputDirs: ["./locales"],
					extensions: [".json"],
				},
				processUploadFileParams: {
					pollStatuses: true,
					pollInitialWaitTime: 1,
					pollMaximumWaitTime: 5000,
				},
			});

			expect(uploadCount).toBe(fileCount);
			expect(processes).toHaveLength(fileCount);
			expect(errors).toHaveLength(0);
			expect(pollCounts.size).toBe(fileCount);

			for (const process of processes) {
				expect(terminalStatuses).toContain(process.status);
				expect(pollCounts.get(process.process_id)).toBe(2);
			}
		});
	});
});
