import contract from "@cachet/api-client/openapi.json";

/**
 * The API reference page is drawn from the contract the server exports
 * (`pnpm openapi:export`), read at build time. Nothing is described by hand,
 * so the page cannot drift from the routes; and no documentation library
 * ships to the browser.
 */
type Schema = {
  $ref?: string;
  type?: string | string[];
  format?: string;
  description?: string;
  example?: unknown;
  enum?: unknown[];
  items?: Schema;
  properties?: Record<string, Schema>;
  required?: string[];
  oneOf?: Schema[];
  anyOf?: Schema[];
  allOf?: Schema[];
  minimum?: number;
  maximum?: number;
  maxLength?: number;
};

type Parameter = {
  name: string;
  in: string;
  required?: boolean;
  description?: string;
  schema?: Schema;
};

type Response = {
  description?: string;
  headers?: Record<string, { description?: string }>;
  content?: Record<string, { schema?: Schema }>;
};

type Operation = {
  tags?: string[];
  summary?: string;
  description?: string;
  parameters?: Parameter[];
  requestBody?: { content?: Record<string, { schema?: Schema }> };
  responses: Record<string, Response>;
};

const document = contract as unknown as {
  info: { title: string; version: string; description?: string };
  paths: Record<string, Record<string, Operation>>;
  components: { schemas: Record<string, Schema> };
};

export const apiVersion = document.info.version;

export type Field = { name: string; type: string; required: boolean; description: string };

export type Endpoint = {
  id: string;
  method: string;
  path: string;
  summary: string;
  description: string;
  parameters: {
    name: string;
    where: string;
    type: string;
    required: boolean;
    description: string;
  }[];
  body: { schema: string | null; fields: Field[]; example: string | null } | null;
  responses: {
    status: string;
    description: string;
    schema: string | null;
    type: string;
    headers: { name: string; description: string }[];
  }[];
};

const refName = (schema: Schema | undefined) => schema?.$ref?.split("/").pop() ?? null;

/** A schema said in a few words: `string`, `integer`, `AssetSummaryResponse[]`, `string or null`. */
export function typeOf(schema: Schema | undefined): string {
  if (!schema) return "";
  const named = refName(schema);
  if (named) return named;
  const variants = schema.oneOf ?? schema.anyOf;
  if (variants) return variants.map(typeOf).filter(Boolean).join(" or ");
  if (schema.allOf) return schema.allOf.map(typeOf).filter(Boolean).join(" and ");
  if (schema.enum) return schema.enum.map((value) => JSON.stringify(value)).join(" | ");
  const types = Array.isArray(schema.type) ? schema.type : [schema.type ?? "object"];
  return types
    .map((type) => (type === "array" ? `${typeOf(schema.items) || "value"}[]` : type))
    .join(" or ");
}

function fieldsOf(schema: Schema | undefined): Field[] {
  const resolved = refName(schema) ? document.components.schemas[refName(schema)!] : schema;
  if (!resolved?.properties) return [];
  const required = new Set(resolved.required ?? []);
  return Object.entries(resolved.properties).map(([name, property]) => ({
    name,
    type: typeOf(property),
    required: required.has(name),
    description: property.description ?? "",
  }));
}

/** A request body made of the examples the contract gives, when it gives any. */
function exampleOf(schema: Schema | undefined): string | null {
  const resolved = refName(schema) ? document.components.schemas[refName(schema)!] : schema;
  if (!resolved?.properties) return null;
  const required = new Set(resolved.required ?? []);
  const entries = Object.entries(resolved.properties)
    .filter(([name, property]) => property.example !== undefined && required.has(name))
    .map(([name, property]) => [name, property.example] as const);
  return entries.length > 0 ? JSON.stringify(Object.fromEntries(entries)) : null;
}

const METHOD_ORDER = ["get", "post", "put", "delete"];

function endpointsOf(tag: string): Endpoint[] {
  const found: Endpoint[] = [];
  for (const [path, operations] of Object.entries(document.paths)) {
    for (const method of METHOD_ORDER) {
      const operation = operations[method];
      if (!operation || (operation.tags?.[0] ?? "other") !== tag) continue;
      const [summary = "", ...rest] = (operation.description ?? operation.summary ?? "").split(
        "\n\n",
      );
      const bodySchema = operation.requestBody?.content?.["application/json"]?.schema;
      found.push({
        id: `${method}-${path.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "")}`,
        method: method.toUpperCase(),
        path,
        summary: (operation.summary ?? summary).replace(/\n/g, " "),
        description: (operation.summary ? [summary, ...rest] : rest).join("\n\n"),
        parameters: (operation.parameters ?? []).map((parameter) => ({
          name: parameter.name,
          where: parameter.in,
          type: typeOf(parameter.schema),
          required: parameter.required ?? false,
          description: parameter.description ?? "",
        })),
        body: bodySchema
          ? {
              schema: refName(bodySchema),
              fields: fieldsOf(bodySchema),
              example: exampleOf(bodySchema),
            }
          : null,
        responses: Object.entries(operation.responses).map(([status, response]) => {
          const [type, media] = Object.entries(response.content ?? {})[0] ?? ["", undefined];
          return {
            status,
            description: response.description ?? "",
            schema: typeOf(media?.schema) || null,
            type,
            headers: Object.entries(response.headers ?? {}).map(([name, header]) => ({
              name,
              description: header.description ?? "",
            })),
          };
        }),
      });
    }
  }
  return found;
}

/** The groups, in the order a reader needs them; the operator's surface last. */
const GROUPS: { tag: string; title: string; note: string }[] = [
  {
    tag: "registry",
    title: "Registry",
    note: "What the chain says, read for you: assets, issuers, public history, and what is kept of assets a reset took.",
  },
  {
    tag: "metadata",
    title: "Sealed metadata",
    note: "Content-addressed bundles. The hash is in the asset id, so check what you are served against it.",
  },
  {
    tag: "chain",
    title: "Chain and relay",
    note: "The tip, raw blocks for scanning on your own machine, and the relay for transactions signed elsewhere.",
  },
  {
    tag: "snapshot",
    title: "Signed snapshot",
    note: "The whole registry as one deterministic, signed document, for mirrors.",
  },
  {
    tag: "issuance",
    title: "Server wallet",
    note: "Minting, transfers and burns signed by the instance itself. A read-only instance, like the public one, answers 403: mint from your browser instead.",
  },
  {
    tag: "ops",
    title: "Operator",
    note: "Liveness, and a token-gated surface that answers 404 unless the operator configured it.",
  },
];

export const reference = GROUPS.map((group) => ({
  ...group,
  endpoints: endpointsOf(group.tag),
})).filter((group) => group.endpoints.length > 0);

export const schemas = Object.entries(document.components.schemas)
  .map(([name, schema]) => ({
    name,
    description: schema.description ?? "",
    fields: fieldsOf(schema),
  }))
  .filter((schema) => schema.fields.length > 0)
  .sort((a, b) => a.name.localeCompare(b.name));
