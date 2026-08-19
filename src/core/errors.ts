/**
 * Valid HTTP status codes for operational errors.
 */
export type QwenProxyStatusCode =
  | 400
  | 401
  | 403
  | 404
  | 429
  | 499
  | 500
  | 502
  | 503
  | 504;

/**
 * Base class for all QwenProxy operational errors.
 * Provides OpenAI-compatible error formatting.
 */
export abstract class QwenProxyError extends Error {
  abstract readonly statusCode: QwenProxyStatusCode;
  abstract readonly type: string;
  abstract readonly code: string;
  param?: string;

  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
  }

  toOpenAI() {
    return {
      error: {
        message: this.message,
        type: this.type,
        code: this.code,
        param: this.param,
      },
    };
  }
}

export class ValidationError extends QwenProxyError {
  readonly statusCode = 400;
  readonly type = "invalid_request_error";
  readonly code: string = "bad_request";
}

/** Input exceeds the local safe budget before it reaches the Qwen web API. */
export class ContextLengthExceededError extends ValidationError {
  readonly code = "context_length_exceeded";

  constructor(message: string, param = "messages") {
    super(message);
    this.param = param;
  }
}

export class AuthError extends QwenProxyError {
  readonly statusCode = 401;
  readonly type = "authentication_error";
  readonly code = "invalid_api_key";
}

export class ForbiddenError extends QwenProxyError {
  readonly statusCode = 403;
  readonly type = "permission_error";
  readonly code = "insufficient_quota";
}

export class NotFoundError extends QwenProxyError {
  readonly statusCode = 404;
  readonly type = "not_found_error";
  readonly code = "resource_not_found";
}

export class UpstreamRateLimit extends QwenProxyError {
  readonly statusCode = 429;
  readonly type = "rate_limit_error";
  readonly code = "rate_limit_exceeded";
}

export class UpstreamError extends QwenProxyError {
  readonly statusCode = 502;
  readonly type = "upstream_error";
  readonly code = "upstream_unavailable";
}

export class UpstreamTimeout extends QwenProxyError {
  readonly statusCode = 504;
  readonly type = "timeout_error";
  readonly code = "upstream_timeout";
}

export class InternalError extends QwenProxyError {
  readonly statusCode = 500;
  readonly type = "internal_error";
  readonly code = "internal_server_error";
}

/**
 * The client disconnected (or a same-session retry superseded the request)
 * before the upstream stream could be created. There is no listener left to
 * receive an error body, so this must NOT be surfaced as a 500: it is neither
 * a server fault nor an upstream failure. HTTP 499 (Client Closed Request)
 * keeps the semantics without polluting error metrics.
 */
export class ClientAbortedError extends QwenProxyError {
  readonly statusCode = 499 as QwenProxyStatusCode;
  readonly type = "request_aborted";
  readonly code = "client_aborted";
}

export class ServiceUnavailable extends QwenProxyError {
  readonly statusCode = 503;
  readonly type = "service_unavailable";
  readonly code = "service_degraded";
}
