/**
 * Inngest export target
 *
 * Generates durable, event-driven functions using the Inngest platform.
 * Each workflow becomes an Inngest function triggered by a custom event,
 * served via an HTTP endpoint compatible with any framework (Express, Next.js, etc.).
 */

import {
  BaseExportTarget,
  type ExportOptions,
  type ExportArtifacts,
  type DeployInstructions,
  type CompiledWorkflow,
  type MultiWorkflowArtifacts,
  type NodeTypeInfo,
  type NodeTypeExportOptions,
  type NodeTypeArtifacts,
  type BundleWorkflow,
  type BundleNodeType,
  type BundleArtifacts,
} from '@synergenius/flow-weaver/deployment';
import { getGeneratedBranding } from '@synergenius/flow-weaver/generated-branding';
import { generateStandaloneRuntimeModule } from '@synergenius/flow-weaver/deployment';
import { generateInngestFunction } from '@synergenius/flow-weaver/extensions/inngest';
import { AnnotationParser } from '@synergenius/flow-weaver/api';

/**
 * Single-workflow Inngest handler template
 */
const INNGEST_HANDLER_TEMPLATE = `{{GENERATED_HEADER}}
import { Inngest } from 'inngest';
import { serve } from 'inngest/express';
{{WORKFLOW_IMPORT}}

const inngest = new Inngest({ id: '{{SERVICE_ID}}' });

export const {{FUNCTION_VAR}} = inngest.createFunction(
  { id: '{{FUNCTION_ID}}', name: '{{FUNCTION_DISPLAY_NAME}}' },
  { event: '{{EVENT_NAME}}' },
  async ({ event, step }) => {
    const params = event.data ?? {};

    const result = await step.run('execute-workflow', async () => {
      return {{FUNCTION_NAME}}(true, params);
    });

    return { success: true, result };
  }
);

// Serve endpoint — mount this on your HTTP framework
// Express:  app.use('/api/inngest', serve({ client: inngest, functions: [{{FUNCTION_VAR}}] }));
// Next.js:  export default serve({ client: inngest, functions: [{{FUNCTION_VAR}}] });
export const handler = serve({ client: inngest, functions: [{{FUNCTION_VAR}}] });
export default handler;
`;

/**
 * Single-workflow Inngest handler template with docs routes
 */
const INNGEST_HANDLER_WITH_DOCS_TEMPLATE = `{{GENERATED_HEADER}}
import { Inngest } from 'inngest';
import { serve } from 'inngest/express';
import express from 'express';
{{WORKFLOW_IMPORT}}
import { openApiSpec } from './openapi.js';

const inngest = new Inngest({ id: '{{SERVICE_ID}}' });

export const {{FUNCTION_VAR}} = inngest.createFunction(
  { id: '{{FUNCTION_ID}}', name: '{{FUNCTION_DISPLAY_NAME}}' },
  { event: '{{EVENT_NAME}}' },
  async ({ event, step }) => {
    const params = event.data ?? {};

    const result = await step.run('execute-workflow', async () => {
      return {{FUNCTION_NAME}}(true, params);
    });

    return { success: true, result };
  }
);

// Create Express app with Inngest serve + docs routes
const app = express();

// Inngest serve endpoint
app.use('/api/inngest', serve({ client: inngest, functions: [{{FUNCTION_VAR}}] }));

// OpenAPI spec
app.get('/api/openapi.json', (_req, res) => {
  res.json(openApiSpec);
});

// Swagger UI
app.get('/api/docs', (_req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.send(\`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>{{FUNCTION_DISPLAY_NAME}} API Documentation</title>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css">
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
  <script>
    SwaggerUIBundle({
      url: '/api/openapi.json',
      dom_id: '#swagger-ui',
      presets: [SwaggerUIBundle.presets.apis, SwaggerUIBundle.SwaggerUIStandalonePreset],
      layout: 'BaseLayout'
    });
  </script>
</body>
</html>\`);
});

export const handler = app;
export default app;
`;

/**
 * OpenAPI spec file template
 */
const OPENAPI_SPEC_TEMPLATE = `// Generated OpenAPI specification
export const openApiSpec = {{OPENAPI_SPEC}};
`;

/**
 * Multi-workflow Inngest handler template
 */
