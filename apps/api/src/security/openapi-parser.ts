/**
 * OpenAPI 3.x / Swagger 2.0 parser.
 *
 * Normalizes both spec formats into a flat endpoint list that the security scanner
 * and scan-plan generator can consume without understanding spec format details.
 */

export type NormalizedParam = {
  name: string;
  in: "path" | "query" | "header" | "body" | "cookie";
  required: boolean;
  type: string; // "string" | "integer" | "number" | "boolean" | "object" | "array"
  format?: string; // "uuid" | "email" | "date" | "int64" etc.
  enum?: string[];
  example?: unknown;
};

export type NormalizedEndpoint = {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";
  path: string; // e.g. /users/{id}
  operationId?: string;
  summary?: string;
  tags?: string[];
  params: NormalizedParam[];
  bodySchema?: Record<string, unknown>; // raw JSON Schema of the request body
  requiresAuth: boolean; // true if any security requirement is declared
  responseSchemas: Record<number, Record<string, unknown>>; // status → schema
};

export type ParsedApiSpec = {
  title: string;
  version: string;
  baseUrl?: string;
  endpoints: NormalizedEndpoint[];
};

// ── Helpers ───────────────────────────────────────────────────────────────────

const HTTP_METHODS = ["get", "post", "put", "patch", "delete", "head", "options"] as const;

function resolveSchemaType(schema: any): string {
  if (!schema) return "string";
  if (schema.type) return schema.type;
  if (schema.$ref) return "object";
  if (schema.allOf || schema.oneOf || schema.anyOf) return "object";
  return "string";
}

function resolveParam(p: any): NormalizedParam {
  const schema = p.schema ?? p; // OpenAPI 3 uses p.schema; Swagger 2 puts type directly on p
  return {
    name: p.name,
    in: p.in,
    required: p.required ?? p.in === "path",
    type: resolveSchemaType(schema),
    format: schema.format,
    enum: schema.enum,
    example: schema.example ?? p.example,
  };
}

function hasAuthRequirement(operation: any, globalSecurity: unknown[]): boolean {
  if (Array.isArray(operation.security)) {
    if (operation.security.length === 0) return false; // explicitly overrides to no-auth
    return true;
  }
  return globalSecurity.length > 0;
}

// ── OpenAPI 3.x ───────────────────────────────────────────────────────────────

function parseOpenApi3(spec: any): ParsedApiSpec {
  const globalSecurity: unknown[] = spec.security ?? [];
  const servers: any[] = spec.servers ?? [];
  const baseUrl = servers[0]?.url?.replace(/\/$/, "") ?? "";

  const endpoints: NormalizedEndpoint[] = [];

  for (const [path, pathItem] of Object.entries<any>(spec.paths ?? {})) {
    const pathParams: any[] = pathItem.parameters ?? [];

    for (const method of HTTP_METHODS) {
      const op = pathItem[method];
      if (!op) continue;

      const allParams: NormalizedParam[] = [
        ...pathParams.map(resolveParam),
        ...(op.parameters ?? []).map(resolveParam),
      ];

      let bodySchema: Record<string, unknown> | undefined;
      const requestBody = op.requestBody?.content?.["application/json"];
      if (requestBody?.schema) bodySchema = requestBody.schema;

      // Flatten body properties as "body" params for injection testing
      if (bodySchema?.properties) {
        for (const [propName, propSchema] of Object.entries<any>(bodySchema.properties ?? {})) {
          allParams.push({
            name: propName,
            in: "body",
            required: (Array.isArray(bodySchema.required) ? bodySchema.required : []).includes(propName),
            type: resolveSchemaType(propSchema),
            format: propSchema.format,
            enum: propSchema.enum,
          });
        }
      }

      const responseSchemas: Record<number, Record<string, unknown>> = {};
      for (const [status, resp] of Object.entries<any>(op.responses ?? {})) {
        const schema = resp.content?.["application/json"]?.schema;
        if (schema) responseSchemas[Number(status)] = schema;
      }

      endpoints.push({
        method: method.toUpperCase() as NormalizedEndpoint["method"],
        path,
        operationId: op.operationId,
        summary: op.summary,
        tags: op.tags,
        params: allParams,
        bodySchema,
        requiresAuth: hasAuthRequirement(op, globalSecurity),
        responseSchemas,
      });
    }
  }

  return {
    title: spec.info?.title ?? "Untitled API",
    version: spec.info?.version ?? "unknown",
    baseUrl,
    endpoints,
  };
}

