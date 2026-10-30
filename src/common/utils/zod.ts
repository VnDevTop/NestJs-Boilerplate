import { z, ZodSchema } from 'zod';

export function validateWithZod<T>(schema: ZodSchema<T>, data: unknown): T {
  return schema.parse(data);
}

export function safeValidateWithZod<T>(
  schema: ZodSchema<T>,
  data: unknown,
): { success: true; data: T } | { success: false; error: z.ZodError } {
  const result = schema.safeParse(data);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: result.error };
}