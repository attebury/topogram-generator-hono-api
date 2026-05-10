import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workRoot = path.join(root, ".tmp", "verify");
const packRoot = path.join(workRoot, "pack");
const npmCache = path.join(workRoot, "npm-cache");
const cliPackageSpec = process.env.TOPOGRAM_CLI_PACKAGE_SPEC || defaultCliPackageSpec();
const cliDependencySpec = dependencySpecFor("@topogram/cli", cliPackageSpec);

fs.rmSync(workRoot, { recursive: true, force: true });
fs.mkdirSync(packRoot, { recursive: true });
fs.mkdirSync(npmCache, { recursive: true });

console.log("Packing generator package...");
const pack = run("npm", ["pack", "--silent", "--pack-destination", packRoot], { cwd: root });
const tarballName = pack.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
const generatorTarball = path.join(packRoot, tarballName);
assert.equal(fs.existsSync(generatorTarball), true, `Expected ${generatorTarball}`);
assertNoEnvFilesInTarball(generatorTarball, "@topogram/generator-hono-api");

const projectRoot = path.join(workRoot, "consumer");
fs.mkdirSync(projectRoot, { recursive: true });
fs.cpSync(path.join(root, "test-project-topo"), path.join(projectRoot, "topo"), { recursive: true });
fs.copyFileSync(path.join(root, "test-project-topo.project.json"), path.join(projectRoot, "topogram.project.json"));

writeJson(path.join(projectRoot, "package.json"), {
  name: "topogram-generator-hono-api-consumer",
  private: true,
  type: "module",
  devDependencies: {
    "@topogram/cli": cliDependencySpec,
    "@topogram/generator-hono-api": `file:${generatorTarball}`
  }
});

console.log("Installing consumer dependencies...");
run("npm", ["install"], { cwd: projectRoot, quiet: true });
const topogramBin = path.join(projectRoot, "node_modules", ".bin", process.platform === "win32" ? "topogram.cmd" : "topogram");
assert.equal(fs.existsSync(topogramBin), true, `Expected topogram binary at ${topogramBin}`);

console.log("Checking Topogram project...");
run(topogramBin, ["check"], { cwd: projectRoot });

console.log("Generating app with package-backed generator...");
run(topogramBin, ["generate"], { cwd: projectRoot });
console.log("Compiling generated app bundle...");
run("npm", ["--prefix", path.join(projectRoot, "app"), "run", "compile"], { cwd: projectRoot });

const apiRoot = path.join(projectRoot, "app", "apps", "services", "app_api");
assert.equal(fs.existsSync(path.join(projectRoot, "app", ".topogram-generated.json")), true);
assert.match(fs.readFileSync(path.join(apiRoot, "src", "index.ts"), "utf8"), /new Hono/);
const generatedIndexTs = fs.readFileSync(path.join(apiRoot, "src", "index.ts"), "utf8");
assert.match(generatedIndexTs, /app\.get\("\/hello"/);
assert.match(generatedIndexTs, /capability: "cap_get_hello"/);
assert.doesNotMatch(generatedIndexTs, /capability: "undefined"/);
assert.match(fs.readFileSync(path.join(apiRoot, "package.json"), "utf8"), /"hono"/);
assert.equal(fs.existsSync(path.join(apiRoot, "src", "lib", "topogram", "server-contract.json")), true);
const generatorSource = fs.readFileSync(path.join(root, "index.cjs"), "utf8");
assert.match(
  generatorSource,
  /body: \{ ok: false, error: \{ code: error\.code, message: error\.message \} \}/,
  "Expected provider-backed generated errors to use the contract error envelope"
);
assert.match(
  generatorSource,
  /Number\(requirement\.error \|\| 428\), requirement\.code \|\| "missing_required_header"/,
  "Expected provider-backed generated header precondition errors to honor route metadata"
);
assert.ok(
  generatorSource.includes('throw new HttpError(400, \\`\\${route.capabilityId || "capability"}_invalid_request\\`, \\`Missing required field \\${field.name}\\`);'),
  "Expected provider-backed missing required fields to use capability-specific invalid request codes"
);
const adapter = await import(path.join(root, "index.cjs"));
const dbBacked = adapter.default.generate({
  graph: {},
  projection: { id: "proj_api", endpoints: [{ method: "GET", path: "/hello", capabilityId: "cap_get_hello", success: 200 }] },
  runtime: { id: "app_api", kind: "api_service", port: 3000, databaseRuntime: { id: "app_postgres" } }
});
assert.equal(typeof dbBacked.files["prisma/schema.prisma"], "string", "Expected DB-backed Hono generation to include persistence scaffold");
assert.equal(typeof dbBacked.files["src/lib/persistence/repository.ts"], "string", "Expected DB-backed Hono generation to include repository boundary");
assert.match(dbBacked.files["src/index.ts"], /repository\.describe/);
assert.match(dbBacked.files["package.json"], /@prisma\/client/);
assert.equal(dbBacked.artifacts.persistence, true);

console.log("Package-backed Hono API generator smoke passed.");

function run(command, args, options = {}) {
  const result = childProcess.spawnSync(command, args, {
    cwd: options.cwd || root,
    encoding: "utf8",
    env: {
      ...process.env,
      npm_config_cache: npmCache,
      PATH: process.env.PATH || ""
    }
  });
  if (result.status !== 0) {
    throw new Error([
      `Command failed: ${command} ${args.join(" ")}`,
      result.stdout,
      result.stderr
    ].filter(Boolean).join("\n"));
  }
  if (!options.quiet && result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (!options.quiet && result.stderr) {
    process.stderr.write(result.stderr);
  }
  return result;
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function dependencySpecFor(packageName, packageSpec) {
  const prefix = `${packageName}@`;
  if (packageSpec.startsWith(prefix)) {
    return packageSpec.slice(prefix.length);
  }
  return packageSpec;
}

function assertNoEnvFilesInTarball(tarballPath, packageName) {
  const listing = run("tar", ["-tzf", tarballPath], { quiet: true });
  const envFiles = listing.stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .filter((entry) => /^(\.env.*|\.npmrc|\.DS_Store|.*\.(pem|key|p8|p12|pfx)|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|secrets\..*|credentials\..*)$/.test(path.posix.basename(entry)));
  assert.deepEqual(envFiles, [], `${packageName} package must not publish restricted local or secret files`);
}

function defaultCliPackageSpec() {
  const version = fs.readFileSync(path.join(root, "topogram-cli.version"), "utf8").trim();
  if (!version) {
    throw new Error("topogram-cli.version must contain the Topogram CLI version used by package smoke verification.");
  }
  return `@topogram/cli@${version}`;
}