// ── Swagger 2.0 ───────────────────────────────────────────────────────────────

function parseSwagger2(spec: any): ParsedApiSpec {
  const globalSecurity: unknown[] = spec.security ?? [];
  const host: string = spec.host ?? "";
  const basePath: string = spec.basePath ?? "";
  const scheme = spec.schemes?.[0] ?? "https";
  const baseUrl = host ? `${scheme}://${host}${basePath}` : "";

  const endpoints: NormalizedEndpoint[] = [];

  for (const [path, pathItem] of Object.entries<any>(spec.paths ?? {})) {
    const pathParams: any[] = pathItem.parameters ?? [];

    for (const method of HTTP_METHODS) {
      const op = pathItem[method];
      if (!op) continue;

      const allParams: NormalizedParam[] = [
        ...pathParams.map(resolveParam),
        ...(op.parameters ?? [])
          .filter((p: any) => p.in !== "body")
          .map(resolveParam),
      ];

      let bodySchema: Record<string, unknown> | undefined;
      const bodyParam = (op.parameters ?? []).find((p: any) => p.in === "body");
      if (bodyParam?.schema) {
        bodySchema = bodyParam.schema;
        for (const [propName, propSchema] of Object.entries<any>(bodyParam.schema.properties ?? {})) {
          allParams.push({
            name: propName,
            in: "body",
            required: (bodyParam.schema.required ?? []).includes(propName),
            type: resolveSchemaType(propSchema as any),
            format: (propSchema as any).format,
            enum: (propSchema as any).enum,
          });
        }
      }

      const responseSchemas: Record<number, Record<string, unknown>> = {};
      for (const [status, resp] of Object.entries<any>(op.responses ?? {})) {
        if ((resp as any).schema) responseSchemas[Number(status)] = (resp as any).schema;
      }

      endpoints.push({
        method: method.toUpperCase() as NormalizedEndpoint["method"],
        path,
        operationId: op.operationId,
        summary: op.summary,
        tags: op.tags,
        params: allParams,
        bodySchema,
        requiresAuth: hasAuthRequirement(op, globalSecurity),
        responseSchemas,
      });
    }
  }

  return {
    title: spec.info?.title ?? "Untitled API",
    version: spec.info?.version ?? "unknown",
    baseUrl,
    endpoints,
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

export function parseApiSpec(raw: unknown): ParsedApiSpec {
  if (!raw || typeof raw !== "object") throw new Error("Spec must be a JSON object.");
  const spec = raw as any;

  if (typeof spec.openapi === "string" && spec.openapi.startsWith("3.")) {
    return parseOpenApi3(spec);
  }
  if (spec.swagger === "2.0") {
    return parseSwagger2(spec);
  }
  throw new Error(
    `Unrecognized spec format. Expected OpenAPI 3.x (openapi: "3.x.x") or Swagger 2.0 (swagger: "2.0"). ` +
    `Got: openapi=${JSON.stringify(spec.openapi)}, swagger=${JSON.stringify(spec.swagger)}.`
  );
}

export function specSummary(spec: ParsedApiSpec) {
  const methodCounts: Record<string, number> = {};
  const tagSet = new Set<string>();
  for (const ep of spec.endpoints) {
    methodCounts[ep.method] = (methodCounts[ep.method] ?? 0) + 1;
    ep.tags?.forEach((t) => tagSet.add(t));
  }
  return {
    endpointCount: spec.endpoints.length,
    authRequiredCount: spec.endpoints.filter((e) => e.requiresAuth).length,
    methodCounts,
    tags: [...tagSet],
  };
}
