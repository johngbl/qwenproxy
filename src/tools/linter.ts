/*
 * File: linter.ts
 * Project: qwenproxy
 * Pre-registration validator for tool
 */

import type { JsonSchema } from "./types.js";

const VALID_TYPES = new Set([
    "string",
    "number",
    "integer",
    "boolean",
    "object",
    "array",
    "null",
]);

const RESERVED_NAMES = new Set(["exec", "eval", "system", "import", "function"]);

const NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;
const MAX_NAME_LENGTH = 64;
const MAX_DESC_LENGTH = 500;

export class ToolLinterError extends Error {
    public readonly field: "name" | "description" | "parameters";
    public readonly path?: string;

    constructor(
        message: string,
        field: "name" | "description" | "parameters",
        path?: string,
    ) {
        super(message);
        this.name = "ToolLinterError";
        this.field = field;
        this.path = path;
    }
}

/**
 * Validates a tool definition before registration.
 */
export function lintToolDefinition(
    name: string,
    description: string,
    parameters: JsonSchema,
): void {
    validateToolName(name);
    validateToolDescription(description);
    validateJsonSchema(parameters, "$");
}

function validateToolName(name: string): void {
    if (!name || typeof name !== "string") {
        throw new ToolLinterError("Tool name must be a non-empty string", "name");
    }
    if (name.length > MAX_NAME_LENGTH) {
        throw new ToolLinterError(
            `Tool name exceeds maximum length of ${MAX_NAME_LENGTH} characters (got ${name.length})`,
            "name",
        );
    }
    if (!NAME_PATTERN.test(name)) {
        throw new ToolLinterError(
            `Tool name '${name}' contains invalid characters. Only alphanumeric, underscore and hyphen are allowed`,
            "name",
        );
    }
    if (RESERVED_NAMES.has(name.toLowerCase())) {
        throw new ToolLinterError(
            `Tool name '${name}' is reserved and cannot be used`,
            "name",
        );
    }
}

function validateToolDescription(description: string): void {
    if (!description || typeof description !== "string") {
        throw new ToolLinterError(
            "Tool description must be a non-empty string",
            "description",
        );
    }
    if (!description.trim()) {
        throw new ToolLinterError(
            "Tool description must contain non-whitespace characters",
            "description",
        );
    }
    if (description.length > MAX_DESC_LENGTH) {
        throw new ToolLinterError(
            `Tool description exceeds maximum length of ${MAX_DESC_LENGTH} characters (got ${description.length})`,
            "description",
        );
    }
}

function validateJsonSchema(schema: JsonSchema, path: string, visited = new Set<JsonSchema>()): void {
    if (visited.has(schema)) {
        return; // if circular reference detected, skip
    }
    visited.add(schema);

    if (!VALID_TYPES.has(schema.type)) {
        throw new ToolLinterError(
            `Invalid schema type '${schema.type}' at ${path}`,
            "parameters",
            path,
        );
    }

    if (schema.properties) {
        for (const [propName, propSchema] of Object.entries(schema.properties)) {
            validateJsonSchema(propSchema, `${path}.properties.${propName}`, visited);
        }
    }

    if (schema.required && schema.properties) {
        for (const reqField of schema.required) {
            if (!(reqField in schema.properties)) {
                throw new ToolLinterError(
                    `Required field '${reqField}' is not defined in properties at ${path}`,
                    "parameters",
                    path,
                );
            }
        }
    }

    if (schema.type === "array" && schema.items) {
        validateJsonSchema(schema.items, `${path}.items`, visited);
    }

    if (schema.anyOf) {
        for (let i = 0; i < schema.anyOf.length; i++) {
            validateJsonSchema(schema.anyOf[i], `${path}.anyOf[${i}]`, visited);
        }
    }

    if (schema.oneOf) {
        for (let i = 0; i < schema.oneOf.length; i++) {
            validateJsonSchema(schema.oneOf[i], `${path}.oneOf[${i}]`, visited);
        }
    }

    if (schema.allOf) {
        for (let i = 0; i < schema.allOf.length; i++) {
            validateJsonSchema(schema.allOf[i], `${path}.allOf[${i}]`, visited);
        }
    }

    if (schema.not) {
        validateJsonSchema(schema.not, `${path}.not`, visited);
    }
}
