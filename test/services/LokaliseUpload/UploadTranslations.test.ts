import fs from "node:fs";
import path from "node:path";
import mock from "mock-fs";
import { MockAgent, setGlobalDispatcher } from "undici";
import { LokaliseError } from "../../../lib/errors/LokaliseError.js";
import { LokaliseUpload } from "../../../lib/services/LokaliseUpload.js";
import type { Interceptable } from "../../setup.js";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "../../setup.js";

describe("LokaliseUpload: uploadTranslations()", () => {
	const projectId = "803826145ba90b42d5d860.46800099";
	const apiKey = process.env.API_KEY as string;
	let lokaliseUpload: LokaliseUpload;
	let mockAgent: MockAgent;
	let mockPool: Interceptable;

	beforeAll(() => {
		mockAgent = new MockAgent();
		setGlobalDispatcher(mockAgent);
		mockAgent.disableNetConnect();
	});

	afterAll(() => {
		mockAgent.close();
		mock.restore();
	});

	beforeEach(() => {
		lokaliseUpload = new LokaliseUpload({ apiKey }, { projectId });

		mock({
			"./locales": {
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

		mockPool = mockAgent.get("https://api.lokalise.com");
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe("Basic Behavior", () => {
		it("should collect files and upload them in parallel", async () => {
			const processId = "123abc";
			let uploadCount = 0;
			const jsonFilesCount = 8;

			mockPool
				.intercept({
					path: `/api2/projects/${projectId}/files/upload`,
					method: "POST",
				})
				.reply(() => {
					uploadCount++;
					return {
						statusCode: 200,
						data: {
							process: {
								process_id: `${processId}-${uploadCount}`,
								status: "queued",
							},
						},
					};
				})
				.times(jsonFilesCount);

			const { processes, errors } = await lokaliseUpload.uploadTranslations({
				collectFileParams: {
					inputDirs: ["./locales"],
					extensions: [".json", ".weird_json"],
				},
				uploadFileParams: { replace_modified: true },
				processUploadFileParams: {
					filenameInferer: async (filePath) =>
						path.extname(filePath) === ".weird_json" ? "en.json" : "",
					languageInferer: async (filePath) =>
						path.extname(filePath) === ".weird_json"
							? Object.keys(
									JSON.parse((await fs.promises.readFile(filePath)).toString()),
								)[0]
							: "",
				},
			});

			expect(uploadCount).toEqual(jsonFilesCount);
			expect(processes).toHaveLength(jsonFilesCount);
			expect(errors).toHaveLength(0);
			expect(processes[0].status).toEqual("queued");
		});

		it("should not upload anything when no files were collected", async () => {
			const { processes, errors } = await lokaliseUpload.uploadTranslations({
				collectFileParams: {
					inputDirs: ["./locales"],
					extensions: [".fake_ext"],
				},
			});

			expect(processes).toHaveLength(0);
			expect(errors).toHaveLength(0);
		});
	});

	describe("Error Handling", () => {
		it("should continue uploading other files even if one upload fails", async () => {
			let uploadCount = 0;
			const jsonFilesCount = 7;
			const errorsCount = 1;

			mockPool
				.intercept({
					path: `/api2/projects/${projectId}/files/upload`,
					method: "POST",
				})
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
							process: { process_id: "123abc", status: "queued" },
						}),
					};
				})
				.times(jsonFilesCount);

			const { processes, errors } = await lokaliseUpload.uploadTranslations({
				collectFileParams: { inputDirs: ["./locales"], extensions: [".json"] },
			});

			expect(uploadCount).toEqual(jsonFilesCount);
			expect(processes).toHaveLength(jsonFilesCount - errorsCount);
			expect(errors).toHaveLength(errorsCount);
			expect(errors[0].error).toBeInstanceOf(LokaliseError);
		});
	});

	describe("Polling", () => {
		it("should upload files and poll their statuses until finished", async () => {
			const processIdPrefix = "poll-process";
			let uploadCount = 0;
			const jsonFilesCount = 7;
			const cappedPollAttempts = 2;

			mockPool
				.intercept({
					path: `/api2/projects/${projectId}/files/upload`,
					method: "POST",
				})
				.reply(() => {
					uploadCount++;
					return {
						statusCode: 200,
						data: {
							process: {
								process_id: `${processIdPrefix}-${uploadCount}`,
								// Missing status should be assumed as queued
								// status: "queued",
							},
						},
					};
				})
				.times(jsonFilesCount);

			let pollAttempts = 0;

			mockPool
				.intercept({
					method: "GET",
					path: /api2\/projects\/.+\/processes\/.+/,
				})
				.reply((req) => {
					pollAttempts++;
					const processId = req.path.split("/").pop();

					const status =
						pollAttempts > cappedPollAttempts
							? ["finished", "cancelled", "failed"][pollAttempts % 3]
							: "queued";

					return {
						statusCode: 200,
						data: {
							process: {
								process_id: processId,
								status,
							},
						},
					};
				})
				.times(jsonFilesCount + cappedPollAttempts);

			const { processes, errors } = await lokaliseUpload.uploadTranslations({
				collectFileParams: { inputDirs: ["./locales"], extensions: [".json"] },
				processUploadFileParams: {
					pollStatuses: true,
					pollInitialWaitTime: 500,
					pollMaximumWaitTime: 5000,
				},
			});

			expect(uploadCount).toEqual(jsonFilesCount);
			expect(processes).toHaveLength(jsonFilesCount);
			expect(errors).toHaveLength(0);

			for (const process of processes) {
				expect(["finished", "cancelled", "failed"]).toContain(process.status);
			}
			expect(pollAttempts).toEqual(cappedPollAttempts + jsonFilesCount);
		});
	});
});
