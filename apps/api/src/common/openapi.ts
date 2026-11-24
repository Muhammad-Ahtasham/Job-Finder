import { z } from 'zod';

/** Convert a shared zod contract into an OpenAPI-compatible JSON schema for Swagger. */
export function openApiSchema(schema: z.ZodType, io: 'input' | 'output' = 'output') {
  const { $schema: _ignored, ...jsonSchema } = z.toJSONSchema(schema, {
    io,
    unrepresentable: 'any',
  }) as Record<string, unknown>;
  return jsonSchema;
}
