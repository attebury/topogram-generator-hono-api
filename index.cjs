const manifest = require("./topogram-generator.json");

function renderPackageJson() {
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
      hono: "^4.6.14"
    },
    devDependencies: {
      "@types/node": "^22.10.2",
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

function renderIndexTs(projection, component) {
  const routes = (projection.http || []).map((route) => {
    const method = String(route.method || "GET").toLowerCase();
    return `app.${method}("${routePath(route.path)}", (c) => c.json({ ok: true, capability: "${route.capabilityId}", input: { params: c.req.param(), query: c.req.query() } }, ${routeSuccess(route)} as any));`;
  }).join("\n");
  const port = Number(component?.port || 3000);
  return `import { serve } from "@hono/node-server";
import { Hono } from "hono";

const app = new Hono();

app.get("/health", (c) => c.json({ ok: true, service: "${projection.id}" }));
app.get("/ready", (c) => c.json({ ok: true, ready: true, service: "${projection.id}" }));
${routes}

const port = Number(process.env.PORT || ${port});
serve({ fetch: app.fetch, port });
console.log(\`${projection.id} listening on http://localhost:\${port}\`);
`;
}

function generate(context) {
  const projection = context.projection;
  if (!projection || !Array.isArray(projection.http)) {
    throw new Error("Hono API generator requires an API projection with http routes.");
  }
  const files = {
    "package.json": renderPackageJson(),
    "tsconfig.json": renderTsconfig(),
    "src/index.ts": renderIndexTs(projection, context.component || {})
  };
  return {
    files,
    artifacts: {
      generator: manifest.id,
      projection: projection.id,
      routeCount: projection.http.length
    },
    diagnostics: []
  };
}

module.exports = {
  manifest,
  generate
};
