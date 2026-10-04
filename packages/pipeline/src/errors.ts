/** Domain errors. The API maps `httpStatus` straight onto the response. */
export class DomainError extends Error {
  constructor(
    message: string,
    readonly httpStatus: number,
    readonly code: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class NotFoundError extends DomainError {
  constructor(what: string, id: string) {
    super(`${what} ${id} not found`, 404, 'NOT_FOUND');
  }
}

/** The request is valid but not allowed in the project's current state. */
export class ConflictError extends DomainError {
  constructor(message: string) {
    super(message, 409, 'CONFLICT');
  }
}

/** Thrown by stage handlers for failures that retrying cannot fix (bad input, invalid data). */
export class NonRetryableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'NonRetryableError';
  }
}
