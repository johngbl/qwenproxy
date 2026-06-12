import { z } from "zod";
import type { ResponsesRequest } from "./types.ts";

// ============ Zod schemas ============

const ContentPartSchema = z.object({
  type: z.enum([
    "input_text",
    "output_text",
    "text",
    "input_image",
    "input_file",
  ]),
  text: z.string().optional(),
  image_url: z.string().optional(),
  detail: z.enum(["auto", "low", "high"]).optional(),
  file: z
    .object({
      file_id: z.string().optional(),
      file_data: z.string().optional(),
      filename: z.string().optional(),
    })
    .optional(),
});

const MessageInputSchema = z.object({
  type: z.literal("message").optional(),
  role: z.enum(["user", "assistant", "system", "developer"]),
  content: z.union([z.string(), z.array(ContentPartSchema)]),
});

const FunctionCallInputSchema = z.object({
  type: z.literal("function_call"),
  call_id: z.string().optional(),
  name: z.string().optional(),
  arguments: z.string().optional(),
});

const FunctionCallOutputInputSchema = z.object({
  type: z.literal("function_call_output"),
  call_id: z.string().optional(),
  output: z.string().optional(),
  content: z.union([z.string(), z.array(ContentPartSchema)]).optional(),
  role: z.literal("tool").optional(),
});

const InputMessageSchema = z.union([
  FunctionCallInputSchema,
  FunctionCallOutputInputSchema,
  MessageInputSchema,
]);

// Function tool schema
const FunctionToolSchema = z.object({
  type: z.literal("function"),
  name: z.string().min(1),
  description: z.string().optional(),
  parameters: z.record(z.string(), z.any()).optional(),
  strict: z.boolean().optional(),
});

// Built-in tools (web_search, file_search, shell, etc.) - passthrough
const BuiltInToolSchema = z
  .object({
    type: z.string(),
  })
  .passthrough();

const ToolSchema = z.union([FunctionToolSchema, BuiltInToolSchema]);

const ToolChoiceSchema = z.union([
  z.literal("auto"),
  z.literal("required"),
  z.literal("none"),
  z
    .object({
      type: z.literal("function"),
      name: z.string().optional(),
      function: z.object({ name: z.string() }).optional(),
    })
    .refine((value) => value.name || value.function?.name, {
      message: "Function tool_choice requires 'name' or 'function.name'",
    }),
]);

const ResponsesRequestSchema = z.object({
  model: z.string().min(1),
  input: z.union([z.string(), z.array(InputMessageSchema)]),
  instructions: z.string().nullable().optional(),
  stream: z.boolean().optional(),
  previous_response_id: z.string().nullable().optional(),
  tools: z.array(ToolSchema).nullable().optional(),
  tool_choice: ToolChoiceSchema.nullable().optional(),
  temperature: z.number().min(0).max(2).optional(),
  top_p: z.number().min(0).max(1).optional(),
  max_output_tokens: z.number().int().positive().optional(),
  store: z.boolean().optional(),
  user: z.string().optional(),
  metadata: z.record(z.string(), z.string()).optional(),
  parallel_tool_calls: z.boolean().optional(),
  reasoning: z
    .object({
      effort: z.enum(["low", "medium", "high"]).optional(),
      summary: z.enum(["auto", "concise", "detailed"]).optional(),
    })
    .nullable()
    .optional(),
  text: z
    .object({
      verbosity: z.enum(["low", "medium", "high"]).optional(),
    })
    .nullable()
    .optional(),
  truncation: z.enum(["auto", "disabled"]).optional(),
  service_tier: z.enum(["auto", "default", "flex", "priority"]).optional(),
});

// ============ Validation function ============

export interface ValidationResult {
  valid: boolean;
  error?: string;
  data?: ResponsesRequest;
}

export function validateResponsesRequest(body: unknown): ValidationResult {
  const result = ResponsesRequestSchema.safeParse(body);
  if (!result.success) {
    const firstIssue = result.error.issues[0];
    const path = firstIssue.path.join(".");
    return {
      valid: false,
      error: `Invalid '${path}': ${firstIssue.message}`,
    };
  }

  // Extra validations
  const data = result.data;

  // Validate tool_choice requires tools
  if (
    data.tool_choice != null &&
    data.tool_choice !== "none" &&
    !data.tools?.length
  ) {
    return {
      valid: false,
      error: "'tool_choice' requires at least one tool in 'tools'",
    };
  }

  // Validate previous_response_id is not empty
  if (data.previous_response_id === "") {
    return {
      valid: false,
      error: "'previous_response_id' cannot be empty",
    };
  }

  return { valid: true, data };
}
