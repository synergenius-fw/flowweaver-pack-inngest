/**
 * Inngest Deep Code Generator
 *
 * Generates Inngest function code with per-node `step.run()` wrapping,
 * giving each node individual durability, retries, and checkpointing.
 *
 * This is a standalone generator alongside unified.ts — it shares the
 * control-flow analysis layer but produces fundamentally different output:
 * - Local `const` variables instead of `ctx.setVariable()/getVariable()`
 * - `step.run()` per non-expression node for durability
 * - `Promise.all()` for parallel independent nodes
 * - Indexed `step.run()` for forEach/scoped iteration
 * - Branching chain flattening for multi-way routing
 *
 * @module generator/inngest
 */

import type { TNodeTypeAST, TWorkflowAST, TNodeInstanceAST } from '@synergenius/flow-weaver/ast';
import {
  toValidIdentifier,
  buildControlFlowGraph,
  detectBranchingChains,
  findAllBranchingNodes,
  findNodesInBranch,
  performKahnsTopologicalSort,
  isPerPortScopedChild,
} from '@synergenius/flow-weaver/generator';
import {
  RESERVED_NODE_NAMES,
  RESERVED_PORT_NAMES,
  isStartNode,
  isExitNode,
  isExecutePort,
  isSuccessPort,
  isFailurePort,
} from '@synergenius/flow-weaver/constants';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface InngestGenerationOptions {
  /** Omit debug instrumentation for smaller output */
  production?: boolean;
  /** Inngest client ID (default: derived from workflow name) */
  serviceName?: string;
  /** Custom trigger event name (default: 'fw/<kebab-workflow>.execute') */
  triggerEvent?: string;
  /** Number of retries per function (default: 3) */
  retries?: number;
  /** Extra function config merged into createFunction() first arg */
  functionConfig?: Record<string, unknown>;
  /** When true, emit Zod schema from @param annotations */
  typedEvents?: boolean;
  /** Framework adapter for serve handler */
  framework?: 'next' | 'express' | 'hono' | 'fastify' | 'remix';
  /** When true, append serve() handler export */
  serveHandler?: boolean;
}

// ---------------------------------------------------------------------------
// Built-in Node Detection
// ---------------------------------------------------------------------------

const BUILTIN_IMPORT_PREFIX = '@synergenius/flow-weaver/built-in-nodes';

const BUILT_IN_HANDLERS: Record<string, string> = {
  delay: 'delay',
  waitForEvent: 'waitForEvent',
  waitForAgent: 'waitForAgent',
  invokeWorkflow: 'invokeWorkflow',
};

/**
 * Check if a node type is a built-in node.
 * Returns the built-in name (e.g. 'delay') or false.
 */
function isBuiltInNode(nodeType: TNodeTypeAST): string | false {
  // Primary: check import source
  if (nodeType.importSource?.startsWith(BUILTIN_IMPORT_PREFIX)) {
    return nodeType.functionName in BUILT_IN_HANDLERS ? nodeType.functionName : false;
  }
  // Fallback for test fixtures / same-file definitions:
  // Check if function name matches AND the node has the exact built-in signature
  if (nodeType.functionName in BUILT_IN_HANDLERS) {
    return verifyBuiltInSignature(nodeType) ? nodeType.functionName : false;
  }
  return false;
}

/**
 * Verify a node type has the exact built-in signature by checking its input port names.
 */
