/** An error the API returns to the caller as `{ error: { code, message } }` with `status`. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (code: string, message: string, details?: unknown) =>
  new ApiError(400, code, message, details);
export const unauthorized = (message = "Missing or invalid API key") =>
  new ApiError(401, "unauthorized", message);
export const forbidden = (code: string, message: string) => new ApiError(403, code, message);
export const notFound = (what: string) => new ApiError(404, "not_found", `${what} not found`);
export const conflict = (code: string, message: string) => new ApiError(409, code, message);
export const paymentRequired = (code: string, message: string) => new ApiError(402, code, message);
