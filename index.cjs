const manifest = require("./topogram-generator.json");

function renderPackageJson({ hasDatabase = false } = {}) {
  return `${JSON.stringify({
    private: true,
    type: "module",
    scripts: {
      dev: "tsx src/index.ts",
      check: "tsc --noEmit",
      start: "node dist/index.js"
    },
    dependencies: {
      "@hono/node-server": "^1.13.7",
      hono: "^4.6.14",
      ...(hasDatabase ? { "@prisma/client": "^6.0.0" } : {})
    },
    devDependencies: {
      "@types/node": "^22.10.2",
      ...(hasDatabase ? { prisma: "^6.0.0" } : {}),
      tsx: "^4.19.2",
      typescript: "^5.6.3"
    }
  }, null, 2)}\n`;
}

function renderTsconfig() {
  return `${JSON.stringify({
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      strict: true,
      esModuleInterop: true,
      skipLibCheck: true,
      outDir: "dist"
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

function generate(context) {
  const projection = context.projection;
  if (!projection || !Array.isArray(projection.http)) {
    throw new Error("Hono API generator requires an API projection with http routes.");
  }
  const hasDatabase = Boolean(context.component && context.component.databaseComponent);
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
