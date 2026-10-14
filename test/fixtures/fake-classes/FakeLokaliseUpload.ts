import type { QueuedProcess, UploadFileParams } from "@lokalise/node-api";
import { LokaliseUpload } from "../../../lib/services/LokaliseUpload.js";

// Public morozov
export class FakeLokaliseUpload extends LokaliseUpload {
	public override async uploadSingleFile(
		uploadParams: UploadFileParams,
	): Promise<QueuedProcess> {
		return await super.uploadSingleFile(uploadParams);
	}
}
