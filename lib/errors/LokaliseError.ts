import type { LokaliseError as ILokaliseError } from "../interfaces/LokaliseError.js";

/**
 * Represents a custom error.
 */
export class LokaliseError extends Error implements ILokaliseError {
	/**
	 * The error code representing the type of Lokalise API error.
	 */
	code?: number;

	/**
	 * Additional details about the error.
	 */
	details?: Record<string, any>;

	/**
	 * Creates a new instance of LokaliseError.
	 *
	 * @param message - The error message.
	 * @param code - The error code (optional).
	 * @param details - Optional additional details about the error.
	 */
	constructor(message: string, code?: number, details?: Record<string, any>) {
		super(message);
		this.code = code;
		this.details = details;
	}

	/**
	 * Returns a string representation of the error, including code and details.
	 *
	 * @returns The formatted error message.
	 */
	override toString(): string {
		let baseMessage = `LokaliseError: ${this.message}`;
		if (this.code) {
			baseMessage += ` (Code: ${this.code})`;
		}
		if (this.details) {
			const formattedDetails = Object.entries(this.details)
				.map(([key, value]) => `${key}: ${value}`)
				.join(", ");

			baseMessage += ` | Details: ${formattedDetails}`;
		}
		return baseMessage;
	}
}
