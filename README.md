# Topogram Generator: Hono API

Package-backed Topogram generator for stateless Hono API services.

This package proves the API generator-pack boundary: Topogram core resolves the
API topology component and normalized contracts, then this package turns the API
projection into a Hono service.

## Manifest

- Generator id: `@attebury/topogram-generator-hono-api`
- Surface: `api`
- Projection platform: `api`
- Stack: Hono + TypeScript
- Package manifest: `topogram-generator.json`
- Adapter export: `index.cjs`

Topology binding:

```json
{
  "id": "app_api",
  "type": "api",
  "projection": "proj_api",
  "generator": {
    "id": "@attebury/topogram-generator-hono-api",
    "version": "1",
    "package": "@attebury/topogram-generator-hono-api"
  },
  "port": 3000
}
```

## Verify Locally

From this repo:

```bash
npm run check
```

See [`CONSUMER_PROOF.md`](./CONSUMER_PROOF.md) for the verification standard
this repo must keep before publishing.

The smoke test packs this generator, installs it beside `@attebury/topogram` in
a temporary consumer project, runs `topogram check`, runs `topogram generate`,
compiles the generated app bundle, and verifies the generated Hono API service
files.

Use a different Topogram CLI package with:

```bash
TOPOGRAM_CLI_PACKAGE_SPEC=@attebury/topogram@latest npm run check
```