const INNGEST_MULTI_HANDLER_TEMPLATE = `{{GENERATED_HEADER}}
import { Inngest } from 'inngest';
import { serve } from 'inngest/express';
import express from 'express';
{{WORKFLOW_IMPORTS}}
import { functionRegistry } from './runtime/function-registry.js';
import './runtime/builtin-functions.js';
import { openApiSpec } from './openapi.js';

const inngest = new Inngest({ id: '{{SERVICE_ID}}' });

{{FUNCTION_DEFINITIONS}}

const functions = [{{FUNCTION_LIST}}];

// Create Express app with Inngest serve + API routes
const app = express();
app.use(express.json());

// Inngest serve endpoint
app.use('/api/inngest', serve({ client: inngest, functions }));

// OpenAPI spec
app.get('/api/openapi.json', (_req, res) => {
  res.json(openApiSpec);
});

// Swagger UI
app.get('/api/docs', (_req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.send(\`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>{{SERVICE_NAME}} API Documentation</title>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css">
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
  <script>
    SwaggerUIBundle({
      url: '/api/openapi.json',
      dom_id: '#swagger-ui',
      presets: [SwaggerUIBundle.presets.apis, SwaggerUIBundle.SwaggerUIStandalonePreset],
      layout: 'BaseLayout'
    });
  </script>
</body>
</html>\`);
});

// List available functions
app.get('/api/functions', (req, res) => {
  const category = req.query.category as string | undefined;
  res.json(functionRegistry.list(category as any));
});

// Direct invocation endpoint (bypasses Inngest event system)
app.post('/api/invoke/:workflowName', async (req, res) => {
  const { workflowName } = req.params;
  const handler = directHandlers[workflowName];
  if (!handler) {
    return res.status(404).json({ error: \`Workflow '\${workflowName}' not found\`, availableWorkflows: Object.keys(directHandlers) });
  }

  try {
    const startTime = Date.now();
    const result = await handler(true, req.body || {});
    res.json({ success: true, result, executionTime: Date.now() - startTime });
  } catch (error) {
    res.status(500).json({ success: false, error: error instanceof Error ? error.message : String(error) });
  }
});

// Direct handler map for synchronous invocation
type WorkflowHandler = (execute: boolean, params: Record<string, unknown>) => unknown;
const directHandlers: Record<string, WorkflowHandler> = {
{{WORKFLOW_ENTRIES}}
};

export const handler = app;
export default app;
`;

/**
 * Node type handler template for Inngest
 */
const INNGEST_NODE_TYPE_HANDLER_TEMPLATE = `{{GENERATED_HEADER}}
import { Inngest } from 'inngest';
import { serve } from 'inngest/express';
import express from 'express';
{{NODE_TYPE_IMPORTS}}
import { openApiSpec } from './openapi.js';

const inngest = new Inngest({ id: '{{SERVICE_ID}}' });

{{FUNCTION_DEFINITIONS}}

const functions = [{{FUNCTION_LIST}}];

// Node type handler map for direct invocation
type NodeTypeHandler = (execute: boolean, params: Record<string, unknown>) => unknown;
const nodeTypes: Record<string, NodeTypeHandler> = {
{{NODE_TYPE_ENTRIES}}
};

// Create Express app with Inngest serve + API routes
const app = express();
app.use(express.json());

// Inngest serve endpoint
app.use('/api/inngest', serve({ client: inngest, functions }));

// OpenAPI spec
app.get('/api/openapi.json', (_req, res) => {
  res.json(openApiSpec);
});

// Swagger UI
app.get('/api/docs', (_req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.send(\`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>{{SERVICE_NAME}} API Documentation</title>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css">
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
  <script>
    SwaggerUIBundle({
      url: '/api/openapi.json',
      dom_id: '#swagger-ui',
      presets: [SwaggerUIBundle.presets.apis, SwaggerUIBundle.SwaggerUIStandalonePreset],
      layout: 'BaseLayout'
    });
  </script>
</body>
</html>\`);
});

// Direct invocation endpoint
app.post('/api/nodes/:nodeTypeName', async (req, res) => {
  const { nodeTypeName } = req.params;
  const nodeType = nodeTypes[nodeTypeName];
  if (!nodeType) {
    return res.status(404).json({ error: \`Node type '\${nodeTypeName}' not found\`, availableNodeTypes: Object.keys(nodeTypes) });
  }

  try {
    const startTime = Date.now();
    const result = await nodeType(true, req.body || {});
    res.json({ success: true, result, executionTime: Date.now() - startTime });
  } catch (error) {
    res.status(500).json({ success: false, error: error instanceof Error ? error.message : String(error) });
  }
});

export const handler = app;
export default app;
`;

/**
 * Bundle handler template for Inngest — unified workflows and node types
 */
