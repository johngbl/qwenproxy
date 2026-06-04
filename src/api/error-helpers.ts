import type { Context } from "hono";
import {
    QproxyError,
    QproxyStatusCode,
    ValidationError,
    AuthError,
    ForbiddenError,
    NotFoundError,
    UpstreamRateLimit,
    UpstreamError,
    UpstreamTimeout,
    InternalError,
    ServiceUnavailable,
} from "../core/errors.js";
import { classifyError } from "./error-classifier.js";

const VALID_STATUSES: ReadonlySet<number> = new Set([
    400, 401, 403, 404, 429, 500, 502, 503, 504,
]);

function isValidStatus(code: number): code is QproxyStatusCode {
    return VALID_STATUSES.has(code);
}

function errorForStatus(status: QproxyStatusCode, message: string): QproxyError {
    switch (status) {
        case 400: return new ValidationError(message);
        case 401: return new AuthError(message);
        case 403: return new ForbiddenError(message);
        case 404: return new NotFoundError(message);
        case 429: return new UpstreamRateLimit(message);
        case 500: return new InternalError(message);
        case 502: return new UpstreamError(message);
        case 503: return new ServiceUnavailable(message);
        case 504: return new UpstreamTimeout(message);
    }
}

/**
 * Sends a standardized OpenAI-compatible error response.
 * Handles QproxyError directly, checks upstreamStatus hints on plain errors,
 * and falls back to the error classifier.
 */
export function sendOpenAIError(
    c: Context,
    err: unknown,
    fallbackStatus?: QproxyStatusCode,
): Response {
    let qproxyErr: QproxyError;

    if (err instanceof QproxyError) {
        qproxyErr = err;
    } else {
        const hint = (err as Record<string, unknown>)?.upstreamStatus;
        if (typeof hint === "number" && isValidStatus(hint)) {
            qproxyErr = errorForStatus(hint, err instanceof Error ? err.message : String(err));
        } else if (fallbackStatus) {
            qproxyErr = errorForStatus(fallbackStatus, err instanceof Error ? err.message : String(err));
        } else {
            qproxyErr = classifyError(err);
        }
    }

    const inner = qproxyErr.toOpenAI().error;
    const body = {
        error: {
            message: inner.message,
            type: inner.type,
            code: inner.code,
            param: inner.param ?? null,
        },
    };
    return c.json(body, qproxyErr.statusCode);
}

/**
 * Creates a QproxyError mapped to the given HTTP status code.
 * Useful for inline error returns without throwing.
 */
export function createError(
    status: QproxyStatusCode,
    message: string,
    param?: string,
): QproxyError {
    const err = errorForStatus(status, message);
    if (param) err.param = param;
    return err;
}
