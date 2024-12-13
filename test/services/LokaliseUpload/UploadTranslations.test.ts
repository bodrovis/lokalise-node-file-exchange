import fs from "node:fs";
import path from "node:path";
import { json } from "node:stream/consumers";
import type { UploadFileParams } from "@lokalise/node-api";
import mock from "mock-fs";
import { MockAgent, setGlobalDispatcher } from "undici";
import { LokaliseError } from "../../../lib/errors/LokaliseError.js";
import { LokaliseUpload } from "../../../lib/services/LokaliseUpload.js";
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
import type { Interceptable } from "../../setup.js";

describe("LokaliseUpload: uploadTranslations()", () => {
	const projectId = "803826145ba90b42d5d860.46800099";
	const apiKey = process.env.API_KEY as string;
	let lokaliseUpload: LokaliseUpload;
	let mockAgent: MockAgent;
	let mockPool: Interceptable;

	const mockParams = {
		inputDirs: ["./locales"],
		extensions: [".json"],
	};

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

	it("should collect files and upload them in parallel", async () => {
		const processId = "123abc";
		let uploadCount = 0;
		const jsonFilesCount = 8;

		mockPool
			.intercept({
				path: `/api2/projects/${projectId}/files/upload`,
				method: "POST",
			})
			.reply((req) => {
				uploadCount++;
				const body = JSON.parse(
					req.body?.toString() as string,
				) as UploadFileParams;
				if (body.lang_iso.trim() === "") {
					throw new Error(
						`Unexpected lang_iso when uploading ${body.filename}`,
					);
				}

				return {
					statusCode: 200,
					data: {
						project_id: projectId,
						branch: "master",
						process: {
							process_id: `${processId}-${uploadCount}`,
							type: "file-import",
							status: "queued",
							message: "",
							created_by: 20181,
							created_by_email: "test@example.com",
							created_at: "2023-09-21 11:33:19 (Etc/UTC)",
							created_at_timestamp: 1695295999,
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
			uploadFileParams: {
				replace_modified: true,
			},
			processUploadFileParams: {
				languageInferer: async (filePath) => {
					if (path.extname(filePath) === ".weird_json") {
						const fileData = await fs.promises.readFile(filePath);
						const jsonContent = JSON.parse(fileData.toString());
						return Object.keys(jsonContent)[0];
					}
					return "";
				},
			},
		});

		expect(uploadCount).toEqual(jsonFilesCount);
		expect(processes).toHaveLength(jsonFilesCount);
		const process = processes.find(
			(process) => process.process_id === `${processId}-1`,
		);
		expect(process).toBeDefined();
		expect(process?.status).toEqual("queued");
		expect(errors).toHaveLength(0);
	});

	it("should continue uploading other files even if one upload fails", async () => {
		const responseObj = {
			process_id: "123abc",
			type: "file-import",
			status: "queued",
			message: "",
			created_by: 20181,
			created_by_email: "test@example.com",
			created_at: "2023-09-21 11:33:19 (Etc/UTC)",
			created_at_timestamp: 1695295999,
		};
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
						data: {
							message: "Internal Server Error",
							code: 500,
						},
					};
				}

				return {
					statusCode: 200,
					data: JSON.stringify({ process: responseObj }),
				};
			})
			.times(jsonFilesCount);

		const { processes, errors } = await lokaliseUpload.uploadTranslations({
			collectFileParams: mockParams,
		});

		expect(uploadCount).toEqual(jsonFilesCount);
		expect(processes).toHaveLength(jsonFilesCount - errorsCount);
		expect(errors).toHaveLength(errorsCount);
		const errorDetails = errors[0];
		expect(errorDetails.file).toContain("locales");
		expect(errorDetails.error).toBeInstanceOf(LokaliseError);
		const errorObj = errorDetails.error as LokaliseError;
		expect(errorObj.message).toEqual("Internal Server Error");
		expect(errorObj.code).toEqual(500);
		expect(errorObj.details).toEqual({
			reason: "server error without details",
		});
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
						project_id: projectId,
						branch: "master",
						process: {
							process_id: `${processIdPrefix}-${uploadCount}`,
							type: "file-import",
							status: "queued",
							message: "",
							created_by: 20181,
							created_by_email: "test@example.com",
							created_at: "2023-09-21 11:33:19 (Etc/UTC)",
							created_at_timestamp: 1695295999,
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

				const processId = req.path.split("/").pop(); // Extract process_id from URL

				const status =
					pollAttempts > cappedPollAttempts ? "finished" : "queued";

				return {
					statusCode: 200,
					data: {
						project_id: projectId,
						branch: "master",
						process: {
							process_id: processId,
							type: "file-import",
							status,
							message: "",
							created_by: 20181,
							created_by_email: "test@example.com",
							created_at: "2023-09-21 11:33:19 (Etc/UTC)",
							created_at_timestamp: 1695295999,
						},
					},
				};
			})
			.times(jsonFilesCount + cappedPollAttempts);

		const { processes, errors } = await lokaliseUpload.uploadTranslations({
			collectFileParams: {
				inputDirs: ["./locales"],
				extensions: [".json"],
			},
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
			expect(process.status).toEqual("finished");
		}

		expect(pollAttempts).toEqual(cappedPollAttempts + jsonFilesCount);
	});
});