const INNGEST_BUNDLE_HANDLER_TEMPLATE = `{{GENERATED_HEADER}}
import { Inngest } from 'inngest';
import { serve } from 'inngest/express';
import express from 'express';
{{WORKFLOW_IMPORTS}}
{{NODE_TYPE_IMPORTS}}
import { functionRegistry } from './runtime/function-registry.js';
import './runtime/builtin-functions.js';
import { openApiSpec } from './openapi.js';

const inngest = new Inngest({ id: '{{SERVICE_ID}}' });

// --- Inngest function definitions ---
{{FUNCTION_DEFINITIONS}}

const functions = [{{FUNCTION_LIST}}];

// --- Direct handler maps for synchronous invocation ---
type FunctionHandler = (execute: boolean, params: Record<string, unknown>) => unknown;

const exposedWorkflows: Record<string, FunctionHandler> = {
{{EXPOSED_WORKFLOW_ENTRIES}}
};

const exposedNodeTypes: Record<string, FunctionHandler> = {
{{EXPOSED_NODE_TYPE_ENTRIES}}
};

// Create Express app with Inngest serve + API routes
const app = express();
app.use(express.json());

// Inngest serve endpoint
app.use('/api/inngest', serve({ client: inngest, functions }));

// OpenAPI spec
app.get('/api/openapi.json', (_req, res) => {
  res.json(openApiSpec);
});

// Swagger UI
app.get('/api/docs', (_req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.send(\`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>{{SERVICE_NAME}} API Documentation</title>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css">
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
  <script>
    SwaggerUIBundle({
      url: '/api/openapi.json',
      dom_id: '#swagger-ui',
      presets: [SwaggerUIBundle.presets.apis, SwaggerUIBundle.SwaggerUIStandalonePreset],
      layout: 'BaseLayout'
    });
  </script>
</body>
</html>\`);
});

// List available functions
app.get('/api/functions', (req, res) => {
  const category = req.query.category as string | undefined;
  res.json(functionRegistry.list(category as any));
});

// Direct invocation: workflows
app.post('/api/workflows/:name', async (req, res) => {
  const workflow = exposedWorkflows[req.params.name];
  if (!workflow) {
    return res.status(404).json({ error: \`Workflow '\${req.params.name}' not found\`, availableWorkflows: Object.keys(exposedWorkflows) });
  }
  try {
    const startTime = Date.now();
    const result = await workflow(true, req.body || {});
    res.json({ success: true, result, executionTime: Date.now() - startTime });
  } catch (error) {
    res.status(500).json({ success: false, error: error instanceof Error ? error.message : String(error) });
  }
});

// Direct invocation: node types
app.post('/api/nodes/:name', async (req, res) => {
  const nodeType = exposedNodeTypes[req.params.name];
  if (!nodeType) {
    return res.status(404).json({ error: \`Node type '\${req.params.name}' not found\`, availableNodeTypes: Object.keys(exposedNodeTypes) });
  }
  try {
    const startTime = Date.now();
    const result = await nodeType(true, req.body || {});
    res.json({ success: true, result, executionTime: Date.now() - startTime });
  } catch (error) {
    res.status(500).json({ success: false, error: error instanceof Error ? error.message : String(error) });
  }
});

export const handler = app;
export default app;
`;

/**
 * Inngest export target — durable, event-driven functions
 */
export class InngestTarget extends BaseExportTarget {
  readonly name = 'inngest';
  readonly description = 'Inngest — durable, event-driven workflow functions';

  readonly deploySchema = {
    durableSteps: { type: 'boolean' as const, description: 'Per-node step.run() for durability', default: false },
    framework: { type: 'string' as const, description: 'Framework adapter: next, express, hono, fastify, remix' },
    serve: { type: 'boolean' as const, description: 'Generate serve() handler export', default: false },
    retries: { type: 'number' as const, description: 'Retries per function', default: 3 },
    triggerEvent: { type: 'string' as const, description: 'Custom trigger event name' },
  };