function verifyBuiltInSignature(nodeType: TNodeTypeAST): boolean {
  const inputNames = Object.keys(nodeType.inputs).filter((n) => n !== 'execute');
  switch (nodeType.functionName) {
    case 'delay':
      return inputNames.length === 1 && inputNames[0] === 'duration';
    case 'waitForEvent':
      return inputNames.includes('eventName');
    case 'invokeWorkflow':
      return inputNames.includes('functionId') && inputNames.includes('payload');
    case 'waitForAgent':
      return inputNames.includes('agentId') && inputNames.includes('context');
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Typed Event Schema (Feature 1)
// ---------------------------------------------------------------------------

/**
 * Generate Zod event schema from workflow start ports (populated by @param).
 */
function generateEventSchema(workflow: TWorkflowAST, eventName: string): string[] {
  const lines: string[] = [];
  const schemaFields: string[] = [];

  // workflow.startPorts maps @param annotations
  for (const [name, port] of Object.entries(workflow.startPorts || {})) {
    if (name === 'execute') continue; // Skip execute port
    const zodType = mapTypeToZod(port.tsType || port.dataType);
    schemaFields.push(`      ${name}: ${zodType},`);
  }

  if (schemaFields.length === 0) return [];

  const varName = toValidIdentifier(workflow.functionName) + 'Event';
  lines.push(`const ${varName} = {`);
  lines.push(`  name: '${eventName}',`);
  lines.push(`  schema: z.object({`);
  lines.push(`    data: z.object({`);
  lines.push(...schemaFields);
  lines.push(`    }),`);
  lines.push(`  }),`);
  lines.push(`};`);
  lines.push('');
  return lines;
}

/**
 * Map TypeScript/Flow Weaver types to Zod schema types.
 */
function mapTypeToZod(type?: string): string {
  if (!type) return 'z.unknown()';
  const t = type.trim().toLowerCase();
  if (t === 'string') return 'z.string()';
  if (t === 'number') return 'z.number()';
  if (t === 'boolean') return 'z.boolean()';
  if (t === 'string[]') return 'z.array(z.string())';
  if (t === 'number[]') return 'z.array(z.number())';
  if (t === 'object' || t.startsWith('record<')) return 'z.record(z.unknown())';
  return `z.unknown() /* ${type} */`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert camelCase/PascalCase to kebab-case for Inngest IDs */
function toKebabCase(name: string): string {
  return name
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .replace(/[^a-zA-Z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .toLowerCase();
}

/**
 * Resolve a port's value source for a given node instance.
 *
 * Unlike `buildNodeArgumentsWithContext` in code-utils.ts which emits
 * `ctx.getVariable()` calls, this returns a plain JS expression referencing
 * local `const` variables produced by earlier `step.run()` calls.
 */
function resolvePortValue(
  portName: string,
  instanceId: string,
  nodeType: TNodeTypeAST,
  workflow: TWorkflowAST,
  _nodeTypes: TNodeTypeAST[]
): string {
  const safeId = toValidIdentifier(instanceId);
  const portDef = nodeType.inputs[portName];
  const instance = workflow.instances.find((i) => i.id === instanceId);

  // Check for instance-level expression override
  const instancePortConfig = instance?.config?.portConfigs?.find(
    (pc) => pc.portName === portName && (pc.direction == null || pc.direction === 'INPUT')
  );
  if (instancePortConfig?.expression !== undefined) {
    const expr = String(instancePortConfig.expression);
    const isFunction = expr.includes('=>') || expr.trim().startsWith('function');
    if (isFunction) {
      return `await (${expr})()`;
    }
    return expr;
  }

  // Check for connections
  const connections = workflow.connections.filter(
    (conn) => conn.to.node === instanceId && conn.to.port === portName
        && !conn.from.scope && !conn.to.scope
  );

  if (connections.length > 0) {
    if (connections.length === 1) {
      const conn = connections[0];
      const sourceNode = conn.from.node;
      const sourcePort = conn.from.port;

      if (isStartNode(sourceNode)) {
        return `event.data.${sourcePort}`;
      }

      const safeSource = toValidIdentifier(sourceNode);
      return `${safeSource}_result.${sourcePort}`;
    }

    // Multiple connections — use first non-undefined (fan-in)
    const attempts = connections.map((conn) => {
      const sourceNode = conn.from.node;
      const sourcePort = conn.from.port;
      if (isStartNode(sourceNode)) {
        return `event.data.${sourcePort}`;
      }
      const safeSource = toValidIdentifier(sourceNode);
      return `${safeSource}_result?.${sourcePort}`;
    });
    return attempts.join(' ?? ');
  }

  // Check for node type expression
  if (portDef?.expression) {
    const expr = portDef.expression;
    const isFunction = expr.includes('=>') || expr.trim().startsWith('function');
    if (isFunction) {
      return `await (${expr})()`;
    }
    return expr;
  }

  // Default value
  if (portDef?.default !== undefined) {
    return JSON.stringify(portDef.default);
  }

  // Optional port
  if (portDef?.optional) {
    return 'undefined';
  }

  // No source — undefined with comment
  return `undefined /* no source for ${safeId}.${portName} */`;
}

/**
 * Build the argument list for calling a node function.
 * Returns array of JS expression strings to pass as function arguments.
 */
function buildNodeArgs(
  instanceId: string,
  nodeType: TNodeTypeAST,
  workflow: TWorkflowAST,
  nodeTypes: TNodeTypeAST[]
): string[] {
  const args: string[] = [];

  // Handle execute port (first arg for non-expression nodes)
  if (!nodeType.expression) {
    const executeConns = workflow.connections.filter(
      (conn) => conn.to.node === instanceId && conn.to.port === 'execute'
        && !conn.from.scope && !conn.to.scope
    );

    if (executeConns.length > 0) {
      const conn = executeConns[0];
      if (isStartNode(conn.from.node)) {
        args.push('true');
      } else {
        // Delay nodes (step.sleep) have no result variable — use literal values
        const sourceNt = getNodeType(conn.from.node, workflow, nodeTypes);
        if (sourceNt && isBuiltInNode(sourceNt) === 'delay') {
          args.push(conn.from.port === 'onSuccess' ? 'true' : 'false');
        } else {
          const safeSource = toValidIdentifier(conn.from.node);
          args.push(`${safeSource}_result.${conn.from.port}`);
        }
      }
    } else {
      args.push('true');
    }
  }

  // Handle data ports
  for (const portName of Object.keys(nodeType.inputs)) {
    if (isExecutePort(portName)) continue;
    if (nodeType.inputs[portName].scope) continue; // Skip scoped ports

    const value = resolvePortValue(portName, instanceId, nodeType, workflow, nodeTypes);
    args.push(value);
  }

  return args;
}

/**
 * Look up a node type for an instance.
 */
function getNodeType(
  instanceId: string,
  workflow: TWorkflowAST,
  nodeTypes: TNodeTypeAST[]
): TNodeTypeAST | undefined {
  const instance = workflow.instances.find((i) => i.id === instanceId);
  if (!instance) return undefined;
  return nodeTypes.find(
    (nt) => nt.name === instance.nodeType || nt.functionName === instance.nodeType
  );
}

// ---------------------------------------------------------------------------
// Parallel Detection
// ---------------------------------------------------------------------------

/**
 * Detect parallelizable groups within a list of node IDs.
 *
 * For each node, compute its direct predecessors within the given set.
 * Nodes with identical predecessor sets can execute in parallel.
 *
 * Returns an ordered list of groups preserving topological order.
 */
function detectParallelInList(
  nodeIds: string[],
  workflow: TWorkflowAST,
  nodeTypes: TNodeTypeAST[]
): string[][] {
  if (nodeIds.length <= 1) return nodeIds.map((n) => [n]);

  // Build mini-CFG: for each node, which other nodes in the list feed into it?
  const predecessors = new Map<string, Set<string>>();
  const nodeSet = new Set(nodeIds);

  for (const nodeId of nodeIds) {
    const preds = new Set<string>();
    for (const conn of workflow.connections) {
      if (conn.to.node !== nodeId) continue;
      if (conn.from.scope || conn.to.scope) continue;
      const fromNode = conn.from.node;
      if (nodeSet.has(fromNode)) {
        preds.add(fromNode);
      }
    }
    predecessors.set(nodeId, preds);
  }

  // Group by predecessor set (serialized for comparison)
  const groups: string[][] = [];
  const processed = new Set<string>();

  for (const nodeId of nodeIds) {
    if (processed.has(nodeId)) continue;

    const preds = predecessors.get(nodeId)!;
    const predsKey = Array.from(preds).sort().join(',');

    const parallel = [nodeId];
    for (const other of nodeIds) {
      if (other === nodeId || processed.has(other)) continue;
      const otherPreds = predecessors.get(other)!;
      const otherKey = Array.from(otherPreds).sort().join(',');
      if (predsKey === otherKey) {
        parallel.push(other);
      }
    }

    for (const n of parallel) {
      processed.add(n);
    }
    groups.push(parallel);
  }

  return groups;
}

// ---------------------------------------------------------------------------
// Code Generation — Core Emitters
// ---------------------------------------------------------------------------

/**
 * Generate a step.run() call for a durable node.
 */
function generateStepRunCall(
  instanceId: string,
  nodeType: TNodeTypeAST,
  workflow: TWorkflowAST,
  nodeTypes: TNodeTypeAST[],
  indent: string
): string {
  const args = buildNodeArgs(instanceId, nodeType, workflow, nodeTypes);
  const safeId = toValidIdentifier(instanceId);
  const fnCall = `${nodeType.functionName}(${args.join(', ')})`;
  const awaitPrefix = nodeType.isAsync ? 'await ' : '';

  return `${indent}${safeId}_result = await step.run('${instanceId}', async () => {\n` +
    `${indent}  return ${awaitPrefix}${fnCall};\n` +
    `${indent}});`;
}

/**
 * Generate an inline call for an expression node (no step.run wrapper).
 * Coercion nodes (variant === 'COERCION') emit inline JS expressions
 * (e.g. String(value)) instead of function calls.
 */
function generateExpressionCall(
  instanceId: string,
  nodeType: TNodeTypeAST,
  workflow: TWorkflowAST,
  nodeTypes: TNodeTypeAST[],
  indent: string
): string {
  const args = buildNodeArgs(instanceId, nodeType, workflow, nodeTypes);
  const safeId = toValidIdentifier(instanceId);

  if (nodeType.variant === 'COERCION') {
    const coerceExprMap: Record<string, string> = {
      __fw_toString: 'String',
      __fw_toNumber: 'Number',
      __fw_toBoolean: 'Boolean',
      __fw_toJSON: 'JSON.stringify',
      __fw_parseJSON: 'JSON.parse',
    };
    const coerceExpr = coerceExprMap[nodeType.functionName] || 'String';
    const valueArg = args[0] || 'undefined';
    return `${indent}${safeId}_result = ${coerceExpr}(${valueArg});`;
  }

  const fnCall = `${nodeType.functionName}(${args.join(', ')})`;
  const awaitPrefix = nodeType.isAsync ? 'await ' : '';

  return `${indent}${safeId}_result = ${awaitPrefix}${fnCall};`;
}

/**
 * Emit the step.run or expression call for a single node.
 * Built-in nodes (delay, waitForEvent, invokeWorkflow) are emitted with their
 * corresponding Inngest step primitives instead of step.run().
 */
function emitNodeCall(
  nodeId: string,
  nodeType: TNodeTypeAST,
  workflow: TWorkflowAST,
  nodeTypes: TNodeTypeAST[],
  indent: string,
  lines: string[]
): void {
  const builtIn = isBuiltInNode(nodeType);

  if (builtIn === 'delay') {
    const args = buildNodeArgs(nodeId, nodeType, workflow, nodeTypes);
    const durationArg = args[1]; // args[0] is execute=true, args[1] is duration
    lines.push(`${indent}await step.sleep('${nodeId}', ${durationArg});`);
    lines.push('');
    return;
  }

  if (builtIn === 'waitForEvent') {
    const safeId = toValidIdentifier(nodeId);
    const args = buildNodeArgs(nodeId, nodeType, workflow, nodeTypes);
    const eventNameArg = args[1]; // execute=args[0], eventName=args[1]
    const matchArg = args[2];     // optional
    const timeoutArg = args[3];   // optional

    lines.push(`${indent}const ${safeId}_raw = await step.waitForEvent('${nodeId}', {`);
    lines.push(`${indent}  event: ${eventNameArg},`);
    if (matchArg && matchArg !== 'undefined') {
      lines.push(`${indent}  match: ${matchArg},`);
    }
    if (timeoutArg && timeoutArg !== 'undefined') {
      lines.push(`${indent}  timeout: ${timeoutArg},`);
    }
    lines.push(`${indent}});`);
    lines.push(`${indent}${safeId}_result = ${safeId}_raw`);
    lines.push(`${indent}  ? { onSuccess: true, onFailure: false, eventData: ${safeId}_raw.data }`);
    lines.push(`${indent}  : { onSuccess: false, onFailure: true, eventData: {} };`);
    lines.push('');
    return;
  }

  if (builtIn === 'waitForAgent') {
    const safeId = toValidIdentifier(nodeId);
    const args = buildNodeArgs(nodeId, nodeType, workflow, nodeTypes);
    const agentIdArg = args[1]; // execute=args[0], agentId=args[1]

    // Map waitForAgent to step.waitForEvent with agent-scoped event name
    lines.push(`${indent}const ${safeId}_raw = await step.waitForEvent('${nodeId}', {`);
    lines.push(`${indent}  event: \`agent/\${${agentIdArg}}\`,`);
    lines.push(`${indent}  timeout: '7d',`);
    lines.push(`${indent}});`);
    lines.push(`${indent}${safeId}_result = ${safeId}_raw`);
    lines.push(`${indent}  ? { onSuccess: true, onFailure: false, agentResult: ${safeId}_raw.data ?? {} }`);
    lines.push(`${indent}  : { onSuccess: false, onFailure: true, agentResult: {} };`);
    lines.push('');
    return;
  }

  if (builtIn === 'invokeWorkflow') {
    const safeId = toValidIdentifier(nodeId);
    const args = buildNodeArgs(nodeId, nodeType, workflow, nodeTypes);
    const functionIdArg = args[1];
    const payloadArg = args[2];
    const timeoutArg = args[3];

    lines.push(`${indent}try {`);
    lines.push(`${indent}  ${safeId}_result = await step.invoke('${nodeId}', {`);
    lines.push(`${indent}    function: ${functionIdArg},`);
    lines.push(`${indent}    data: ${payloadArg},`);
    if (timeoutArg && timeoutArg !== 'undefined') {
      lines.push(`${indent}    timeout: ${timeoutArg},`);
    }
    lines.push(`${indent}  });`);
    lines.push(`${indent}  ${safeId}_result = { onSuccess: true, onFailure: false, result: ${safeId}_result };`);
    lines.push(`${indent}} catch (err) {`);
    lines.push(`${indent}  ${safeId}_result = { onSuccess: false, onFailure: true, result: {} };`);
    lines.push(`${indent}}`);
    lines.push('');
    return;
  }

  if (nodeType.expression) {
    lines.push(generateExpressionCall(nodeId, nodeType, workflow, nodeTypes, indent));
  } else {
    lines.push(generateStepRunCall(nodeId, nodeType, workflow, nodeTypes, indent));
  }
  lines.push('');
}

/**
 * Ensure all expression node dependencies for a given node are emitted before it.
 * Expression nodes are pure functions that can be safely emitted inline wherever needed.
 */
function ensureExpressionDependencies(
  nodeId: string,
  workflow: TWorkflowAST,
  nodeTypes: TNodeTypeAST[],
  indent: string,
  lines: string[],
  generatedNodes: Set<string>
): void {
  for (const conn of workflow.connections) {
    if (conn.to.node !== nodeId) continue;
    if (conn.from.scope || conn.to.scope) continue;

    const fromNode = conn.from.node;
    if (isStartNode(fromNode) || isExitNode(fromNode)) continue;
    if (generatedNodes.has(fromNode)) continue;

    const nt = getNodeType(fromNode, workflow, nodeTypes);
    if (!nt || !nt.expression) continue;

    // Recursively ensure this expression's own dependencies first
    ensureExpressionDependencies(fromNode, workflow, nodeTypes, indent, lines, generatedNodes);
    if (generatedNodes.has(fromNode)) continue;

    // Emit the expression node inline
    generatedNodes.add(fromNode);
    lines.push(generateExpressionCall(fromNode, nt, workflow, nodeTypes, indent));
    lines.push('');
  }
}

/**
 * Emit the if/else branching body for a branching node (without the step.run call).
 * Used after Promise.all to emit branching bodies separately from the step execution.
 */
function emitBranchingBody(
  nodeId: string,
  workflow: TWorkflowAST,
  nodeTypes: TNodeTypeAST[],
  branchingNodes: Set<string>,
  branchRegions: Map<string, { successNodes: Set<string>; failureNodes: Set<string> }>,
  branchingChains: Map<string, string[]>,
  chainMembers: Set<string>,
  indent: string,
  lines: string[],
  generatedNodes: Set<string>
): void {
  const safeId = toValidIdentifier(nodeId);
  const region = branchRegions.get(nodeId);
  if (!region) return;

  const hasSuccessBranch = region.successNodes.size > 0;
  const hasFailureBranch = region.failureNodes.size > 0;
  if (!hasSuccessBranch && !hasFailureBranch) return;

  // Delay nodes (step.sleep) always succeed — emit success branch directly, no if/else
  const branchNodeType = getNodeType(nodeId, workflow, nodeTypes);
  if (branchNodeType && isBuiltInNode(branchNodeType) === 'delay') {
    if (hasSuccessBranch) {
      const successOrder = getOrderedNodes(Array.from(region.successNodes), workflow, nodeTypes);
      generateNodeBlock(successOrder, workflow, nodeTypes, branchingNodes, branchRegions,
        branchingChains, chainMembers, indent, lines, generatedNodes);
    }
    return;
  }

  lines.push(`${indent}if (${safeId}_result.onSuccess) {`);
  if (hasSuccessBranch) {
    const successOrder = getOrderedNodes(Array.from(region.successNodes), workflow, nodeTypes);
    generateNodeBlock(successOrder, workflow, nodeTypes, branchingNodes, branchRegions,
      branchingChains, chainMembers, indent + '  ', lines, generatedNodes);
  }
  if (hasFailureBranch) {
    lines.push(`${indent}} else {`);
    const failureOrder = getOrderedNodes(Array.from(region.failureNodes), workflow, nodeTypes);
    generateNodeBlock(failureOrder, workflow, nodeTypes, branchingNodes, branchRegions,
      branchingChains, chainMembers, indent + '  ', lines, generatedNodes);
    lines.push(`${indent}}`);
  } else {
    lines.push(`${indent}}`);
  }
}

/**
 * Emit a Promise.all block for 2+ parallel nodes.
 * Delay nodes are excluded and emitted separately (step.sleep returns void).
 * waitForEvent/invokeWorkflow get their Inngest step primitives instead of step.run.
 */
function emitPromiseAll(
  nodeIds: string[],
  workflow: TWorkflowAST,
  nodeTypes: TNodeTypeAST[],
  indent: string,
  lines: string[],
  generatedNodes: Set<string>
): void {
  // Separate delay nodes from the group (step.sleep returns void, breaks destructuring)
  const delayNodes: string[] = [];
  const nonDelayNodes: string[] = [];
  for (const nodeId of nodeIds) {
    const nt = getNodeType(nodeId, workflow, nodeTypes);
    if (nt && isBuiltInNode(nt) === 'delay') {
      delayNodes.push(nodeId);
    } else {
      nonDelayNodes.push(nodeId);
    }
  }

  // Emit delay nodes sequentially first
  for (const delayId of delayNodes) {
    generatedNodes.add(delayId);
    const nt = getNodeType(delayId, workflow, nodeTypes)!;
    emitNodeCall(delayId, nt, workflow, nodeTypes, indent, lines);
  }

  // If only 1 non-delay node remains, emit it directly
  if (nonDelayNodes.length === 1) {
    const nodeId = nonDelayNodes[0];
    generatedNodes.add(nodeId);
    const nt = getNodeType(nodeId, workflow, nodeTypes)!;
    emitNodeCall(nodeId, nt, workflow, nodeTypes, indent, lines);
    return;
  }

  if (nonDelayNodes.length === 0) return;

  const destructured: string[] = [];
  const stepCalls: string[] = [];

  for (const nodeId of nonDelayNodes) {
    generatedNodes.add(nodeId);
    const nt = getNodeType(nodeId, workflow, nodeTypes)!;
    const safeId = toValidIdentifier(nodeId);
    const builtIn = isBuiltInNode(nt);

    if (builtIn === 'waitForEvent') {
      const args = buildNodeArgs(nodeId, nt, workflow, nodeTypes);
      const eventNameArg = args[1];
      const matchArg = args[2];
      const timeoutArg = args[3];
      let waitCall = `${indent}  step.waitForEvent('${nodeId}', { event: ${eventNameArg}`;
      if (matchArg && matchArg !== 'undefined') waitCall += `, match: ${matchArg}`;
      if (timeoutArg && timeoutArg !== 'undefined') waitCall += `, timeout: ${timeoutArg}`;
      waitCall += ` })`;
      stepCalls.push(waitCall);
    } else if (builtIn === 'waitForAgent') {
      const args = buildNodeArgs(nodeId, nt, workflow, nodeTypes);
      const agentIdArg = args[1];
      stepCalls.push(`${indent}  step.waitForEvent('${nodeId}', { event: \`agent/\${${agentIdArg}}\`, timeout: '7d' })`);
    } else if (builtIn === 'invokeWorkflow') {
      const args = buildNodeArgs(nodeId, nt, workflow, nodeTypes);
      const functionIdArg = args[1];
      const payloadArg = args[2];
      const timeoutArg = args[3];
      let invokeCall = `${indent}  step.invoke('${nodeId}', { function: ${functionIdArg}, data: ${payloadArg}`;
      if (timeoutArg && timeoutArg !== 'undefined') invokeCall += `, timeout: ${timeoutArg}`;
      invokeCall += ` })`;
      stepCalls.push(invokeCall);
    } else if (nt.variant === 'COERCION') {
      const coerceExprMap: Record<string, string> = {
        __fw_toString: 'String',
        __fw_toNumber: 'Number',
        __fw_toBoolean: 'Boolean',
        __fw_toJSON: 'JSON.stringify',
        __fw_parseJSON: 'JSON.parse',
      };
      const coerceExpr = coerceExprMap[nt.functionName] || 'String';
      const args = buildNodeArgs(nodeId, nt, workflow, nodeTypes);
      const valueArg = args[0] || 'undefined';
      stepCalls.push(`${indent}  Promise.resolve(${coerceExpr}(${valueArg}))`);
    } else if (nt.expression) {
      const args = buildNodeArgs(nodeId, nt, workflow, nodeTypes);
      const fnCall = `${nt.functionName}(${args.join(', ')})`;
      stepCalls.push(`${indent}  Promise.resolve(${fnCall})`);
    } else {
      const args = buildNodeArgs(nodeId, nt, workflow, nodeTypes);
      const fnCall = `${nt.functionName}(${args.join(', ')})`;
      const awaitPrefix = nt.isAsync ? 'await ' : '';
      stepCalls.push(
        `${indent}  step.run('${nodeId}', async () => ${awaitPrefix}${fnCall})`
      );
    }
    destructured.push(`${safeId}_result`);
  }

  lines.push(`${indent}[${destructured.join(', ')}] = await Promise.all([`);
  lines.push(stepCalls.join(',\n'));
  lines.push(`${indent}]);`);
  lines.push('');
}

// ---------------------------------------------------------------------------
// Code Generation — forEach / Scoped Iteration
// ---------------------------------------------------------------------------

/**
 * Generate code for forEach/scoped iteration patterns.
 *
 * Per-port scoped children execute inside a loop with indexed step names
 * for per-item durability: step.run(`processItem-${i}`, ...).
 */
function generateForEachScope(
  parentId: string,
  parentNodeType: TNodeTypeAST,
  scopeName: string,
  workflow: TWorkflowAST,
  nodeTypes: TNodeTypeAST[],
  indent: string,
  lines: string[]
): void {
  const safeParent = toValidIdentifier(parentId);

  // Find child instances in this scope
  const childInstances = workflow.instances.filter((inst) => {
    if (!inst.parent) return false;
    return inst.parent.id === parentId && inst.parent.scope === scopeName;
  });

  if (childInstances.length === 0) return;

  // Find the output port that provides items to iterate
  // Look for scoped output ports (these are parameters TO children)
  const scopedOutputPorts = Object.entries(parentNodeType.outputs).filter(
    ([_name, portDef]) => portDef.scope === scopeName
  );

  // The 'item' port (or similar) carries the current iteration value
  const itemPort = scopedOutputPorts.find(
    ([name]) => name !== 'start' && name !== 'success' && name !== 'failure'
  );

  if (!itemPort) {
    // No item port — just a simple callback scope, not forEach
    lines.push(`${indent}// Scope '${scopeName}' for ${parentId} (callback pattern)`);
    for (const child of childInstances) {
      const childNt = getNodeType(child.id, workflow, nodeTypes);
      if (!childNt) continue;
      lines.push(`${indent}const ${toValidIdentifier(child.id)}_result = await step.run('${child.id}', async () => {`);
      const args = buildNodeArgs(child.id, childNt, workflow, nodeTypes);
      const fnCall = `${childNt.functionName}(${args.join(', ')})`;
      const awaitPrefix = childNt.isAsync ? 'await ' : '';
      lines.push(`${indent}  return ${awaitPrefix}${fnCall};`);
      lines.push(`${indent}});`);
      lines.push('');
    }
    return;
  }

  // Find the source that provides the array to iterate
  // The parent's result should have the items
  const [itemPortName] = itemPort;
  const arraySource = `${safeParent}_result.${itemPortName}`;

  // Generate the loop with indexed step names
  lines.push(`${indent}const ${safeParent}_${scopeName}_results = [];`);
  lines.push(`${indent}for (let __i__ = 0; __i__ < ${arraySource}.length; __i__++) {`);
  lines.push(`${indent}  const __item__ = ${arraySource}[__i__];`);

  for (const child of childInstances) {
    const childNt = getNodeType(child.id, workflow, nodeTypes);
    if (!childNt) continue;
    const safeChild = toValidIdentifier(child.id);

    // Build args, replacing the scoped connection with __item__
    const args: string[] = [];
    if (!childNt.expression) {
      args.push('true'); // execute = true
    }
    for (const portName of Object.keys(childNt.inputs)) {
      if (isExecutePort(portName)) continue;
      if (childNt.inputs[portName].scope) continue;

      // Check if this port connects from the scope's item port
      const scopedConn = workflow.connections.find(
        (conn) => conn.to.node === child.id && conn.to.port === portName
          && conn.from.node === parentId && conn.from.port === itemPortName
      );
      if (scopedConn) {
        args.push('__item__');
      } else {
        args.push(resolvePortValue(portName, child.id, childNt, workflow, nodeTypes));
      }
    }

    const fnCall = `${childNt.functionName}(${args.join(', ')})`;
    const awaitPrefix = childNt.isAsync ? 'await ' : '';

    if (childNt.expression) {
      lines.push(`${indent}  const ${safeChild}_result = ${awaitPrefix}${fnCall};`);
    } else {
      lines.push(`${indent}  const ${safeChild}_result = await step.run(\`${child.id}-\${__i__}\`, async () => {`);
      lines.push(`${indent}    return ${awaitPrefix}${fnCall};`);
      lines.push(`${indent}  });`);
    }
    lines.push(`${indent}  ${safeParent}_${scopeName}_results.push(${safeChild}_result);`);
  }

  lines.push(`${indent}}`);
  lines.push('');
}

// ---------------------------------------------------------------------------
// Code Generation — Block Generation with Parallelism & Branching
// ---------------------------------------------------------------------------

/**
 * Generate code for a set of nodes, handling branching, parallelism, and chains.
 *
 * This is the recursive core called for top-level nodes and branch bodies.
 */
function generateNodeBlock(
  nodeIds: string[],
  workflow: TWorkflowAST,
  nodeTypes: TNodeTypeAST[],
  branchingNodes: Set<string>,
  branchRegions: Map<string, { successNodes: Set<string>; failureNodes: Set<string> }>,
  branchingChains: Map<string, string[]>,
  chainMembers: Set<string>,
  indent: string,
  lines: string[],
  generatedNodes: Set<string>
): void {
  // Filter to ungenerated real nodes
  const remaining = nodeIds.filter(
    (n) => !generatedNodes.has(n) && !isStartNode(n) && !isExitNode(n)
  );
  if (remaining.length === 0) return;

  // Detect parallelism within this block
  const groups = detectParallelInList(remaining, workflow, nodeTypes);

  for (const group of groups) {
    const eligible = group.filter((n) => !generatedNodes.has(n));
    if (eligible.length === 0) continue;

    if (eligible.length >= 2) {
      // Check if all are expression nodes (no need for Promise.all)
      const allExpr = eligible.every((n) => {
        const nt = getNodeType(n, workflow, nodeTypes);
        return nt?.expression;
      });

      if (allExpr) {
        for (const nodeId of eligible) {
          emitSingleNode(nodeId, workflow, nodeTypes, branchingNodes, branchRegions,
            branchingChains, chainMembers, indent, lines, generatedNodes);
        }
      } else {
        // Separate expression nodes, chain heads, and parallelizable step.run nodes
        const exprNodes = eligible.filter((n) => {
          const nt = getNodeType(n, workflow, nodeTypes);
          return nt?.expression;
        });
        const chainHeadNodes = eligible.filter((n) => {
          const nt = getNodeType(n, workflow, nodeTypes);
          return nt && !nt.expression && branchingChains.has(n);
        });
        const parallelStepNodes = eligible.filter((n) => {
          const nt = getNodeType(n, workflow, nodeTypes);
          return nt && !nt.expression && !branchingChains.has(n);
        });

        // Emit expression nodes individually first (may be data dependencies)
        for (const nodeId of exprNodes) {
          emitSingleNode(nodeId, workflow, nodeTypes, branchingNodes, branchRegions,
            branchingChains, chainMembers, indent, lines, generatedNodes);
        }

        // Ensure expression dependencies for all parallel step nodes
        for (const nodeId of parallelStepNodes) {
          ensureExpressionDependencies(nodeId, workflow, nodeTypes, indent, lines, generatedNodes);
        }

        // Emit step.run nodes via Promise.all (includes branching nodes)
        if (parallelStepNodes.length >= 2) {
          emitPromiseAll(parallelStepNodes, workflow, nodeTypes, indent, lines, generatedNodes);

          // After Promise.all, emit branching bodies for any branching nodes
          for (const nodeId of parallelStepNodes) {
            if (branchingNodes.has(nodeId) && branchRegions.has(nodeId)) {
              emitBranchingBody(nodeId, workflow, nodeTypes, branchingNodes, branchRegions,
                branchingChains, chainMembers, indent, lines, generatedNodes);
            }
          }
        } else {
          for (const nodeId of parallelStepNodes) {
            emitSingleNode(nodeId, workflow, nodeTypes, branchingNodes, branchRegions,
              branchingChains, chainMembers, indent, lines, generatedNodes);
          }
        }

        // Emit chain head nodes sequentially (they manage their own chain)
        for (const nodeId of chainHeadNodes) {
          emitSingleNode(nodeId, workflow, nodeTypes, branchingNodes, branchRegions,
            branchingChains, chainMembers, indent, lines, generatedNodes);
        }
      }
    } else {
      // Single node — standard emission
      for (const nodeId of eligible) {
        emitSingleNode(nodeId, workflow, nodeTypes, branchingNodes, branchRegions,
          branchingChains, chainMembers, indent, lines, generatedNodes);
      }
    }
  }
}

/**
 * Emit code for a single node — dispatches to the right emitter.
 */
function emitSingleNode(
  nodeId: string,
  workflow: TWorkflowAST,
  nodeTypes: TNodeTypeAST[],
  branchingNodes: Set<string>,
  branchRegions: Map<string, { successNodes: Set<string>; failureNodes: Set<string> }>,
  branchingChains: Map<string, string[]>,
  chainMembers: Set<string>,
  indent: string,
  lines: string[],
  generatedNodes: Set<string>
): void {
  if (generatedNodes.has(nodeId)) return;

  const nodeType = getNodeType(nodeId, workflow, nodeTypes);
  if (!nodeType) return;

  // Skip chain members — they'll be emitted by their chain head
  if (chainMembers.has(nodeId)) return;

  // Ensure expression node dependencies are emitted first
  ensureExpressionDependencies(nodeId, workflow, nodeTypes, indent, lines, generatedNodes);

  generatedNodes.add(nodeId);

  // Check if this is the head of a branching chain
  const chain = branchingChains.get(nodeId);
  if (chain && branchingNodes.has(nodeId)) {
    generateBranchingChain(chain, workflow, nodeTypes, branchingNodes, branchRegions,
      branchingChains, chainMembers, indent, lines, generatedNodes);
    return;
  }

  // Check for forEach/scoped children
  const hasPerPortScopedChildren = workflow.instances.some(
    (inst) => inst.parent && inst.parent.id === nodeId
      && isPerPortScopedChild(inst, workflow, nodeTypes)
  );

  if (branchingNodes.has(nodeId) && branchRegions.has(nodeId)) {
    generateBranchingNode(nodeId, nodeType, workflow, nodeTypes, branchingNodes,
      branchRegions, branchingChains, chainMembers, indent, lines, generatedNodes);
  } else {
    emitNodeCall(nodeId, nodeType, workflow, nodeTypes, indent, lines);
  }

  // Emit scoped children (forEach) after the parent node
  if (hasPerPortScopedChildren) {
    const scopeNames = new Set<string>();
    if (nodeType.scope) scopeNames.add(nodeType.scope);
    if (nodeType.scopes) {
      for (const s of nodeType.scopes) scopeNames.add(s);
    }
    // Also collect from port definitions
    for (const portDef of Object.values(nodeType.outputs)) {
      if (portDef.scope) scopeNames.add(portDef.scope);
    }
    for (const portDef of Object.values(nodeType.inputs)) {
      if (portDef.scope) scopeNames.add(portDef.scope);
    }

    scopeNames.forEach((scopeName) => {
      generateForEachScope(nodeId, nodeType, scopeName, workflow, nodeTypes, indent, lines);
    });
  }
}

/**
 * Generate code for a branching node (has onSuccess/onFailure connections).
 */
function generateBranchingNode(
  nodeId: string,
  nodeType: TNodeTypeAST,
  workflow: TWorkflowAST,
  nodeTypes: TNodeTypeAST[],
  branchingNodes: Set<string>,
  branchRegions: Map<string, { successNodes: Set<string>; failureNodes: Set<string> }>,
  branchingChains: Map<string, string[]>,
  chainMembers: Set<string>,
  indent: string,
  lines: string[],
  generatedNodes: Set<string>
): void {
  // Generate the step.run / expression call for this node
  emitNodeCall(nodeId, nodeType, workflow, nodeTypes, indent, lines);

  // Emit the if/else branching body
  emitBranchingBody(nodeId, workflow, nodeTypes, branchingNodes, branchRegions,
    branchingChains, chainMembers, indent, lines, generatedNodes);
}

/**
 * Generate a chain of branching nodes as flat if/else if/else.
 *
 * Chains are sequential branching nodes where one direction has exactly one
 * branching child and the other has zero. Flattening reduces nesting depth.
 *
 * Generated structure:
 *   step.run(A)
 *   if (!A.onSuccess) { ...A failure body... }
 *   step.run(B)  // B is in A's success path
 *   else if (!B.onSuccess) { ...B failure body... }
 *   else { ...last node's success body... }
 */
function generateBranchingChain(
  chain: string[],
  workflow: TWorkflowAST,
  nodeTypes: TNodeTypeAST[],
  branchingNodes: Set<string>,
  branchRegions: Map<string, { successNodes: Set<string>; failureNodes: Set<string> }>,
  branchingChains: Map<string, string[]>,
  chainMembers: Set<string>,
  indent: string,
  lines: string[],
  generatedNodes: Set<string>
): void {
  for (let i = 0; i < chain.length; i++) {
    const nodeId = chain[i];
    const safeId = toValidIdentifier(nodeId);
    const nodeType = getNodeType(nodeId, workflow, nodeTypes);

    // Ensure expression dependencies before emitting this chain node
    ensureExpressionDependencies(nodeId, workflow, nodeTypes, indent, lines, generatedNodes);
    generatedNodes.add(nodeId);

    // Emit step.run / expression call for this chain node
    if (nodeType) {
      emitNodeCall(nodeId, nodeType, workflow, nodeTypes, indent, lines);
    }

    const region = branchRegions.get(nodeId);
    if (!region) continue;

    const hasSuccessBranch = region.successNodes.size > 0;
    const hasFailureBranch = region.failureNodes.size > 0;
    if (!hasSuccessBranch && !hasFailureBranch) continue;

    const nextInChain = i + 1 < chain.length ? chain[i + 1] : null;
    const isLast = !nextInChain;
    const chainViaSuccess = nextInChain && region.successNodes.has(nextInChain);
    const chainViaFailure = nextInChain && region.failureNodes.has(nextInChain);

    if (isLast) {
      // Delay nodes (step.sleep) always succeed — emit success branch directly, no if/else
      if (nodeType && isBuiltInNode(nodeType) === 'delay') {
        if (hasSuccessBranch) {
          const successOrder = getOrderedNodes(Array.from(region.successNodes), workflow, nodeTypes);
          generateNodeBlock(successOrder, workflow, nodeTypes, branchingNodes, branchRegions,
            branchingChains, chainMembers, indent, lines, generatedNodes);
        }
      } else if (hasSuccessBranch || hasFailureBranch) {
        // Last node in chain — emit standard branching for both sides
        lines.push(`${indent}if (${safeId}_result.onSuccess) {`);
        if (hasSuccessBranch) {
          const successOrder = getOrderedNodes(Array.from(region.successNodes), workflow, nodeTypes);
          generateNodeBlock(successOrder, workflow, nodeTypes, branchingNodes, branchRegions,
            branchingChains, chainMembers, indent + '  ', lines, generatedNodes);
        }
        if (hasFailureBranch) {
          lines.push(`${indent}} else {`);
          const failureOrder = getOrderedNodes(Array.from(region.failureNodes), workflow, nodeTypes);
          generateNodeBlock(failureOrder, workflow, nodeTypes, branchingNodes, branchRegions,
            branchingChains, chainMembers, indent + '  ', lines, generatedNodes);
        }
        lines.push(`${indent}}`);
      }
    } else if (chainViaSuccess) {
      // Chain continues through success path; emit failure branch if it exists
      if (hasFailureBranch) {
        lines.push(`${indent}if (!${safeId}_result.onSuccess) {`);
        const failureOrder = getOrderedNodes(Array.from(region.failureNodes), workflow, nodeTypes);
        generateNodeBlock(failureOrder, workflow, nodeTypes, branchingNodes, branchRegions,
          branchingChains, chainMembers, indent + '  ', lines, generatedNodes);
        lines.push(`${indent}}`);
      }
      // Built-in nodes (delay, waitForEvent, invokeWorkflow) bypass the execute flag,
      // so the chain continuation must be explicitly guarded.
      const nextNt = getNodeType(nextInChain!, workflow, nodeTypes);
      if (nextNt && isBuiltInNode(nextNt)) {
        lines.push(`${indent}if (${safeId}_result.onSuccess) {`);
        const remainingChain = chain.slice(i + 1);
        generateBranchingChain(remainingChain, workflow, nodeTypes, branchingNodes, branchRegions,
          branchingChains, chainMembers, indent + '  ', lines, generatedNodes);
        lines.push(`${indent}}`);
        return; // Remaining chain already generated inside guard
      }
      // For normal nodes, execute flag handles it — continue flat
    } else if (chainViaFailure) {
      // Chain continues through failure path; emit success branch if it exists
      if (hasSuccessBranch) {
        lines.push(`${indent}if (${safeId}_result.onSuccess) {`);
        const successOrder = getOrderedNodes(Array.from(region.successNodes), workflow, nodeTypes);
        generateNodeBlock(successOrder, workflow, nodeTypes, branchingNodes, branchRegions,
          branchingChains, chainMembers, indent + '  ', lines, generatedNodes);
        lines.push(`${indent}}`);
      }
      // Built-in nodes bypass the execute flag — guard the chain continuation
      const nextNtF = getNodeType(nextInChain!, workflow, nodeTypes);
      if (nextNtF && isBuiltInNode(nextNtF)) {
        lines.push(`${indent}if (!${safeId}_result.onSuccess) {`);
        const remainingChain = chain.slice(i + 1);
        generateBranchingChain(remainingChain, workflow, nodeTypes, branchingNodes, branchRegions,
          branchingChains, chainMembers, indent + '  ', lines, generatedNodes);
        lines.push(`${indent}}`);
        return; // Remaining chain already generated inside guard
      }
      // For normal nodes, execute flag handles it — continue flat
    }
  }
}

/**
 * Order nodes by topological sort within a subset.
 */
function getOrderedNodes(
  nodeIds: string[],
  workflow: TWorkflowAST,
  nodeTypes: TNodeTypeAST[]
): string[] {
  if (nodeIds.length <= 1) return nodeIds;

  const cfg = buildControlFlowGraph(workflow, nodeTypes);
  const fullOrder = performKahnsTopologicalSort(cfg);

  const nodeSet = new Set(nodeIds);
  return fullOrder.filter((n) => nodeSet.has(n));
}

/**
 * Collect exit port values and build the return statement.
 */
function generateReturnStatement(
  workflow: TWorkflowAST,
  indent: string
): string {
  const exitConnections = workflow.connections.filter((conn) => isExitNode(conn.to.node));

  if (exitConnections.length === 0) {
    return `${indent}return {};`;
  }

  const props: string[] = [];
  const seen = new Set<string>();
  for (const conn of exitConnections) {
    const exitPort = conn.to.port;
    if (seen.has(exitPort)) continue;
    seen.add(exitPort);

    const sourceNode = conn.from.node;
    const sourcePort = conn.from.port;

    if (isStartNode(sourceNode)) {
      props.push(`${exitPort}: event.data.${sourcePort}`);
    } else {
      const safeSource = toValidIdentifier(sourceNode);
      props.push(`${exitPort}: ${safeSource}_result?.${sourcePort}`);
    }
  }

  return `${indent}return { ${props.join(', ')} };`;
}

// ---------------------------------------------------------------------------
// Main Generator
// ---------------------------------------------------------------------------

/**
 * Generate an Inngest function from a workflow AST.
 *
 * Produces a complete TypeScript module with:
 * - Import statements (Inngest SDK + node type functions)
 * - `inngest.createFunction()` with per-node `step.run()` calls
 * - Parallel execution via `Promise.all` where safe
 * - Branching via if/else for onSuccess/onFailure
 * - Chain flattening for sequential branching (3-way routing)
 * - Indexed `step.run()` for forEach iteration
 *
 * @param workflow - The workflow AST to generate from
 * @param nodeTypes - All available node type definitions
 * @param options - Generation options (service name, trigger, retries, etc.)
 * @returns Complete TypeScript source code string
 */
export function generateInngestFunction(
  workflow: TWorkflowAST,
  nodeTypes: TNodeTypeAST[],
  options?: InngestGenerationOptions
): string {
  const serviceName = options?.serviceName ?? toKebabCase(workflow.functionName);
  const functionId = toKebabCase(workflow.functionName);
  const triggerEvent = options?.triggerEvent ?? `fw/${functionId}.execute`;
  const retries = workflow.options?.retries ?? options?.retries ?? 3;

  const lines: string[] = [];

  // -- Imports --
  lines.push(`import { Inngest } from 'inngest';`);
  if (options?.typedEvents) {
    lines.push(`import { z } from 'zod';`);
  }
  if (options?.serveHandler && options?.framework) {
    const importMap: Record<string, string> = {
      next: 'inngest/next',
      express: 'inngest/express',
      hono: 'inngest/hono',
      fastify: 'inngest/fastify',
      remix: 'inngest/remix',
    };
    lines.push(`import { serve } from '${importMap[options.framework]}';`);
  }
  lines.push('');

  // Collect node type imports (deduplicate by function name)
  const importedFunctions = new Set<string>();
  for (const instance of workflow.instances) {
    if (isPerPortScopedChild(instance, workflow, nodeTypes)) continue;

    const nodeType = nodeTypes.find(
      (nt) => nt.name === instance.nodeType || nt.functionName === instance.nodeType
    );
    if (nodeType && !importedFunctions.has(nodeType.functionName)) {
      if (isBuiltInNode(nodeType)) continue; // Skip built-in nodes — no user import
      importedFunctions.add(nodeType.functionName);
      lines.push(`import { ${nodeType.functionName} } from './node-types/${nodeType.functionName}.js';`);
    }
  }
  lines.push('');

  // -- Inngest client --
  lines.push(`const inngest = new Inngest({ id: '${serviceName}' });`);
  lines.push('');

  // -- Typed event schema (Feature 1) --
  if (options?.typedEvents) {
    const schemaEventName = workflow.options?.trigger?.event ?? triggerEvent;
    const schemaLines = generateEventSchema(workflow, schemaEventName);
    if (schemaLines.length > 0) {
      lines.push(...schemaLines);
    }
  }

  // -- Function definition --
  const fnVar = `${toValidIdentifier(workflow.functionName)}Fn`;
  const configEntries: string[] = [
    `id: '${functionId}'`,
    `retries: ${retries}`,
  ];

  // Add timeout from workflow options
  if (workflow.options?.timeout) {
    configEntries.push(`timeouts: { finish: '${workflow.options.timeout}' }`);
  }

  // Add throttle from workflow options
  if (workflow.options?.throttle) {
    const t = workflow.options.throttle;
    const throttleConfig: string[] = [`limit: ${t.limit}`];
    if (t.period) throttleConfig.push(`period: '${t.period}'`);
    configEntries.push(`throttle: { ${throttleConfig.join(', ')} }`);
  }

  // Add cancelOn from workflow options
  if (workflow.options?.cancelOn) {
    const c = workflow.options.cancelOn;
    const cancelConfig: string[] = [`event: '${c.event}'`];
    if (c.match) {
      cancelConfig.push(`match: '${c.match}'`);
    }
    if (c.timeout) {
      cancelConfig.push(`timeout: '${c.timeout}'`);
    }
    configEntries.push(`cancelOn: [{ ${cancelConfig.join(', ')} }]`);
  }

  if (options?.functionConfig) {
    for (const [key, value] of Object.entries(options.functionConfig)) {
      if (key !== 'id' && key !== 'retries') {
        configEntries.push(`${key}: ${JSON.stringify(value)}`);
      }
    }
  }

  lines.push(`export const ${fnVar} = inngest.createFunction(`);
  lines.push(`  { ${configEntries.join(', ')} },`);

  // Trigger emission (Feature 2)
  const trigger = workflow.options?.trigger;
  if (trigger?.cron && trigger?.event) {
    lines.push(`  { event: '${trigger.event}' },`);
  } else if (trigger?.cron) {
    lines.push(`  { cron: '${trigger.cron}' },`);
  } else {
    const eventName = trigger?.event ?? triggerEvent;
    lines.push(`  { event: '${eventName}' },`);
  }

  lines.push(`  async ({ event, step }) => {`);

  // -- Build control flow --
  const cfg = buildControlFlowGraph(workflow, nodeTypes);
  const executionOrder = performKahnsTopologicalSort(cfg);
  const branchingNodes = findAllBranchingNodes(workflow, nodeTypes);

  // For Inngest: remove trivially branching nodes that only connect success/failure to Exit.
  // These don't need if/else blocks — they just route status to the workflow exit.
  // (The unified generator keeps them for catch block error handling.)
  for (const nodeId of [...branchingNodes]) {
    const hasNonExitBranch = workflow.connections.some(
      (conn) =>
        conn.from.node === nodeId &&
        (isSuccessPort(conn.from.port) || isFailurePort(conn.from.port)) &&
        !isExitNode(conn.to.node)
    );
    if (!hasNonExitBranch) {
      branchingNodes.delete(nodeId);
    }
  }

  const allInstanceIds = new Set(workflow.instances.map((i) => i.id));
  const branchRegions = new Map<string, { successNodes: Set<string>; failureNodes: Set<string> }>();
  branchingNodes.forEach((branchInstanceId) => {
    const successNodes = findNodesInBranch(
      branchInstanceId,
      RESERVED_PORT_NAMES.ON_SUCCESS,
      workflow,
      allInstanceIds,
      branchingNodes,
      nodeTypes
    );
    const failureNodes = findNodesInBranch(
      branchInstanceId,
      RESERVED_PORT_NAMES.ON_FAILURE,
      workflow,
      allInstanceIds,
      branchingNodes,
      nodeTypes
    );
    branchRegions.set(branchInstanceId, { successNodes, failureNodes });
  });

  // Handle multi-branch membership: promote nodes in multiple branches
  const instancesInMultipleBranches = new Set<string>();
  allInstanceIds.forEach((instanceId) => {
    let branchCount = 0;
    branchRegions.forEach((region) => {
      if (region.successNodes.has(instanceId) || region.failureNodes.has(instanceId)) {
        branchCount++;
      }
    });
    if (branchCount > 1) {
      instancesInMultipleBranches.add(instanceId);
    }
  });
  branchRegions.forEach((region) => {
    instancesInMultipleBranches.forEach((instanceId) => {
      region.successNodes.delete(instanceId);
      region.failureNodes.delete(instanceId);
    });
  });

  // Detect branching chains for if/else if flattening
  const branchingChains = detectBranchingChains(branchingNodes, branchRegions);

  // Identify chain members (non-heads) that are emitted by their chain head
  const chainMembers = new Set<string>();
  branchingChains.forEach((chain) => {
    for (let i = 1; i < chain.length; i++) {
      chainMembers.add(chain[i]);
    }
  });

  // Compute nodes in any branch (not top-level)
  const nodesInAnyBranch = new Set<string>();
  branchRegions.forEach((region) => {
    region.successNodes.forEach((n) => nodesInAnyBranch.add(n));
    region.failureNodes.forEach((n) => nodesInAnyBranch.add(n));
  });

  // Filter execution order to top-level nodes
  const topLevelNodes = executionOrder.filter(
    (n) =>
      !isStartNode(n) &&
      !isExitNode(n) &&
      !nodesInAnyBranch.has(n) &&
      !chainMembers.has(n)
  );

  // -- Generate node execution code --
  const indent = '    ';
  const generatedNodes = new Set<string>();

  // Pre-declare result variables so they're accessible from all scopes (branch bodies, return statement)
  // Skip delay nodes — step.sleep() returns void, no result variable needed
  const resultVarNames: string[] = [];
  for (const instance of workflow.instances) {
    if (isStartNode(instance.id) || isExitNode(instance.id)) continue;
    if (isPerPortScopedChild(instance, workflow, nodeTypes)) continue;
    const nt = getNodeType(instance.id, workflow, nodeTypes);
    if (nt && isBuiltInNode(nt) === 'delay') continue;
    resultVarNames.push(toValidIdentifier(instance.id) + '_result');
  }
  if (resultVarNames.length > 0) {
    lines.push(`${indent}let ${resultVarNames.map((v) => v + ': any').join(', ')};`);
    lines.push('');
  }

  generateNodeBlock(
    topLevelNodes,
    workflow,
    nodeTypes,
    branchingNodes,
    branchRegions,
    branchingChains,
    chainMembers,
    indent,
    lines,
    generatedNodes
  );

  // -- Return statement --
  lines.push(generateReturnStatement(workflow, indent));
  lines.push('  }');
  lines.push(');');
  lines.push('');

  // -- Serve handler (Feature 7) --
  if (options?.serveHandler && options?.framework) {
    const framework = options.framework;

    lines.push(`// --- Serve handler (${framework}) ---`);
    if (framework === 'next') {
      lines.push(`export const { GET, POST, PUT } = serve({`);
    } else {
      lines.push(`export const handler = serve({`);
    }
    lines.push(`  client: inngest,`);
    lines.push(`  functions: [${fnVar}],`);
    lines.push(`});`);
    lines.push('');
  }

  return lines.join('\n');
}
