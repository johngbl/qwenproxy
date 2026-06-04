/**
 * Valid HTTP status codes for operational errors.
 */
export type QwenBridgeStatusCode =
  | 400
  | 401
  | 403
  | 404
  | 429
  | 500
  | 502
  | 503
  | 504;

/**
 * Base class for all QwenBridge operational errors.
 * Provides OpenAI-compatible error formatting.
 */
export abstract class QwenBridgeError extends Error {
  abstract readonly statusCode: QwenBridgeStatusCode;
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

export class ValidationError extends QwenBridgeError {
  readonly statusCode = 400;
  readonly type = "invalid_request_error";
  readonly code = "bad_request";
}

export class AuthError extends QwenBridgeError {
  readonly statusCode = 401;
  readonly type = "authentication_error";
  readonly code = "invalid_api_key";
}

export class ForbiddenError extends QwenBridgeError {
  readonly statusCode = 403;
  readonly type = "permission_error";
  readonly code = "insufficient_quota";
}

export class NotFoundError extends QwenBridgeError {
  readonly statusCode = 404;
  readonly type = "not_found_error";
  readonly code = "resource_not_found";
}

export class UpstreamRateLimit extends QwenBridgeError {
  readonly statusCode = 429;
  readonly type = "rate_limit_error";
  readonly code = "rate_limit_exceeded";
}

export class UpstreamError extends QwenBridgeError {
  readonly statusCode = 502;
  readonly type = "upstream_error";
  readonly code = "upstream_unavailable";
}

export class UpstreamTimeout extends QwenBridgeError {
  readonly statusCode = 504;
  readonly type = "timeout_error";
  readonly code = "upstream_timeout";
}

export class InternalError extends QwenBridgeError {
  readonly statusCode = 500;
  readonly type = "internal_error";
  readonly code = "internal_server_error";
}

export class ServiceUnavailable extends QwenBridgeError {
  readonly statusCode = 503;
  readonly type = "service_unavailable";
  readonly code = "service_degraded";
}
