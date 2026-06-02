import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { lintToolDefinition, ToolLinterError } from "../tools/linter.js";
import type { JsonSchema } from "../tools/types.js";

function validSchema(): JsonSchema {
    return {
        type: "object",
        properties: {
            name: { type: "string" },
            age: { type: "number" },
        },
        required: ["name"],
    };
}

test("lintToolDefinition: valid definition passes", () => {
    assert.doesNotThrow(() =>
        lintToolDefinition("my_tool", "A useful tool", validSchema()),
    );
});

test("lintToolDefinition: empty name throws", () => {
    assert.throws(
        () => lintToolDefinition("", "desc", validSchema()),
        (e: Error) => e instanceof ToolLinterError && e.field === "name",
    );
});

test("lintToolDefinition: invalid characters in name throws", () => {
    assert.throws(
        () => lintToolDefinition("my tool!", "desc", validSchema()),
        (e: Error) => e instanceof ToolLinterError && e.field === "name",
    );
});

test("lintToolDefinition: name exceeding max length throws", () => {
    assert.throws(
        () => lintToolDefinition("a".repeat(65), "desc", validSchema()),
        (e: Error) => e instanceof ToolLinterError && e.field === "name",
    );
});

test("lintToolDefinition: reserved name throws", () => {
    for (const name of ["exec", "eval", "system", "import", "function"]) {
        assert.throws(
            () => lintToolDefinition(name, "desc", validSchema()),
            (e: Error) => e instanceof ToolLinterError && e.field === "name",
        );
    }
});

test("lintToolDefinition: reserved name is case-insensitive", () => {
    assert.throws(
        () => lintToolDefinition("EXEC", "desc", validSchema()),
        (e: Error) => e instanceof ToolLinterError && e.field === "name",
    );
});

test("lintToolDefinition: empty description throws", () => {
    assert.throws(
        () => lintToolDefinition("my_tool", "", validSchema()),
        (e: Error) => e instanceof ToolLinterError && e.field === "description",
    );
});

test("lintToolDefinition: whitespace-only description throws", () => {
    assert.throws(
        () => lintToolDefinition("my_tool", "   ", validSchema()),
        (e: Error) => e instanceof ToolLinterError && e.field === "description",
    );
});

test("lintToolDefinition: description exceeding max length throws", () => {
    assert.throws(
        () => lintToolDefinition("my_tool", "x".repeat(501), validSchema()),
        (e: Error) => e instanceof ToolLinterError && e.field === "description",
    );
});

test("lintToolDefinition: invalid schema type throws", () => {
    const schema: JsonSchema = { type: "invalid" as any, properties: {} };
    assert.throws(
        () => lintToolDefinition("my_tool", "desc", schema),
        (e: Error) =>
            e instanceof ToolLinterError &&
            e.field === "parameters" &&
            e.path === "$",
    );
});

test("lintToolDefinition: required field not in properties throws", () => {
    const schema: JsonSchema = {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name", "missing_field"],
    };
    assert.throws(
        () => lintToolDefinition("my_tool", "desc", schema),
        (e: Error) =>
            e instanceof ToolLinterError && e.field === "parameters",
    );
});

test("lintToolDefinition: nested schema validation works", () => {
    const schema: JsonSchema = {
        type: "object",
        properties: {
            items: {
                type: "array",
                items: { type: "badtype" as any },
            },
        },
    };
    assert.throws(
        () => lintToolDefinition("my_tool", "desc", schema),
        (e: Error) =>
            e instanceof ToolLinterError &&
            e.field === "parameters" &&
            e.path?.includes("items"),
    );
});

test("lintToolDefinition: circular reference does not infinite loop", () => {
    const schema: JsonSchema = { type: "object", properties: {} };
    (schema.properties as any).self = schema;
    assert.doesNotThrow(() =>
        lintToolDefinition("my_tool", "desc", schema),
    );
});

test("lintToolDefinition: anyOf/oneOf/allOf validation", () => {
    const schema: JsonSchema = {
        type: "object",
        properties: {
            value: {
                type: "string",
                anyOf: [{ type: "string" }, { type: "number" }],
            },
        },
    };
    assert.doesNotThrow(() =>
        lintToolDefinition("my_tool", "desc", schema),
    );
});

test("lintToolDefinition: valid name with hyphens and underscores", () => {
    assert.doesNotThrow(() =>
        lintToolDefinition("my-tool_v2", "desc", validSchema()),
    );
});
