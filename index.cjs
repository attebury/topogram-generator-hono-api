const manifest = require("./topogram-generator.json");

function renderPackageJson({ hasDatabase = false } = {}) {
  return `${JSON.stringify({
    private: true,
    type: "module",
    scripts: {
      dev: "tsx src/index.ts",
      check: "tsc --noEmit",
      build: "tsc --noEmit",
      "seed:demo": "node ./scripts/seed-demo.mjs",
      start: "node dist/index.js"
    },
    dependencies: {
      "@hono/node-server": "^1.13.7",
      hono: "^4.6.14",
      ...(hasDatabase ? { "@prisma/client": "^5.22.0" } : {})
    },
    devDependencies: {
      "@types/node": "^22.10.2",
      ...(hasDatabase ? { prisma: "^5.22.0" } : {}),
      tsx: "^4.19.2",
      typescript: "^5.6.3"
    }
  }, null, 2)}\n`;
}

function renderTsconfig() {
  return `${JSON.stringify({
    compilerOptions: {
      target: "ES2022",
      module: "ESNext",
      moduleResolution: "Bundler",
      types: ["node"],
      strict: true,
      esModuleInterop: true,
      forceConsistentCasingInFileNames: true,
      skipLibCheck: true,
      resolveJsonModule: true
    },
    include: ["src/**/*.ts"]
  }, null, 2)}\n`;
}

function routePath(path) {
  return String(path || "/").replace(/:([A-Za-z0-9_]+)/g, ":$1");
}

function routeSuccess(route) {
  return Number(route.success || route.successStatus || 200);
}

function renderIndexTs(projection, component, { hasDatabase = false } = {}) {
  const persistenceImport = hasDatabase ? 'import { createRepository } from "./lib/persistence/repository.js";\n' : "";
  const persistenceSetup = hasDatabase ? "const repository = createRepository();\n" : "";
  const routes = (projection.http || []).map((route) => {
    const method = String(route.method || "GET").toLowerCase();
    const bodyLine = ["post", "put", "patch"].includes(method) ? "    body: await c.req.json().catch(() => null)," : "";
    const persistenceLine = hasDatabase ? "    persistence: repository.describe()," : "";
    return `app.${method}("${routePath(route.path)}", async (c) => c.json({
  ok: true,
  capability: "${route.capabilityId}",
  input: {
    params: c.req.param(),
    query: c.req.query(),${bodyLine ? `\n${bodyLine}` : ""}
  },${persistenceLine ? `\n${persistenceLine}` : ""}
}, ${routeSuccess(route)} as any));`;
  }).join("\n");
  const port = Number(component?.port || 3000);
  return `import { serve } from "@hono/node-server";
import { Hono } from "hono";
${persistenceImport}

const app = new Hono();
${persistenceSetup}

app.get("/health", (c) => c.json({ ok: true, service: "${projection.id}" }));
app.get("/ready", (c) => c.json({ ok: true, ready: true, service: "${projection.id}", database: ${hasDatabase ? "repository.describe()" : "null"} }));
${routes}

const port = Number(process.env.PORT || ${port});
serve({ fetch: app.fetch, port });
console.log(\`${projection.id} listening on http://localhost:\${port}\`);
`;
}

function renderPersistenceRepository(component) {
  const dbId = component?.databaseComponent?.id || component?.database || "database";
  return `export function createRepository() {
  return {
    describe() {
      return {
        component: "${dbId}",
        urlConfigured: Boolean(process.env.DATABASE_URL)
      };
    }
  };
}
`;
}

function renderPrismaSchema(component) {
  const provider = component?.databaseComponent?.projection?.platform === "db_sqlite" ? "sqlite" : "postgresql";
  return `generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "${provider}"
  url      = env("DATABASE_URL")
}
`;
}

function pascal(value, fallback = "Resource") {
  const base = String(value || fallback).replace(/^(entity|enum|cap)_/, "");
  const result = base.split(/[^A-Za-z0-9]+/).filter(Boolean).map((part) => `${part[0].toUpperCase()}${part.slice(1)}`).join("");
  return result || fallback;
}

function slug(value, fallback = "resource") {
  return String(value || fallback).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || fallback;
}

function statementsArray(graph) {
  if (Array.isArray(graph?.statements)) return graph.statements;
  return Object.values(graph?.statements || {});
}

