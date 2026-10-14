import type { LokaliseError as ILokaliseError } from "../interfaces/LokaliseError.js";

/**
 * Represents an error occurring during Lokalise operations.
 */
export class LokaliseError extends Error implements ILokaliseError {
	code?: number;
	details?: Record<string, string | number | boolean>;

	/**
	 * Creates a LokaliseError instance.
	 *
	 * @param message - Error description.
	 * @param code - Optional error code.
	 * @param details - Optional additional error information.
	 */
	constructor(
		message: string,
		code?: number,
		details?: Record<string, string | number | boolean>,
	) {
		super(message);

		this.name = "LokaliseError";

		if (code !== undefined) {
			this.code = code;
		}

		if (details !== undefined) {
			this.details = details;
		}
	}

	/**
	 * Returns the error message with optional code and details.
	 */
	override toString(): string {
		let message = `${this.name}: ${this.message}`;

		if (this.code !== undefined) {
			message += ` (Code: ${this.code})`;
		}

		if (this.details && Object.keys(this.details).length > 0) {
			const details = Object.entries(this.details)
				.map(([key, value]) => `${key}: ${value}`)
				.join(", ");

			message += ` | Details: ${details}`;
		}

		return message;
	}
}
