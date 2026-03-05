/**
 * Durable AI Agent Template
 * Linear agent pipeline with durability annotations.
 * Each node maps to a checkpointed step when compiled to a durable target.
 */
import type { WorkflowTemplate, WorkflowTemplateOptions } from '@synergenius/flow-weaver/cli';
import { getProviderCode, aiConfigSchema, LLM_CORE_TYPES, LLM_MOCK_PROVIDER_WITH_TOOLS } from '@synergenius/flow-weaver/cli';

export const aiAgentDurableTemplate: WorkflowTemplate = {
  id: 'ai-agent-durable',
  name: 'Durable AI Agent',
  description: 'Linear agent pipeline with durability — classify, tools, approval, respond',
  category: 'ai',
  configSchema: aiConfigSchema,

  generate: ({ workflowName, config }: WorkflowTemplateOptions): string => {
    const provider = (config?.provider as string) || 'mock';
    const model = (config?.model as string) || '';

    const providerCode =
      provider === 'mock'
        ? `
/* ============================================================
 * MOCK PROVIDER (REPLACE IN REAL USE)
 * ============================================================ */

${LLM_MOCK_PROVIDER_WITH_TOOLS}
`
        : getProviderCode(provider, model);

    return `
// ============================================================
// Durable AI Agent
// ============================================================
//
// Each node becomes a checkpointed step when compiled to a durable target.
// If a step fails, it retries from that step, not from scratch.
//
// Compile:  flow-weaver compile <file>
// Export:   fw export --target <target>
//
// Flow: classify → executeTool → requestApproval → respond

/* ============================================================
 * CORE TYPES
 * ============================================================ */

${LLM_CORE_TYPES}

/* ============================================================
 * TOOL DEFINITIONS
 * ============================================================ */

type ToolResult =
  | { ok: true; value: string }
  | { ok: false; error: string };

type ToolFn = (args: Record<string, unknown>) => Promise<ToolResult>;

const AVAILABLE_TOOLS: LLMTool[] = [
  {
    name: 'search',
    description: 'Search for information',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string' },
      },
      required: ['query'],
    },
  },
];

const TOOL_IMPLEMENTATIONS: Record<string, ToolFn> = {
  async search(args) {
    if (typeof args.query !== 'string') {
      return { ok: false, error: 'Invalid query' };
    }
    return { ok: true, value: '[Search results for: ' + args.query + ']' };
  },
};

/* ============================================================
 * APPROVAL BACKEND (mock — replace with real backend)
 * ============================================================
 *
 * On durable targets, this node compiles to a platform-native wait primitive.
 * The function pauses (zero compute cost) until an approval event arrives.
 */

interface ApprovalResult {
  approved: boolean;
  response: string;
  reviewer: string;
}

async function requestApproval(prompt: string, context?: Record<string, unknown>): Promise<ApprovalResult> {
  console.log('[Mock Approval] Auto-approving:', prompt);
  return { approved: true, response: 'Auto-approved (mock)', reviewer: 'system' };
}

${providerCode}

const SYSTEM_PROMPT = \`You are a helpful AI assistant with access to tools.
Use tools when necessary. Respond directly when the task is complete.\`;

/* ============================================================
 * NODES
 * ============================================================ */

/**
 * Classify the user's request and determine if tools are needed
 *
 * @flowWeaver nodeType
 * @label Classify
 * @color purple
 * @icon psychology
 * @input execute [order:0] - Execute
 * @input userMessage [order:1] - User's input message
 * @output onSuccess [order:0] - On Success
 * @output onFailure [order:1] - On Failure
 * @output content [order:2] - LLM response text
 * @output toolCalls [order:3] - Tool calls requested by LLM
 * @output hasToolCalls [order:4] - Whether LLM wants to call tools
 * @output messages [order:5] - Updated conversation messages
 */
async function classify(
  execute: boolean,
  userMessage: string
): Promise<{
  onSuccess: boolean;
  onFailure: boolean;
  content: string | null;
  toolCalls: LLMToolCall[];
  hasToolCalls: boolean;
  messages: LLMMessage[];
}> {
  if (!execute) {
    return { onSuccess: false, onFailure: false, content: null, toolCalls: [], hasToolCalls: false, messages: [] };
  }

  try {
    const messages: LLMMessage[] = [{ role: 'user', content: userMessage }];
    const response = await llmProvider.chat(messages, {
      tools: AVAILABLE_TOOLS,
      systemPrompt: SYSTEM_PROMPT,
    });

    return {
      onSuccess: true,
      onFailure: false,
      content: response.content,
      toolCalls: response.toolCalls,
      hasToolCalls: response.toolCalls.length > 0,
      messages: [
        ...messages,
        { role: 'assistant', content: response.content || '' },
      ],
    };
  } catch {
    return { onSuccess: false, onFailure: true, content: null, toolCalls: [], hasToolCalls: false, messages: [] };
  }
}

/**
 * Execute tool calls from the LLM response
 *
 * @flowWeaver nodeType
 * @label Execute Tools
 * @color cyan
 * @icon build
 * @input execute [order:0] - Execute
 * @input toolCalls [order:1] - Tool calls to execute
 * @output onSuccess [order:0] - On Success
 * @output onFailure [order:1] - On Failure
 * @output results [order:2] - Tool execution results as messages
 */
async function executeTool(
  execute: boolean,
  toolCalls: LLMToolCall[]
): Promise<{
  onSuccess: boolean;
  onFailure: boolean;
  results: LLMMessage[];
}> {
  if (!execute || !toolCalls || toolCalls.length === 0) {
    return { onSuccess: true, onFailure: false, results: [] };
  }

  const results: LLMMessage[] = [];

  for (const call of toolCalls) {
    const impl = TOOL_IMPLEMENTATIONS[call.name];
    if (!impl) {
      results.push({ role: 'tool', content: 'Unknown tool: ' + call.name, toolCallId: call.id });
      continue;
    }

    const result = await impl(call.arguments);
    results.push({
      role: 'tool',
      content: result.ok ? result.value : 'Error: ' + result.error,
      toolCallId: call.id,
    });
  }

  return { onSuccess: true, onFailure: false, results };
}

/**
 * Request human approval before proceeding
 *
 * @flowWeaver nodeType
 * @label Request Approval
 * @color orange
 * @icon verified
 * @input execute [order:0] - Execute
 * @input toolResults [order:1] - Tool results to review
 * @output onSuccess [order:0] - On Success
 * @output onFailure [order:1] - On Failure (rejected or timeout)
 * @output approved [order:2] - Whether the request was approved
 */
async function approvalGate(
  execute: boolean,
  toolResults: LLMMessage[]
): Promise<{
  onSuccess: boolean;
  onFailure: boolean;
  approved: boolean;
}> {
  if (!execute) {
    return { onSuccess: false, onFailure: false, approved: false };
  }

  try {
    const summary = toolResults.map((m) => m.content).join('; ');
    const result = await requestApproval(
      'Review tool execution results before responding to user',
      { toolResults: summary }
    );

    if (!result.approved) {
      return { onSuccess: false, onFailure: true, approved: false };
    }

    return { onSuccess: true, onFailure: false, approved: true };
  } catch {
    return { onSuccess: false, onFailure: true, approved: false };
  }
}

/**
 * Generate the final response incorporating tool results
 *
 * @flowWeaver nodeType
 * @label Respond
 * @color purple
 * @icon psychology
 * @input execute [order:0] - Execute
 * @input messages [order:1] - Conversation history including tool results
 * @input toolResults [order:2] - Tool result messages to append
 * @output onSuccess [order:0] - On Success
 * @output onFailure [order:1] - On Failure
 * @output response [order:2] - Final response text
 */
async function respond(
  execute: boolean,
  messages: LLMMessage[],
  toolResults: LLMMessage[]
): Promise<{
  onSuccess: boolean;
  onFailure: boolean;
  response: string;
}> {
  if (!execute) {
    return { onSuccess: false, onFailure: false, response: '' };
  }

  try {
    const fullMessages = [...messages, ...toolResults];
    const result = await llmProvider.chat(fullMessages, {
      systemPrompt: SYSTEM_PROMPT,
    });

    return {
      onSuccess: true,
      onFailure: false,
      response: result.content || 'No response generated',
    };
  } catch {
    return { onSuccess: false, onFailure: true, response: '' };
  }
}

/* ============================================================
 * WORKFLOW
 * ============================================================ */

/**
 * Durable AI Agent — linear pipeline with tool calling and human approval.
 * Each node becomes a checkpointed step when compiled to a durable target.
 *
 * @flowWeaver workflow
 * @trigger event="agent/request"
 * @retries 3
 * @node cls classify [position: -280 0]
 * @node tools executeTool [position: -40 0]
 * @node approval approvalGate [position: 200 0]
 * @node resp respond [position: 440 0]
 * @position Start -500 0
 * @position Exit 680 0
 * @connect Start.execute -> cls.execute
 * @connect Start.userMessage -> cls.userMessage
 * @connect cls.onSuccess -> tools.execute
 * @connect cls.toolCalls -> tools.toolCalls
 * @connect tools.onSuccess -> approval.execute
 * @connect tools.results -> approval.toolResults
 * @connect approval.onSuccess -> resp.execute
 * @connect cls.messages -> resp.messages
 * @connect tools.results -> resp.toolResults
 * @connect cls.onFailure -> Exit.onFailure
 * @connect resp.onSuccess -> Exit.onSuccess
 * @connect resp.response -> Exit.response
 * @param execute [order:0] - Execute
 * @param userMessage [order:1] - User's message to the agent
 * @returns onSuccess [order:0] - Agent completed successfully
 * @returns onFailure [order:1] - Agent encountered an error
 * @returns response [order:2] - Agent's final response
 */
export async function ${workflowName}(
  execute: boolean,
  params: { userMessage: string }
): Promise<{
  onSuccess: boolean;
  onFailure: boolean;
  response: string;
}> {
  throw new Error('Compile with: flow-weaver compile <file>');
}
`.trim();
  },
};