function enumForType(graph, fieldType) {
  const normalized = String(fieldType || "").replace(/^enum_/, "");
  return statementsArray(graph).find((statement) => (
    statement.kind === "enum" &&
    (statement.id === fieldType || statement.id === `enum_${normalized}` || statement.id === normalized)
  )) || null;
}

function isRequired(column) {
  return column.required === true || column.requiredness === "required";
}

function relationTargetTable(tables, relation) {
  const targetId = relation?.target?.id;
  return tables.find((table) => table.entity?.id === targetId)?.table || slug(String(targetId || "").replace(/^entity_/, ""));
}

function prismaType(column) {
  if (column.enumValues) return pascal(column.fieldType);
  switch (String(column.fieldType || "text")) {
    case "integer":
      return "Int";
    case "number":
      return "Float";
    case "boolean":
      return "Boolean";
    case "datetime":
      return "DateTime";
    default:
      return "String";
  }
}

function prismaDbAttr(column) {
  if (column.enumValues) return "";
  if (column.fieldType === "uuid") return " @db.Uuid";
  if (column.fieldType === "datetime") return " @db.Timestamptz(3)";
  return "";
}

function tablesForContext(context) {
  const dbContract = context.contracts?.db;
  const rawTables = Array.isArray(dbContract?.tables) ? dbContract.tables : [];
  const tables = rawTables.length > 0 ? rawTables : tablesFromGraph(context);
  return tables.map((table) => ({
    ...table,
    columns: (table.columns || []).map((column) => {
      const enumStatement = enumForType(context.graph || {}, column.fieldType);
      return enumStatement ? { ...column, enumValues: enumStatement.values || [] } : column;
    })
  }));
}

function tablesFromGraph(context) {
  const graph = context.graph || {};
  const statements = statementsArray(graph);
  const byId = new Map(statements.map((statement) => [statement.id, statement]));
  const dbProjectionId = context.component?.databaseComponent?.projection?.id || context.component?.databaseComponent?.projection || context.component?.database || null;
  const projection = typeof dbProjectionId === "string"
    ? statements.find((statement) => statement.kind === "projection" && statement.id === dbProjectionId)
    : context.component?.databaseComponent?.projection;
  if (!projection) return [];
  const tableByEntity = new Map((projection.dbTables || []).map((entry) => [entry.entity?.id, entry.table]));
  const columnByEntityField = new Map((projection.dbColumns || []).map((entry) => [`${entry.entity?.id}:${entry.field}`, entry.column]));
  const primaryByEntity = new Map();
  for (const key of projection.dbKeys || []) {
    if (key.keyType === "primary") primaryByEntity.set(key.entity?.id, key.fields || []);
  }
  const indexesByEntity = new Map();
  for (const index of projection.dbIndexes || []) {
    if (!indexesByEntity.has(index.entity?.id)) indexesByEntity.set(index.entity?.id, []);
    indexesByEntity.get(index.entity?.id).push({ type: index.indexType || "index", fields: index.fields || [] });
  }
  const relationsByEntity = new Map();
  for (const relation of projection.dbRelations || []) {
    if (!relationsByEntity.has(relation.entity?.id)) relationsByEntity.set(relation.entity?.id, []);
    relationsByEntity.get(relation.entity?.id).push({
      field: relation.field,
      onDelete: relation.onDelete || null,
      target: relation.target
    });
  }
  return (projection.realizes || [])
    .map((entry) => byId.get(entry.id || entry.target?.id))
    .filter(Boolean)
    .map((entity) => {
      const indexes = indexesByEntity.get(entity.id) || [];
      return {
        table: tableByEntity.get(entity.id) || slug(entity.name || entity.id),
        entity: { id: entity.id, name: entity.name },
        columns: (entity.fields || []).map((field) => ({
          name: columnByEntityField.get(`${entity.id}:${field.name}`) || field.name,
          sourceField: field.name,
          fieldType: field.fieldType || field.type || "text",
          requiredness: field.requiredness || (field.required === false ? "optional" : "required"),
          defaultValue: field.defaultValue ?? null
        })),
        primaryKey: primaryByEntity.get(entity.id) || (entity.keys || []).find((key) => key.type === "primary")?.fields || [],
        uniques: indexes.filter((index) => index.type === "unique").map((index) => index.fields),
        indexes,
        relations: relationsByEntity.get(entity.id) || []
      };
    });
}

