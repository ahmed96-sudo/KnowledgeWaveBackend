/** Error codes are what the frontend switches on (BACKEND_SPEC §2.3): do not rename them. */
const STATUS = {
  invalidCredentials: 401,
  unauthenticated: 401,
  banned: 403,
  gone: 401,
  forbidden: 403,
  notFound: 404,
  emailTaken: 409,
  conflict: 409,
  cardInvalid: 422,
  cardDeclined: 402,
  invalid: 422,
  validation: 422,
  idempotencyKeyReuse: 422,
  requestInProgress: 409,
  tooManyRequests: 429,
  internal: 500,
} as const;

export type ErrorCode = keyof typeof STATUS;
export type ErrorDetail = { path: string; message: string };

export class ApiError extends Error {
  readonly status: number;
  constructor(
    readonly code: ErrorCode,
    message?: string,
    readonly details: unknown[] = [],
  ) {
    super(message ?? code);
    this.status = STATUS[code];
  }
}