  /**
   * Sanitize a name into a valid Inngest ID (lowercase, alphanumeric + hyphens)
   */
  private toInngestId(name: string): string {
    return name
      .replace(/([a-z])([A-Z])/g, '$1-$2')
      .replace(/[^a-zA-Z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .toLowerCase();
  }

  /**
   * Convert a name to a valid JS variable name
   */
  private toVarName(name: string): string {
    return name.replace(/[^a-zA-Z0-9_$]/g, '_').replace(/^(\d)/, '_$1');
  }

  async generate(options: ExportOptions): Promise<ExportArtifacts> {
    const files = [];
    const includeDocs = options.includeDocs ?? false;
    // @deploy inngest annotations take precedence over CLI flags
    const deployConfig = (options.targetOptions?.deploy as Record<string, Record<string, unknown>> | undefined)?.inngest;
    const durableSteps = deployConfig?.durableSteps === true || options.targetOptions?.durableSteps === true;
    const serviceId = this.toInngestId(options.displayName);
    const functionId = this.toInngestId(options.workflowName);
    const functionVar = `fn_${this.toVarName(options.workflowName)}`;

    let handlerContent: string;

    if (durableSteps && options.sourceFile) {
      // Use deep generator: parse source file and generate per-node step.run() code
      const parser = new AnnotationParser();
      const parseResult = parser.parse(options.sourceFile);
      const workflow = parseResult.workflows.find(
        (w) => w.name === options.workflowName || w.functionName === options.workflowName
      ) ?? parseResult.workflows[0];

      if (workflow) {
        const allNodeTypes = [...(workflow.nodeTypes || [])];
        handlerContent = generateInngestFunction(workflow, allNodeTypes, {
          serviceName: serviceId,
          production: options.production ?? true,
        });
      } else {
        // Fallback to shallow template if workflow not found
        handlerContent = this.generateShallowHandler(options, includeDocs, serviceId, functionId, functionVar);
      }
    } else {
      handlerContent = this.generateShallowHandler(options, includeDocs, serviceId, functionId, functionVar);
    }

    files.push(this.createFile(options.outputDir, 'handler.ts', handlerContent, 'handler'));

    // Generate OpenAPI spec file if docs enabled
    if (includeDocs) {
      const openApiSpec = this.generateOpenAPISpec(options);
      const openApiContent = OPENAPI_SPEC_TEMPLATE.replace(
        '{{OPENAPI_SPEC}}',
        JSON.stringify(openApiSpec, null, 2)
      );
      files.push(this.createFile(options.outputDir, 'openapi.ts', openApiContent, 'config'));
    }

    // Generate package.json
    const packageJson = this.generatePackageJson({
      name: options.displayName,
      description: options.description,
      main: 'handler.js',
      scripts: {
        build: 'tsc',
        dev: 'npx inngest-cli@latest dev & npx tsx handler.ts',
        serve: 'npx tsx handler.ts',
      },
      dependencies: {
        inngest: '^3.0.0',
        ...(includeDocs ? { express: '^4.18.0' } : {}),
      },
      devDependencies: {
        ...(includeDocs ? { '@types/express': '^4.17.0' } : {}),
      },
    });

    files.push(this.createFile(options.outputDir, 'package.json', packageJson, 'package'));

    // Generate tsconfig.json
    const tsConfig = this.generateTsConfig({
      outDir: './dist',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
    });

    files.push(this.createFile(options.outputDir, 'tsconfig.json', tsConfig, 'config'));

    // Generate README from deploy instructions
    const artifacts: ExportArtifacts = {
      files,
      target: this.name,
      workflowName: options.displayName,
      entryPoint: 'handler.ts',
    };
    const instructions = this.getDeployInstructions(artifacts);
    const readme = this.generateReadme(instructions, options.displayName, 'Inngest');
    files.push(this.createFile(options.outputDir, 'README.md', readme, 'other'));

    return artifacts;
  }

  /**
   * Generate the shallow (template-based) handler content.
   * Wraps the entire workflow in a single step.run() call.
   */
  private generateShallowHandler(
    options: ExportOptions,
    includeDocs: boolean,
    serviceId: string,
    functionId: string,
    functionVar: string
  ): string {
    const handlerTemplate = includeDocs
      ? INNGEST_HANDLER_WITH_DOCS_TEMPLATE
      : INNGEST_HANDLER_TEMPLATE;

    return handlerTemplate
      .replace('{{GENERATED_HEADER}}', getGeneratedBranding().header('export --target inngest'))
      .replace('{{WORKFLOW_IMPORT}}', `import { ${options.workflowName} } from './workflow.js';`)
      .replace(/\{\{SERVICE_ID\}\}/g, serviceId)
      .replace(/\{\{FUNCTION_ID\}\}/g, functionId)
      .replace(/\{\{FUNCTION_VAR\}\}/g, functionVar)
      .replace(/\{\{FUNCTION_DISPLAY_NAME\}\}/g, options.displayName)
      .replace(/\{\{FUNCTION_NAME\}\}/g, options.workflowName)
      .replace(/\{\{EVENT_NAME\}\}/g, `fw/${functionId}.execute`);
  }

  /**
   * Generate OpenAPI specification for a single workflow
   */
  private generateOpenAPISpec(options: ExportOptions): object {
    return {
      openapi: '3.0.3',
      info: {
        title: `${options.displayName} API`,
        version: '1.0.0',
        description: options.description || `Inngest-powered API for the ${options.displayName} workflow`,
      },
      servers: [{ url: '/', description: 'Current deployment' }],
      paths: {
        '/api/inngest': {
          post: {
            operationId: 'inngest_webhook',
            summary: 'Inngest webhook endpoint',
            description: 'Receives events from Inngest. Send events via the Inngest SDK or dashboard.',
            tags: ['inngest'],
            requestBody: {
              description: 'Inngest event payload',
              required: true,
              content: { 'application/json': { schema: { type: 'object' } } },
            },
            responses: {
              '200': { description: 'Event acknowledged' },
            },
          },
        },
      },
      tags: [
        { name: 'inngest', description: 'Inngest event endpoints' },
      ],
      'x-inngest-events': {
        [`fw/${this.toInngestId(options.workflowName)}.execute`]: {
          description: `Trigger ${options.displayName} workflow execution`,
          schema: {
            type: 'object',
            properties: {
              name: { type: 'string', const: `fw/${this.toInngestId(options.workflowName)}.execute` },
              data: { type: 'object', description: 'Workflow input parameters' },
            },
          },
        },
      },
    };
  }

  async generateMultiWorkflow(
    workflows: CompiledWorkflow[],
    options: ExportOptions
  ): Promise<MultiWorkflowArtifacts> {
    const files = [];
    const serviceName = options.displayName || 'multi-workflow-service';
    const serviceId = this.toInngestId(serviceName);

    // Generate workflow imports
    const workflowImports = workflows
      .map((w) => `import { ${w.functionName} } from './workflows/${w.name}.js';`)
      .join('\n');

    // Generate Inngest function definitions
    const functionDefs = workflows.map((w) => {
      const fnId = this.toInngestId(w.name);
      const fnVar = `fn_${this.toVarName(w.functionName)}`;
      return `export const ${fnVar} = inngest.createFunction(
  { id: '${fnId}', name: '${w.name}' },
  { event: 'fw/${fnId}.execute' },
  async ({ event, step }) => {
    const params = event.data ?? {};
    const result = await step.run('execute-workflow', async () => {
      return ${w.functionName}(true, params);
    });
    return { success: true, result };
  }
);`;
    }).join('\n\n');

    const functionList = workflows
      .map((w) => `fn_${this.toVarName(w.functionName)}`)
      .join(', ');

    const workflowEntries = workflows
      .map((w) => `  '${w.name}': ${w.functionName},`)
      .join('\n');

    // Generate handler
    const handlerContent = INNGEST_MULTI_HANDLER_TEMPLATE
      .replace('{{GENERATED_HEADER}}', getGeneratedBranding().header('export --target inngest --multi'))
      .replace('{{WORKFLOW_IMPORTS}}', workflowImports)
      .replace('{{FUNCTION_DEFINITIONS}}', functionDefs)
      .replace('{{FUNCTION_LIST}}', functionList)
      .replace('{{WORKFLOW_ENTRIES}}', workflowEntries)
      .replace(/\{\{SERVICE_ID\}\}/g, serviceId)
      .replace(/\{\{SERVICE_NAME\}\}/g, serviceName);

    files.push(this.createFile(options.outputDir, 'handler.ts', handlerContent, 'handler'));

    // Generate consolidated OpenAPI spec
    const openApiSpec = this.generateConsolidatedOpenAPI(workflows, {
      title: `${serviceName} API`,
      version: '1.0.0',
    });

    const openApiContent = `// Generated OpenAPI specification\nexport const openApiSpec = ${JSON.stringify(openApiSpec, null, 2)};\n`;
    files.push(this.createFile(options.outputDir, 'openapi.ts', openApiContent, 'config'));

    // Generate package.json
    const packageJson = this.generatePackageJson({
      name: serviceName,
      description: `Inngest multi-workflow service with ${workflows.length} workflows`,
      main: 'handler.js',
      scripts: {
        build: 'tsc',
        dev: 'npx inngest-cli@latest dev & npx tsx handler.ts',
        serve: 'npx tsx handler.ts',
      },
      dependencies: {
        inngest: '^3.0.0',
        express: '^4.18.0',
      },
      devDependencies: {
        '@types/express': '^4.17.0',
      },
    });

    files.push(this.createFile(options.outputDir, 'package.json', packageJson, 'package'));

    // Generate tsconfig.json
    const tsConfig = this.generateTsConfig({
      outDir: './dist',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
    });

    files.push(this.createFile(options.outputDir, 'tsconfig.json', tsConfig, 'config'));

    // Generate workflow content files
    files.push(...this.generateWorkflowContentFiles(workflows, options.outputDir));

    return {
      files,
      target: this.name,
      workflowName: serviceName,
      workflowNames: workflows.map((w) => w.name),
      entryPoint: 'handler.ts',
      openApiSpec,
    };
  }

  async generateNodeTypeService(
    nodeTypes: NodeTypeInfo[],
    options: NodeTypeExportOptions
  ): Promise<NodeTypeArtifacts> {
    const files = [];
    const serviceName = options.serviceName || 'node-type-service';
    const serviceId = this.toInngestId(serviceName);

    // Generate node type imports
    const nodeTypeImports = nodeTypes
      .map((nt) => `import { ${nt.functionName} } from './node-types/${nt.functionName.toLowerCase()}.js';`)
      .join('\n');

    // Generate Inngest function definitions
    const functionDefs = nodeTypes.map((nt) => {
      const fnId = this.toInngestId(nt.name);
      const fnVar = `fn_${this.toVarName(nt.functionName)}`;
      return `export const ${fnVar} = inngest.createFunction(
  { id: '${fnId}', name: '${nt.name}' },
  { event: 'fw/${fnId}.execute' },
  async ({ event, step }) => {
    const params = event.data ?? {};
    const result = await step.run('execute-node-type', async () => {
      return ${nt.functionName}(true, params);
    });
    return { success: true, result };
  }
);`;
    }).join('\n\n');

    const functionList = nodeTypes
      .map((nt) => `fn_${this.toVarName(nt.functionName)}`)
      .join(', ');

    const nodeTypeEntries = nodeTypes
      .map((nt) => `  '${nt.name}': ${nt.functionName},`)
      .join('\n');

    // Generate handler
    const handlerContent = INNGEST_NODE_TYPE_HANDLER_TEMPLATE
      .replace('{{GENERATED_HEADER}}', getGeneratedBranding().header('export --target inngest --node-types'))
      .replace('{{NODE_TYPE_IMPORTS}}', nodeTypeImports)
      .replace('{{FUNCTION_DEFINITIONS}}', functionDefs)
      .replace('{{FUNCTION_LIST}}', functionList)
      .replace('{{NODE_TYPE_ENTRIES}}', nodeTypeEntries)
      .replace(/\{\{SERVICE_ID\}\}/g, serviceId)
      .replace(/\{\{SERVICE_NAME\}\}/g, serviceName);

    files.push(this.createFile(options.outputDir, 'handler.ts', handlerContent, 'handler'));

    // Generate OpenAPI spec
    const openApiSpec = this.generateNodeTypeOpenAPI(nodeTypes, {
      title: `${serviceName} API`,
      version: '1.0.0',
    });

    const openApiContent = `// Generated OpenAPI specification\nexport const openApiSpec = ${JSON.stringify(openApiSpec, null, 2)};\n`;
    files.push(this.createFile(options.outputDir, 'openapi.ts', openApiContent, 'config'));

    // Generate package.json
    const packageJson = this.generatePackageJson({
      name: serviceName,
      description: `Inngest node type service with ${nodeTypes.length} endpoints`,
      main: 'handler.js',
      scripts: {
        build: 'tsc',
        dev: 'npx inngest-cli@latest dev & npx tsx handler.ts',
        serve: 'npx tsx handler.ts',
      },
      dependencies: {
        inngest: '^3.0.0',
        express: '^4.18.0',
      },
      devDependencies: {
        '@types/express': '^4.17.0',
      },
    });

    files.push(this.createFile(options.outputDir, 'package.json', packageJson, 'package'));

    // Generate tsconfig.json
    const tsConfig = this.generateTsConfig({
      outDir: './dist',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
    });

    files.push(this.createFile(options.outputDir, 'tsconfig.json', tsConfig, 'config'));

    // Generate node-type content files
    files.push(...this.generateNodeTypeContentFiles(nodeTypes, options.outputDir));

    return {
      files,
      target: this.name,
      workflowName: serviceName,
      nodeTypeNames: nodeTypes.map((nt) => nt.name),
      entryPoint: 'handler.ts',
      openApiSpec,
    };
  }

  async generateBundle(
    workflows: BundleWorkflow[],
    nodeTypes: BundleNodeType[],
    options: ExportOptions
  ): Promise<BundleArtifacts> {
    const files = [];
    const serviceName = options.displayName || 'bundle-service';
    const serviceId = this.toInngestId(serviceName);

    // Filter to items with code, skip npm imports
    const workflowsWithCode = workflows.filter((w) => w.code);
    const nodeTypesWithCode = nodeTypes.filter((nt) => nt.code && !nt.name.includes('/'));

    // Separate exposed and bundled-only items
    const exposedWorkflows = workflows.filter((w) => w.expose);
    const exposedNodeTypes = nodeTypes.filter((nt) => nt.expose);

    // Detect name collisions
    const workflowNames = new Set(workflowsWithCode.map((w) => w.functionName));
    const nodeTypeAliases = new Map<string, string>();
    for (const nt of nodeTypesWithCode) {
      if (workflowNames.has(nt.functionName)) {
        nodeTypeAliases.set(nt.functionName, `${nt.functionName}_nodeType`);
      }
    }

    // Generate workflow imports
    const workflowImports = workflowsWithCode.length > 0
      ? workflowsWithCode
          .map((w) => `import { ${w.functionName} } from './workflows/${w.name}.js';`)
          .join('\n')
      : '// No workflows';

    // Generate node type imports with aliases
    const nodeTypeImports = nodeTypesWithCode.length > 0
      ? nodeTypesWithCode
          .map((nt) => {
            const alias = nodeTypeAliases.get(nt.functionName);
            const lowerFunctionName = nt.functionName.toLowerCase();
            if (alias) {
              return `import { ${nt.functionName} as ${alias} } from './node-types/${lowerFunctionName}.js';`;
            }
            return `import { ${nt.functionName} } from './node-types/${lowerFunctionName}.js';`;
          })
          .join('\n')
      : '// No node types';

    // Filter exposed items with code
    const exposedWorkflowsWithCode = exposedWorkflows.filter((w) => w.code);
    const exposedNodeTypesWithCode = exposedNodeTypes.filter((nt) => nt.code);

    // Generate Inngest function definitions for exposed items
    const allExposed = [
      ...exposedWorkflowsWithCode.map((w) => ({
        type: 'workflow' as const,
        name: w.name,
        functionName: w.functionName,
      })),
      ...exposedNodeTypesWithCode.map((nt) => ({
        type: 'nodeType' as const,
        name: nt.name,
        functionName: nodeTypeAliases.get(nt.functionName) || nt.functionName,
      })),
    ];

    const functionDefs = allExposed.map((item) => {
      const fnId = this.toInngestId(item.name);
      const fnVar = `fn_${this.toVarName(item.functionName)}`;
      const stepName = item.type === 'workflow' ? 'execute-workflow' : 'execute-node-type';
      return `export const ${fnVar} = inngest.createFunction(
  { id: '${fnId}', name: '${item.name}' },
  { event: 'fw/${fnId}.execute' },
  async ({ event, step }) => {
    const params = event.data ?? {};
    const result = await step.run('${stepName}', async () => {
      return ${item.functionName}(true, params);
    });
    return { success: true, result };
  }
);`;
    }).join('\n\n');

    const functionList = allExposed
      .map((item) => `fn_${this.toVarName(item.functionName)}`)
      .join(', ');

    // Generate entries for exposed items
    const exposedWorkflowEntries = exposedWorkflowsWithCode.length > 0
      ? exposedWorkflowsWithCode.map((w) => `  '${w.name}': ${w.functionName},`).join('\n')
      : '  // No exposed workflows';

    const exposedNodeTypeEntries = exposedNodeTypesWithCode.length > 0
      ? exposedNodeTypesWithCode
          .map((nt) => {
            const alias = nodeTypeAliases.get(nt.functionName);
            return `  '${nt.name}': ${alias || nt.functionName},`;
          })
          .join('\n')
      : '  // No exposed node types';

    // Generate handler
    const handlerContent = INNGEST_BUNDLE_HANDLER_TEMPLATE
      .replace('{{GENERATED_HEADER}}', getGeneratedBranding().header('export --target inngest --bundle'))
      .replace('{{WORKFLOW_IMPORTS}}', workflowImports)
      .replace('{{NODE_TYPE_IMPORTS}}', nodeTypeImports)
      .replace('{{FUNCTION_DEFINITIONS}}', functionDefs)
      .replace('{{FUNCTION_LIST}}', functionList)
      .replace('{{EXPOSED_WORKFLOW_ENTRIES}}', exposedWorkflowEntries)
      .replace('{{EXPOSED_NODE_TYPE_ENTRIES}}', exposedNodeTypeEntries)
      .replace(/\{\{SERVICE_ID\}\}/g, serviceId)
      .replace(/\{\{SERVICE_NAME\}\}/g, serviceName);

    files.push(this.createFile(options.outputDir, 'handler.ts', handlerContent, 'handler'));

    // Generate OpenAPI spec for exposed items
    const openApiSpec = this.generateBundleOpenAPI(workflows, nodeTypes, {
      title: `${serviceName} API`,
      version: '1.0.0',
    });

    const openApiContent = `// Generated OpenAPI specification\nexport const openApiSpec = ${JSON.stringify(openApiSpec, null, 2)};\n`;
    files.push(this.createFile(options.outputDir, 'openapi.ts', openApiContent, 'config'));

    // Collect npm package dependencies
    const npmDependencies: Record<string, string> = {};
    for (const nt of nodeTypes) {
      if (nt.name.startsWith('npm/')) {
        const rest = nt.name.slice(4);
        let packageName: string;
        if (rest.startsWith('@')) {
          const segments = rest.split('/');
          packageName = `${segments[0]}/${segments[1]}`;
        } else {
          packageName = rest.split('/')[0];
        }
        npmDependencies[packageName] = '*';
      }
    }

    // Generate package.json
    const packageJson = this.generatePackageJson({
      name: serviceName,
      description: `Inngest bundle service with ${workflows.length} workflows and ${nodeTypes.length} node types`,
      main: 'handler.js',
      scripts: {
        build: 'tsc',
        dev: 'npx inngest-cli@latest dev & npx tsx handler.ts',
        serve: 'npx tsx handler.ts',
      },
      dependencies: {
        inngest: '^3.0.0',
        express: '^4.18.0',
        ...npmDependencies,
      },
      devDependencies: {
        '@types/express': '^4.17.0',
      },
    });

    files.push(this.createFile(options.outputDir, 'package.json', packageJson, 'package'));

    // Generate tsconfig.json
    const tsConfig = this.generateTsConfig({
      outDir: './dist',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
    });

    files.push(this.createFile(options.outputDir, 'tsconfig.json', tsConfig, 'config'));

    // Generate shared runtime types module
    const isProduction = options.production ?? true;
    const runtimeTypesContent = generateStandaloneRuntimeModule(isProduction, 'esm');
    files.push(
      this.createFile(options.outputDir, 'runtime/types.ts', runtimeTypesContent, 'other')
    );

    // Generate runtime files
    files.push(...this.generateRuntimeFiles(options.outputDir, workflows, nodeTypes));

    // Generate workflow and node-type content files
    files.push(...this.generateBundleContentFiles(workflows, nodeTypes, options.outputDir));

    return {
      files,
      target: this.name,
      workflowName: serviceName,
      workflowNames: workflows.map((w) => w.name),
      nodeTypeNames: nodeTypes.map((nt) => nt.name),
      entryPoint: 'handler.ts',
      openApiSpec,
    };
  }

  getDeployInstructions(artifacts: ExportArtifacts): DeployInstructions {
    const outputDir = artifacts.files[0]?.absolutePath
      ? artifacts.files[0].absolutePath.replace(/\/[^/]+$/, '')
      : '.';

    return {
      title: 'Deploy with Inngest',
      prerequisites: [
        'Node.js 18+ installed',
        'Inngest account (https://www.inngest.com/) — free tier available',
        'Inngest CLI for local development: npx inngest-cli@latest',
      ],
      steps: [
        `cd ${outputDir}`,
        'npm install',
        'npm run build',
        '# Deploy your HTTP server (e.g., Vercel, Railway, Fly.io)',
        '# Then register the Inngest serve URL in your Inngest dashboard',
      ],
      localTestSteps: [
        `cd ${outputDir}`,
        'npm install',
        'npm run dev',
        '# Inngest Dev Server: http://localhost:8288',
        '# Your functions will auto-register with the dev server',
        '# Send test events from the Inngest Dev Server UI',
      ],
      links: [
        {
          label: 'Inngest Documentation',
          url: 'https://www.inngest.com/docs',
        },
        {
          label: 'Inngest TypeScript SDK',
          url: 'https://www.inngest.com/docs/reference/typescript',
        },
        {
          label: 'Inngest Pricing',
          url: 'https://www.inngest.com/pricing',
        },
      ],
    };
  }
}

export default InngestTarget;