function renderProviderPrismaSchema(context) {
  const tables = tablesForContext(context);
  if (tables.length === 0) return renderPrismaSchema(context.component || {});
  const lines = [
    "generator client {",
    '  provider = "prisma-client-js"',
    "}",
    "",
    "datasource db {",
    '  provider = "postgresql"',
    '  url      = env("DATABASE_URL")',
    "}",
    ""
  ];
  const emittedEnums = new Set();
  for (const table of tables) {
    for (const column of table.columns || []) {
      if (!column.enumValues || emittedEnums.has(column.fieldType)) continue;
      emittedEnums.add(column.fieldType);
      lines.push(`enum ${pascal(column.fieldType)} {`);
      for (const value of column.enumValues) lines.push(`  ${value}`);
      lines.push("}");
      lines.push("");
    }
  }
  const relationBackrefs = new Map();
  for (const table of tables) {
    for (const relation of table.relations || []) {
      const targetTable = relationTargetTable(tables, relation);
      if (!relationBackrefs.has(targetTable)) relationBackrefs.set(targetTable, []);
      relationBackrefs.get(targetTable).push({
        fromTable: table.table,
        fromModel: pascal(table.entity?.id || table.table),
        field: relation.field,
        relationName: `${pascal(table.entity?.id || table.table)}_${relation.field}_to_${pascal(relation.target?.id || targetTable)}`
      });
    }
  }
  for (const table of tables) {
    const model = pascal(table.entity?.id || table.table);
    const relationFields = new Map((table.relations || []).map((relation) => [relation.field, relation]));
    lines.push(`model ${model} {`);
    for (const column of table.columns || []) {
      const field = column.sourceField || column.name;
      const attrs = [];
      if ((table.primaryKey || []).length === 1 && table.primaryKey[0] === column.name) attrs.push("@id");
      if ((table.uniques || []).some((fields) => fields.length === 1 && fields[0] === column.name)) attrs.push("@unique");
      if (column.defaultValue != null) {
        attrs.push(column.enumValues || column.fieldType === "boolean" || column.fieldType === "integer" || column.fieldType === "number"
          ? `@default(${String(column.defaultValue)})`
          : `@default(${JSON.stringify(String(column.defaultValue))})`);
      }
      lines.push(`  ${field} ${prismaType(column)}${isRequired(column) ? "" : "?"}${prismaDbAttr(column)}${attrs.length ? ` ${attrs.join(" ")}` : ""}`);
      const relation = relationFields.get(column.name);
      if (relation) {
        const targetModel = pascal(relation.target?.id || relationTargetTable(tables, relation));
        const relationName = `${model}_${field}_to_${targetModel}`;
        lines.push(`  ${field.replace(/_id$/, "")} ${targetModel}${isRequired(column) ? "" : "?"} @relation("${relationName}", fields: [${field}], references: [${relation.target.field}])`);
      }
    }
    for (const backref of relationBackrefs.get(table.table) || []) {
      lines.push(`  ${backref.fromTable} ${backref.fromModel}[] @relation("${backref.relationName}")`);
    }
    if ((table.primaryKey || []).length > 1) lines.push(`  @@id([${table.primaryKey.join(", ")}])`);
    for (const fields of table.uniques || []) {
      if (fields.length > 1) lines.push(`  @@unique([${fields.join(", ")}])`);
    }
    for (const index of table.indexes || []) {
      if (index.type === "index") lines.push(`  @@index([${index.fields.join(", ")}])`);
    }
    if (table.table !== model) lines.push(`  @@map("${table.table}")`);
    lines.push("}");
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function routeTypeNames(contract) {
  const names = new Set();
  for (const route of contract.routes || []) {
    const method = route.repositoryMethod || repositoryMethodName(route.capabilityId);
    names.add(`${pascal(method)}Input`);
    names.add(`${pascal(method)}Result`);
    if (route.responseContract?.mode && route.responseContract.mode !== "item") names.add(`${pascal(method)}ResultItem`);
  }
  return [...names].sort();
}

function repositoryMethodName(capabilityId) {
  const base = String(capabilityId || "").replace(/^cap_/, "");
  return base.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
}

function tsTypeForSchema(schema = {}) {
  if (Array.isArray(schema.enum)) return schema.enum.map((value) => `"${value}"`).join(" | ");
  if (schema.type === "integer" || schema.type === "number") return "number";
  if (schema.type === "boolean") return "boolean";
  return "string";
}

function renderFieldsInterface(name, fields = []) {
  const lines = [`export interface ${name} {`];
  for (const field of fields) {
    lines.push(`  ${field.name}${field.required ? "" : "?"}: ${tsTypeForSchema(field.schema)};`);
  }
  lines.push("}");
  return `${lines.join("\n")}\n`;
}

function renderResultTypes(name, responseContract) {
  if (!responseContract) return `export type ${name} = Record<string, unknown>;\n`;
  if (!responseContract.mode || responseContract.mode === "item") {
    return renderFieldsInterface(name, responseContract.fields || []);
  }
  const itemName = `${name}Item`;
  const lines = [renderFieldsInterface(itemName, responseContract.fields || []).trimEnd(), "", `export interface ${name} {`];
  lines.push(`  items: ${itemName}[];`);
  if (responseContract.mode === "paged") {
    lines.push("  page: number;");
    lines.push("  page_size: number;");
    lines.push("  total: number;");
  }
  if (responseContract.mode === "cursor") {
    lines.push(`  ${responseContract.cursor?.responseNext || "next_cursor"}: string;`);
    if (responseContract.cursor?.responsePrev) lines.push(`  ${responseContract.cursor.responsePrev}?: string;`);
    if (responseContract.total?.included) lines.push("  total?: number;");
  }
  lines.push("}");
  return `${lines.join("\n")}\n`;
}

function renderPersistenceTypes(contract, repositoryReference) {
  const chunks = [];
  const usedTypes = new Set();
  const additionalDeclarations = new Map();
  for (const declaration of repositoryReference.additionalTypeDeclarations || []) {
    const match = String(declaration).match(/export\s+interface\s+([A-Za-z0-9_]+)/);
    if (match) additionalDeclarations.set(match[1], `${String(declaration).trimEnd()}\n`);
  }
  for (const route of contract.routes || []) {
    const method = route.repositoryMethod || repositoryMethodName(route.capabilityId);
    const inputName = `${pascal(method)}Input`;
    const resultName = `${pascal(method)}Result`;
    usedTypes.add(inputName);
    usedTypes.add(resultName);
    if (route.responseContract?.mode && route.responseContract.mode !== "item") usedTypes.add(`${resultName}Item`);
    chunks.push(additionalDeclarations.get(inputName) || renderFieldsInterface(inputName, route.requestContract?.fields || []));
    chunks.push(additionalDeclarations.get(resultName) || renderResultTypes(resultName, route.responseContract));
  }
  for (const [typeName, declaration] of additionalDeclarations) {
    if (usedTypes.has(typeName)) continue;
    chunks.push(declaration);
  }
  return `${chunks.join("\n").trimEnd()}\n`;
}

function renderRepositoriesInterface(contract, repositoryReference) {
  const usedTypes = new Set();
  for (const route of contract.routes || []) {
    const method = route.repositoryMethod || repositoryMethodName(route.capabilityId);
    usedTypes.add(`${pascal(method)}Input`);
    usedTypes.add(`${pascal(method)}Result`);
  }
  for (const typeName of repositoryReference.additionalTypeNames || []) usedTypes.add(typeName);
  const lines = ["import type {", ...[...usedTypes].sort().map((typeName) => `  ${typeName},`), '} from "./types";', "", `export interface ${repositoryReference.repositoryInterfaceName} {`];
  for (const route of contract.routes || []) {
    const method = route.repositoryMethod || repositoryMethodName(route.capabilityId);
    lines.push(`  ${method}(input: ${pascal(method)}Input): Promise<${pascal(method)}Result>;`);
  }
  for (const method of repositoryReference.additionalInterfaceMethods || []) lines.push(`  ${method}`);
  lines.push("}");
  return `${lines.join("\n").trimEnd()}\n`;
}

function renderPrismaRepository(contract, implementation) {
  const repositoryReference = implementation.backend.repositoryReference;
  const repositoryRenderers = implementation.backend.repositoryRenderers;
  const usedTypes = new Set();
  for (const route of contract.routes || []) {
    const method = route.repositoryMethod || repositoryMethodName(route.capabilityId);
    usedTypes.add(`${pascal(method)}Input`);
    usedTypes.add(`${pascal(method)}Result`);
  }
  for (const typeName of repositoryReference.additionalTypeNames || []) usedTypes.add(typeName);
  const body = repositoryRenderers.renderPrismaRepositoryBody({
    repositoryInterfaceName: repositoryReference.repositoryInterfaceName,
    prismaRepositoryClassName: repositoryReference.prismaRepositoryClassName,
    repositoryReference
  })
    .replace(/\.map\(\((project|user)\) =>/g, ".map(($1: any) =>")
    .replace(/\.catch\(\((error)\) =>/g, ".catch(($1: unknown) =>")
    .trimEnd();
  const lines = [
    'import { PrismaClient } from "@prisma/client";',
    `import type { ${repositoryReference.repositoryInterfaceName} } from "../repositories";`,
    "import type {",
    ...[...usedTypes].sort().map((typeName) => `  ${typeName},`),
    '} from "../types";',
    "",
    'import { HttpError } from "../../server/helpers";',
    "",
    body
  ];
  return `${lines.join("\n").trimEnd()}\n`;
}

function renderServerContractModule(contract) {
  return `export const serverContract = ${JSON.stringify(contract, null, 2)} as const;\n`;
}

function renderServerHelpers() {
  return `import type { Context } from "hono";

export class HttpError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
  }
}

export type AuthorizationContext = {
  capabilityId?: string;
  input?: Record<string, unknown>;
  loadResource?: () => Promise<Record<string, unknown>> | Record<string, unknown>;
};

export function coerceValue(value: unknown, schema: { type?: string; format?: string } = {}) {
  if (value == null) return value;
  if (schema.type === "integer") return Number.parseInt(String(value), 10);
  if (schema.type === "number") return Number(value);
  if (schema.type === "boolean") return value === true || value === "true";
  return String(value);
}

export function contentDisposition(disposition: string, filename: string) {
  return \`\${disposition}; filename="\${filename.replace(/"/g, "")}"\`;
}

export function jsonError(error: unknown) {
  if (error instanceof HttpError) {
    return { status: error.status, body: { ok: false, error: { code: error.code, message: error.message } } };
  }
  const message = error instanceof Error ? error.message : "Unexpected server error";
  return { status: 500, body: { ok: false, error: { code: "internal_error", message } } };
}

export function requireHeaders(c: Context, requirements: ReadonlyArray<{ header?: string; name?: string; error?: number; code?: string }>) {
  for (const requirement of requirements || []) {
    const header = requirement.header || requirement.name;
    if (header && !c.req.header(header)) {
      throw new HttpError(Number(requirement.error || 428), requirement.code || "missing_required_header", \`Missing required header \${header}\`);
    }
  }
}

export function requireRequestFields(route: any, input: Record<string, unknown>) {
  for (const field of route.requestContract?.fields || []) {
    if (field.required && (input[field.name] === undefined || input[field.name] === null || input[field.name] === "")) {
      throw new HttpError(400, \`\${route.capabilityId || "capability"}_invalid_request\`, \`Missing required field \${field.name}\`);
    }
  }
}

export async function authorizeWithGeneratedAuthProfile(
  _ctx: Context,
  _authz: ReadonlyArray<{ role?: string | null; permission?: string | null; claim?: string | null; claimValue?: string | null; ownership?: string | null; ownershipField?: string | null }>,
  _authorizationContext?: AuthorizationContext
) {
  return;
}
`;
}

function renderServerContext(contract, repositoryReference) {
  return `import type { Context } from "hono";
import type { ${repositoryReference.repositoryInterfaceName} } from "../persistence/repositories";
import type { AuthorizationContext } from "./helpers";
import { serverContract } from "../topogram/server-contract";

export interface ServerDependencies {
  ${repositoryReference.dependencyName}: ${repositoryReference.repositoryInterfaceName};
  ready?: () => Promise<void> | void;
  authorize?: (
    ctx: Context,
    authz: (typeof serverContract.routes)[number]["endpoint"]["authz"],
    authorizationContext?: AuthorizationContext
  ) => Promise<void> | void;
}
`;
}

function renderServerApp(contract, implementation, context) {
  const repositoryReference = implementation.backend.repositoryReference;
  const dependencyName = repositoryReference.dependencyName;
  const serviceName = implementation.backend.reference?.serviceName || context.projection.id;
  const typeImportNames = routeTypeNames(contract);
  const lookupRoutes = repositoryReference.lookupBindings || [];
  const preconditionCapabilityIds = repositoryReference.preconditionCapabilityIds || [];
  const preconditionResource = repositoryReference.preconditionResource || {};
  const preconditionVariableName = preconditionResource.variableName || "currentResource";
  const downloadCapabilityId = repositoryReference.downloadCapabilityId;
  const defaultWebPort = context.topology?.components?.find?.((component) => component.type === "web")?.port || 5173;
  const lines = [
    'import { Hono } from "hono";',
    'import { cors } from "hono/cors";',
    'import type { Context } from "hono";',
    'import { serverContract } from "../topogram/server-contract";',
    'import { HttpError, coerceValue, contentDisposition, jsonError, requireHeaders, requireRequestFields } from "./helpers";',
    'import type { ServerDependencies } from "./context";',
    `import type { ${typeImportNames.join(", ")} } from "../persistence/types";`,
    "",
    "function buildInput(c: Context, route: any, body: Record<string, unknown>) {",
    "  const input: Record<string, unknown> = {};",
    "  for (const field of (route.requestContract?.transport.path || []) as any[]) input[field.name] = coerceValue(c.req.param(field.transport.wireName), field.schema);",
    "  for (const field of (route.requestContract?.transport.query || []) as any[]) input[field.name] = coerceValue(c.req.query(field.transport.wireName), field.schema);",
    "  for (const field of (route.requestContract?.transport.header || []) as any[]) input[field.name] = coerceValue(c.req.header(field.transport.wireName), field.schema);",
    "  for (const field of (route.requestContract?.transport.body || []) as any[]) {",
    '    const defaultValue = field.schema && typeof field.schema === "object" && "default" in field.schema ? field.schema.default : undefined;',
    "    input[field.name] = body[field.transport.wireName] ?? defaultValue;",
    "  }",
    "  return input;",
    "}",
    "",
    "function corsOrigin(origin: string) {",
    `  const configured = process.env.TOPOGRAM_CORS_ORIGINS || "http://localhost:${defaultWebPort},http://127.0.0.1:${defaultWebPort}";`,
    '  const allowed = new Set(configured.split(",").map((entry) => entry.trim()).filter(Boolean));',
    '  return allowed.has(origin) ? origin : "";',
    "}",
    "",
    "export function createApp(deps: ServerDependencies) {",
    "  const app = new Hono();",
    '  app.use("*", cors({ origin: corsOrigin, allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"], allowHeaders: ["Content-Type", "If-Match", "If-None-Match", "Idempotency-Key", "Authorization"], exposeHeaders: ["ETag", "Location", "Retry-After", "Content-Disposition"] }));',
    `  app.get("/health", (c) => c.json({ ok: true, service: "${serviceName}" }, 200 as any));`,
    '  app.get("/ready", async (c) => { try { await deps.ready?.(); return c.json({ ok: true, ready: true, service: "' + serviceName + '" }, 200 as any); } catch (error) { const message = error instanceof Error ? error.message : "Readiness check failed"; return c.json({ ok: false, ready: false, service: "' + serviceName + '", message }, 503 as any); } });',
    ""
  ];
  for (const lookup of lookupRoutes) {
    lines.push(`  app.get("${lookup.route}", async (c) => {`);
    lines.push(`    try { const result = await deps.${dependencyName}.${lookup.repositoryMethod}(); return c.json(result, 200 as any); } catch (error) { const failure = jsonError(error); return c.json(failure.body, failure.status as any); }`);
    lines.push("  });");
  }
  (contract.routes || []).forEach((route, routeIndex) => {
    const method = String(route.method || "GET").toLowerCase();
    const routeVar = `route${routeIndex}`;
    const methodName = route.repositoryMethod || repositoryMethodName(route.capabilityId);
    const responseMode = route.responseContract?.mode || "item";
    const hasOwnershipAuthz = (route.endpoint?.authz || []).some((rule) => rule.ownership && rule.ownership !== "none");
    const authLoaderVar = `loadAuthorizationResource${routeIndex}`;
    lines.push(`  const ${routeVar} = serverContract.routes[${routeIndex}]!;`);
    lines.push(`  app.${method}(${routeVar}.path, async (c) => {`);
    lines.push("    try {");
    lines.push((route.requestContract?.transport?.body || []).length > 0 ? "      const body = await c.req.json().catch(() => ({}));" : "      const body = {};");
    lines.push(`      const input = buildInput(c, ${routeVar}, body);`);
    if ((route.endpoint?.authz || []).length > 0) {
      if (hasOwnershipAuthz) {
        if (preconditionCapabilityIds.includes(route.capabilityId)) {
          lines.push(`      const ${authLoaderVar} = async () => await deps.${dependencyName}.${preconditionResource.repositoryMethod}({ ${preconditionResource.inputField}: String(input.${preconditionResource.inputField} || "") } as unknown as ${pascal(preconditionResource.repositoryMethod)}Input) as unknown as Record<string, unknown>;`);
        } else if (route.method === "GET" && responseMode === "item") {
          lines.push(`      const ${authLoaderVar} = async () => await deps.${dependencyName}.${methodName}(input as unknown as ${pascal(methodName)}Input) as unknown as Record<string, unknown>;`);
        } else {
          lines.push(`      const ${authLoaderVar} = undefined;`);
        }
      }
      lines.push('      if (!deps.authorize) throw new HttpError(500, "authorization_handler_missing", "Missing authorization handler for protected route");');
      lines.push(`      await deps.authorize(c, ${routeVar}.endpoint.authz, { capabilityId: ${routeVar}.capabilityId, input, ${hasOwnershipAuthz ? `loadResource: typeof ${authLoaderVar} === "function" ? ${authLoaderVar} : undefined` : "loadResource: undefined"} });`);
    }
    if ((route.endpoint?.preconditions || []).length > 0 || (route.endpoint?.idempotency || []).length > 0) {
      lines.push(`      requireHeaders(c, [...${routeVar}.endpoint.preconditions, ...${routeVar}.endpoint.idempotency]);`);
    }
    lines.push(`      requireRequestFields(${routeVar}, input);`);
    if (preconditionCapabilityIds.includes(route.capabilityId)) {
      lines.push('      const ifMatch = c.req.header("If-Match");');
      lines.push("      if (ifMatch) {");
      lines.push(`        const ${preconditionVariableName} = await deps.${dependencyName}.${preconditionResource.repositoryMethod}({ ${preconditionResource.inputField}: String(input.${preconditionResource.inputField} || "") } as unknown as ${pascal(preconditionResource.repositoryMethod)}Input);`);
      lines.push(`        if (${preconditionVariableName}.${preconditionResource.versionField} !== ifMatch) throw new HttpError(412, "stale_precondition", "If-Match does not match the current resource version");`);
      lines.push("      }");
    }
    if (route.capabilityId === downloadCapabilityId) {
      lines.push(`      const artifact = await deps.${dependencyName}.${methodName}(input as unknown as ${pascal(methodName)}Input);`);
      lines.push("      const responseHeaders = new Headers();");
      lines.push(`      responseHeaders.set("Content-Type", artifact.contentType || "${route.endpoint?.download?.[0]?.media || "application/octet-stream"}");`);
      lines.push(`      responseHeaders.set("Content-Disposition", contentDisposition("${route.endpoint?.download?.[0]?.disposition || "attachment"}", artifact.filename || "${route.endpoint?.download?.[0]?.filename || "download.bin"}"));`);
      lines.push(`      return new Response(artifact.body as BodyInit | null, { status: ${route.successStatus || 200}, headers: responseHeaders });`);
    } else {
      lines.push(`      const result = await deps.${dependencyName}.${methodName}(input as unknown as ${pascal(methodName)}Input);`);
      if ((route.endpoint?.cache || []).length > 0) {
        const cacheRule = route.endpoint.cache[0];
        lines.push(`      const etag = (result as unknown as Record<string, unknown>)["${cacheRule.source}"];`);
        lines.push(`      if (etag && c.req.header("${cacheRule.requestHeader}") === String(etag)) return c.body(null, ${cacheRule.notModified} as any);`);
        lines.push(`      if (etag) c.header("${cacheRule.responseHeader}", String(etag));`);
      }
      if ((route.endpoint?.async || []).length > 0) {
        const asyncRule = route.endpoint.async[0];
        lines.push(`      c.header("${asyncRule.locationHeader}", (result as unknown as Record<string, unknown>).status_url ? String((result as unknown as Record<string, unknown>).status_url) : "${asyncRule.statusPath}".replace(":job_id", String((result as unknown as Record<string, unknown>).job_id ?? "")));`);
        lines.push(`      c.header("${asyncRule.retryAfterHeader}", "5");`);
      }
      lines.push(`      return c.json(result as ${pascal(methodName)}Result, ${route.successStatus || 200} as any);`);
    }
    lines.push("    } catch (error) { const failure = jsonError(error); return c.json(failure.body, failure.status as any); }");
    lines.push("  });");
  });
  lines.push("  return app;");
  lines.push("}");
  lines.push("");
  lines.push("export type AppType = ReturnType<typeof createApp>;");
  return `${lines.join("\n").trimEnd()}\n`;
}

function renderServerIndex(context, implementation) {
  const repositoryReference = implementation.backend.repositoryReference;
  const serviceName = implementation.backend.reference?.serviceName || context.projection.id;
  const defaultPort = Number(context.component?.port || 3000);
  return `import { serve } from "@hono/node-server";
import { PrismaClient } from "@prisma/client";
import { createApp } from "./lib/server/app";
import { ${repositoryReference.prismaRepositoryClassName} } from "./lib/persistence/prisma/repositories";
import { authorizeWithGeneratedAuthProfile } from "./lib/server/helpers";

export function createServer() {
  const prisma = new PrismaClient();
  const ${repositoryReference.dependencyName} = new ${repositoryReference.prismaRepositoryClassName}(prisma);
  return createApp({
    ${repositoryReference.dependencyName},
    ready: async () => {
      await prisma.$queryRaw\`SELECT 1\`;
    },
    authorize: async (
      ctx: Parameters<typeof authorizeWithGeneratedAuthProfile>[0],
      authz: Parameters<typeof authorizeWithGeneratedAuthProfile>[1],
      authorizationContext: Parameters<typeof authorizeWithGeneratedAuthProfile>[2]
    ) => {
      await authorizeWithGeneratedAuthProfile(ctx, authz, authorizationContext);
    }
  });
}

const app = createServer();
const port = Number(process.env.PORT || ${defaultPort});

serve({ fetch: app.fetch, port });
console.log(\`${serviceName} listening on http://localhost:\${port}\`);
`;
}

function generateProviderBacked(context) {
  const implementation = context.implementation;
  const contract = context.contracts?.server;
  if (!implementation?.backend?.repositoryReference || !implementation?.backend?.repositoryRenderers || !contract) {
    return null;
  }
  const repositoryReference = implementation.backend.repositoryReference;
  return {
    "package.json": renderPackageJson({ hasDatabase: true }),
    "tsconfig.json": renderTsconfig(),
    "scripts/seed-demo.mjs": implementation.backend.reference.renderSeedScript(),
    "src/index.ts": renderServerIndex(context, implementation),
    "src/lib/topogram/server-contract.ts": renderServerContractModule(contract),
    "src/lib/server/helpers.ts": renderServerHelpers(),
    "src/lib/server/context.ts": renderServerContext(contract, repositoryReference),
    "src/lib/server/app.ts": renderServerApp(contract, implementation, context),
    "src/lib/persistence/types.ts": renderPersistenceTypes(contract, repositoryReference),
    "src/lib/persistence/repositories.ts": renderRepositoriesInterface(contract, repositoryReference),
    "src/lib/persistence/prisma/repositories.ts": renderPrismaRepository(contract, implementation),
    "prisma/schema.prisma": renderProviderPrismaSchema(context),
    ".env.example": "DATABASE_URL=postgresql://postgres@localhost:5432/topogram\n"
  };
}

function generate(context) {
  const projection = context.projection;
  if (!projection || !Array.isArray(projection.http)) {
    throw new Error("Hono API generator requires an API projection with http routes.");
  }
  const hasDatabase = Boolean(context.component && context.component.databaseComponent);
  if (hasDatabase) {
    const providerFiles = generateProviderBacked(context);
    if (providerFiles) {
      return {
        files: providerFiles,
        artifacts: {
          generator: manifest.id,
          projection: projection.id,
          routeCount: projection.http.length,
          persistence: true,
          implementationProvider: true
        },
        diagnostics: []
      };
    }
  }
  const files = {
    "package.json": renderPackageJson({ hasDatabase }),
    "tsconfig.json": renderTsconfig(),
    "src/index.ts": renderIndexTs(projection, context.component || {}, { hasDatabase }),
    "src/lib/topogram/server-contract.json": `${JSON.stringify(context.contracts?.server || { projection }, null, 2)}\n`,
    "src/lib/topogram/api-contracts.json": `${JSON.stringify(context.contracts?.api || {}, null, 2)}\n`
  };
  if (hasDatabase) {
    files["src/lib/persistence/repository.ts"] = renderPersistenceRepository(context.component || {});
    files["src/lib/persistence/README.md"] = `This service is wired to Topogram database component \`${context.component.databaseComponent.id}\`.\n\nThe generated repository is a contract boundary for agents and implementation providers. Replace it with real persistence code when maintaining the app.\n`;
    files["prisma/schema.prisma"] = renderPrismaSchema(context.component || {});
    files[".env.example"] = "DATABASE_URL=postgresql://postgres@localhost:5432/topogram\n";
  }
  return {
    files,
    artifacts: {
      generator: manifest.id,
      projection: projection.id,
      routeCount: projection.http.length,
      persistence: hasDatabase
    },
    diagnostics: []
  };
}

module.exports = {
  manifest,
  generate
};
