/**
 * Describes the structure of a Lokalise error.
 */
export interface LokaliseError {
	/**
	 * The error message.
	 */
	message: string;

	/**
	 * The error code representing the type of Lokalise API error.
	 */
	code?: number;

	/**
	 * Additional details about the error (optional).
	 */
	details?: Record<string, string | number>;
}
