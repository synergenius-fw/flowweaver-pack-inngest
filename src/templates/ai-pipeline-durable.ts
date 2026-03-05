/**
 * Durable AI Pipeline Template
 * Sequential data processing pipeline with durability annotations.
 * Each node maps to a checkpointed step — if step 3 fails, it retries from step 3, not from scratch.
 */
import type { WorkflowTemplate, WorkflowTemplateOptions } from '@synergenius/flow-weaver/cli';
import { getProviderCode, aiConfigSchema, LLM_CORE_TYPES, LLM_MOCK_PROVIDER } from '@synergenius/flow-weaver/cli';

export const aiPipelineDurableTemplate: WorkflowTemplate = {
  id: 'ai-pipeline-durable',
  name: 'Durable AI Pipeline',
  description: 'Sequential data pipeline with durability — fetch, extract, validate, save',
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

${LLM_MOCK_PROVIDER}
`
        : getProviderCode(provider, model);

    return `
// ============================================================
// Durable Data Pipeline
// ============================================================
//
// Each node becomes a checkpointed step when compiled to a durable target.
// If step 3 fails, it retries from step 3, not from scratch.
//
// Compile:  flow-weaver compile <file>
// Export:   fw export --target <target>
//
// Flow: fetchData → extract (LLM) → validate → save
//                                      ↓ onFailure
//                                    Exit.onFailure

/* ============================================================
 * CORE TYPES
 * ============================================================ */

${LLM_CORE_TYPES}

/* ============================================================
 * STORAGE (mock — replace with real database/API)
 * ============================================================ */

interface ExtractedRecord {
  title: string;
  summary: string;
  entities: string[];
  confidence: number;
}

const mockStore: Map<string, ExtractedRecord> = new Map();

${providerCode}

/* ============================================================
 * NODES
 * ============================================================ */

/**
 * Fetch raw data from a URL
 *
 * @flowWeaver nodeType
 * @label Fetch Data
 * @color blue
 * @icon download
 * @input execute [order:0] - Execute
 * @input url [order:1] - URL to fetch data from
 * @output onSuccess [order:0] - On Success
 * @output onFailure [order:1] - On Failure
 * @output data [order:2] - Raw fetched data
 * @output contentType [order:3] - Response content type
 */
async function fetchData(
  execute: boolean,
  url: string
): Promise<{
  onSuccess: boolean;
  onFailure: boolean;
  data: string;
  contentType: string;
}> {
  if (!execute) {
    return { onSuccess: false, onFailure: false, data: '', contentType: '' };
  }

  try {
    // Mock fetch — replace with real HTTP call
    // const response = await fetch(url);
    // const data = await response.text();
    // return { onSuccess: true, onFailure: false, data, contentType: response.headers.get('content-type') || '' };

    console.log('[Mock Fetch]', url);
    const mockData = JSON.stringify({
      title: 'Sample Article',
      body: 'This article discusses the benefits of compiled workflows for AI agent reliability and testing.',
      author: 'Jane Doe',
      date: '2026-02-18',
    });

    return { onSuccess: true, onFailure: false, data: mockData, contentType: 'application/json' };
  } catch (error) {
    console.error('Fetch failed:', error);
    return { onSuccess: false, onFailure: true, data: '', contentType: '' };
  }
}

/**
 * Use LLM to extract structured information from raw data
 *
 * @flowWeaver nodeType
 * @label Extract Info
 * @color purple
 * @icon psychology
 * @input execute [order:0] - Execute
 * @input rawData [order:1] - Raw data to extract from
 * @output onSuccess [order:0] - On Success
 * @output onFailure [order:1] - On Failure
 * @output extracted [order:2] - Extracted structured record
 */
async function extractInfo(
  execute: boolean,
  rawData: string
): Promise<{
  onSuccess: boolean;
  onFailure: boolean;
  extracted: ExtractedRecord | null;
}> {
  if (!execute) {
    return { onSuccess: false, onFailure: false, extracted: null };
  }

  try {
    const prompt = \`Extract the following from this data:
- title: the main title
- summary: a one-sentence summary
- entities: list of named entities (people, organizations, topics)
- confidence: how confident you are in the extraction (0-1)

Respond with valid JSON only.

Data:
\${rawData}\`;

    const response = await llmProvider.chat([{ role: 'user', content: prompt }]);

    // Parse LLM response as JSON
    const content = response.content || '{}';

    // Try to extract JSON from response (handle markdown fences)
    let jsonStr = content;
    const fenceMatch = content.match(/\`\`\`(?:json)?\\s*([\\s\\S]*?)\`\`\`/);
    if (fenceMatch) {
      jsonStr = fenceMatch[1].trim();
    }

    // Mock extraction for mock provider
    let extracted: ExtractedRecord;
    try {
      extracted = JSON.parse(jsonStr);
    } catch {
      // Fallback for mock provider responses
      extracted = {
        title: 'Extracted Title',
        summary: 'Extracted summary from raw data.',
        entities: ['entity1', 'entity2'],
        confidence: 0.85,
      };
    }

    return { onSuccess: true, onFailure: false, extracted };
  } catch {
    return { onSuccess: false, onFailure: true, extracted: null };
  }
}

/**
 * Validate extracted data against expected schema
 *
 * @flowWeaver nodeType
 * @label Validate
 * @color yellow
 * @icon check-circle
 * @input execute [order:0] - Execute
 * @input data [order:1] - Extracted record to validate
 * @output onSuccess [order:0] - On Success (valid)
 * @output onFailure [order:1] - On Failure (invalid)
 * @output validated [order:2] - Validated record
 * @output errors [order:3] - Validation error messages
 */
function validateResult(
  execute: boolean,
  data: ExtractedRecord | null
): {
  onSuccess: boolean;
  onFailure: boolean;
  validated: ExtractedRecord | null;
  errors: string[];
} {
  if (!execute) {
    return { onSuccess: false, onFailure: false, validated: null, errors: [] };
  }

  const errors: string[] = [];

  if (!data) {
    errors.push('No data to validate');
    return { onSuccess: false, onFailure: true, validated: null, errors };
  }

  if (!data.title || typeof data.title !== 'string') {
    errors.push('Missing or invalid title');
  }
  if (!data.summary || typeof data.summary !== 'string') {
    errors.push('Missing or invalid summary');
  }
  if (!Array.isArray(data.entities)) {
    errors.push('Missing or invalid entities array');
  }
  if (typeof data.confidence !== 'number' || data.confidence < 0 || data.confidence > 1) {
    errors.push('Confidence must be a number between 0 and 1');
  }

  if (errors.length > 0) {
    return { onSuccess: false, onFailure: true, validated: null, errors };
  }

  return { onSuccess: true, onFailure: false, validated: data, errors: [] };
}

/**
 * Save validated record to storage
 *
 * @flowWeaver nodeType
 * @label Save Result
 * @color green
 * @icon database
 * @input execute [order:0] - Execute
 * @input data [order:1] - Validated record to save
 * @output onSuccess [order:0] - On Success
 * @output onFailure [order:1] - On Failure
 * @output id [order:2] - Saved record identifier
 */
async function saveResult(
  execute: boolean,
  data: ExtractedRecord
): Promise<{
  onSuccess: boolean;
  onFailure: boolean;
  id: string;
}> {
  if (!execute) {
    return { onSuccess: false, onFailure: false, id: '' };
  }

  try {
    // Mock save — replace with real database/API:
    // await db.insert('records', data);
    // return { onSuccess: true, onFailure: false, id: result.insertedId };

    const id = 'rec_' + Date.now().toString(36);
    mockStore.set(id, data);
    console.log('[Mock Save] Stored record:', id);

    return { onSuccess: true, onFailure: false, id };
  } catch (error) {
    console.error('Save failed:', error);
    return { onSuccess: false, onFailure: true, id: '' };
  }
}

/* ============================================================
 * WORKFLOW
 * ============================================================ */

/**
 * Durable Data Pipeline — sequential fetch, extract, validate, save.
 * Each node becomes a checkpointed step when compiled to a durable target.
 *
 * @flowWeaver workflow
 * @trigger event="pipeline/start"
 * @retries 3
 * @node fetch fetchData [position: -280 0]
 * @node extract extractInfo [position: -40 0]
 * @node validate validateResult [position: 200 0]
 * @node save saveResult [position: 440 0]
 * @position Start -500 0
 * @position Exit 680 0
 * @connect Start.execute -> fetch.execute
 * @connect Start.url -> fetch.url
 * @connect fetch.onSuccess -> extract.execute
 * @connect fetch.data -> extract.rawData
 * @connect extract.onSuccess -> validate.execute
 * @connect extract.extracted -> validate.data
 * @connect validate.onSuccess -> save.execute
 * @connect validate.validated -> save.data
 * @connect fetch.onFailure -> Exit.onFailure
 * @connect extract.onFailure -> Exit.onFailure
 * @connect validate.onFailure -> Exit.onFailure
 * @connect save.onSuccess -> Exit.onSuccess
 * @connect save.id -> Exit.id
 * @connect validate.errors -> Exit.errors
 * @param execute [order:0] - Execute
 * @param url [order:1] - URL to fetch and process
 * @returns onSuccess [order:0] - Pipeline completed successfully
 * @returns onFailure [order:1] - Pipeline encountered an error
 * @returns id [order:2] - Saved record identifier
 * @returns errors [order:3] - Validation errors (if any)
 */
export async function ${workflowName}(
  execute: boolean,
  params: { url: string }
): Promise<{
  onSuccess: boolean;
  onFailure: boolean;
  id: string;
  errors: string[];
}> {
  throw new Error('Compile with: flow-weaver compile <file>');
}
`.trim();
  },
};
