/**
 * Inngest extension self-registration module.
 *
 * Registers the compile target, dev mode provider, and scaffold templates
 * through the core registry infrastructure.
 */

import { compileTargetRegistry, devModeRegistry } from '@synergenius/flow-weaver/api';
import { registerWorkflowTemplates } from '@synergenius/flow-weaver/cli';
import { generateInngestFunction } from './generator.js';
import { runInngestDevMode } from './dev-mode.js';
import { aiAgentDurableTemplate } from './templates/ai-agent-durable.js';
import { aiPipelineDurableTemplate } from './templates/ai-pipeline-durable.js';

compileTargetRegistry.register({
  name: 'inngest',
  compile(workflow, nodeTypes, options) {
    return generateInngestFunction(workflow, nodeTypes, options);
  },
});

devModeRegistry.register({
  name: 'inngest',
  run: runInngestDevMode,
});

registerWorkflowTemplates([aiAgentDurableTemplate, aiPipelineDurableTemplate]);
