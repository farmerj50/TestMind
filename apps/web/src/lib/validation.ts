// apps/web/src/lib/validation.ts
import { z } from "zod";

export const projectSchema = z.object({
  name: z.string().trim().min(1, "Name is required"),
  repoUrl: z
    .string()
    .trim()
    .optional()
    .transform((v) => (v === "" ? undefined : v))
    .refine((v) => !v || z.string().url().safeParse(v).success, { message: "Enter a valid URL" }),
});

export type ProjectInput = z.infer<typeof projectSchema>;

export function validateProject(input: ProjectInput) {
  const parsed = projectSchema.safeParse(input);
  if (!parsed.success) {
    const f = parsed.error.flatten().fieldErrors;
    return {
      ok: false as const,
      errors: {
        name: f.name?.[0],
        repoUrl: f.repoUrl?.[0],
      },
    };
  }
  return { ok: true as const, data: parsed.data };
}
