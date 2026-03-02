# @synergenius/flowweaver-pack-inngest

Inngest durable functions export target for [Flow Weaver](https://github.com/synergenius-fw/flow-weaver).

Generates event-driven, durable Inngest functions from Flow Weaver workflows. Each workflow node becomes a durable `step.run()` call with automatic retries.

## Installation

```bash
npm install @synergenius/flowweaver-pack-inngest
```

This package is a **marketplace pack** — once installed, Flow Weaver automatically discovers it via `createTargetRegistry()`.

## Usage

### CLI

```bash
# Export a workflow as an Inngest function
npx flow-weaver export my-workflow.ts --target inngest

# With options
npx flow-weaver export my-workflow.ts --target inngest --production
```

### Programmatic

```typescript
import { createTargetRegistry } from '@synergenius/flow-weaver/deployment';

const registry = await createTargetRegistry(process.cwd());
const inngest = registry.get('inngest');

const artifacts = await inngest.generate({
  sourceFile: 'my-workflow.ts',
  workflowName: 'myWorkflow',
  displayName: 'my-workflow',
  outputDir: './dist/inngest',
  production: true,
});
```

## What it generates

- `inngest/<name>.ts` — Inngest function with per-node `step.run()` wrapping
- `serve.ts` — Framework adapter (Express/Next.js/Hono/Fastify)
- `package.json` — Dependencies and scripts

Each workflow becomes an Inngest function triggered by a custom event, with typed event schemas generated from `@param` annotations.

## Requirements

- `@synergenius/flow-weaver` >= 0.14.0

## License

See [LICENSE](./LICENSE).
