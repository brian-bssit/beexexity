import 'dotenv/config';

/**
 * Application configuration.
 * AWS Bedrock is locked to ap-southeast-3 (Jakarta) for data residency compliance.
 * Database is GCP Cloud SQL (public IP).
 */

/** Default private Tier-1 Bedrock model (routed auto model). Single source. */
const DEFAULT_PRIVATE_MODEL = 'qwen.qwen3-235b-a22b-2507-v1:0';

/** Parse an int env with sane bounds — malformed/missing → default, never NaN/throw. */
function intEnv(name: string, def: number, min: number, max: number): number {
  const v = parseInt(process.env[name] || '', 10);
  if (Number.isNaN(v)) return def;
  return Math.min(max, Math.max(min, v));
}

export const config = {
  aws: {
    region: 'ap-southeast-3',
  },
  server: {
    port: parseInt(process.env.PORT || '3000', 10),
  },
  jwt: {
    secret: process.env.JWT_SECRET || 'change-me-in-production',
    expiresIn: parseInt(process.env.JWT_EXPIRES_IN || '3600', 10),
  },
  database: {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    database: process.env.DB_NAME || 'bedrock_gateway',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || '',
  },
  routing: {
    longContextThreshold: parseInt(
      process.env.ROUTING_LONG_CONTEXT_THRESHOLD || '8000', 10
    ),
    scoringTimeoutMs: parseInt(
      process.env.ROUTING_SCORING_TIMEOUT_MS || '5000', 10
    ),
    refinementTimeoutMs: parseInt(
      process.env.ROUTING_REFINEMENT_TIMEOUT_MS || '8000', 10
    ),
    defaultFallbackScore: parseInt(
      process.env.ROUTING_DEFAULT_FALLBACK_SCORE || '2', 10
    ),
    metadataEnabled: process.env.ROUTING_METADATA_ENABLED !== 'false',
    transparencyEnabled: process.env.ROUTING_TRANSPARENCY_ENABLED === 'true',
    scoringModelId: 'qwen.qwen3-32b-v1:0',
    classifierTimeoutMs: parseInt(
      process.env.ROUTING_CLASSIFIER_TIMEOUT_MS || '2000', 10
    ),
    /** Fixed model used when routingState = 'auto' (deterministic — no LLM routing). */
    autoModelId: process.env.AUTO_MODEL_ID || DEFAULT_PRIVATE_MODEL,
    /** Restricted (T1) private Bedrock model — empty → autoModelId. */
    tier1ModelId: process.env.TIER1_MODEL_ID || '',
    /** Tier-3 external OpenAI-compatible gateway (auto-only). Key lives in env only. */
    externalTier3: {
      baseUrl: process.env.TIER3_BASE_URL || '',
      apiKey: process.env.TIER3_API_KEY || '',
      enabled: process.env.TIER3_ENABLED === 'true',
      /** Model-family prefixes that get ReAct tools + thinking params. Default DeepSeek. */
      toolModelPrefixes: (process.env.TIER3_TOOL_MODEL_PREFIXES || 'deepseek-v4-')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      /** Extra top-level body params for thinking-capable allowlisted models (e.g. {"enable_thinking":true} for Qwen on SumoPod). Placement per gateway — confirm via spike before enabling. */
      thinkingParams: (() => {
        try {
          const v = JSON.parse(process.env.TIER3_THINKING_PARAMS || '{}');
          return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
        } catch { return {}; }
      })(),
    },
    /** Tier-1 private-Bedrock tool loop (multi-hop RAG). Default OFF — zero behavior change. */
    tier1Tools: {
      enabled: process.env.TIER1_TOOLS_ENABLED === 'true',
      /** Allowlisted model that receives tools — empty → routed auto model (qwen3-235b). */
      modelId: process.env.TIER1_TOOLS_MODEL_ID || '',
      maxIterations: intEnv('TIER1_MAX_TOOL_ITERATIONS', 3, 1, 10),
      toolTimeoutMs: intEnv('TIER1_TOOL_TIMEOUT_MS', 30000, 1000, 120000),
      /** Tool-result count cap (chunks returned in full — never char-truncated). */
      toolTopK: intEnv('TIER1_TOOL_TOP_K', 3, 1, 10),
    },
  },
  gotenberg: {
    /** URL of the Gotenberg sidecar service for legacy Office format conversion (.doc, .ppt). */
    url: process.env.GOTENBERG_URL || '',
    /** Timeout in ms for Gotenberg conversion requests. */
    timeoutMs: parseInt(process.env.GOTENBERG_TIMEOUT_MS || '30000', 10),
  },
  extraction: {
    /** Max extracted text chars below which confidence is 'low' → triggers OCR fallback */
    lowConfidenceThreshold: parseInt(
      process.env.EXTRACTION_LOW_CONFIDENCE_THRESHOLD || '100', 10
    ),
    /** Max nesting depth for JSON parsing — deeper is rejected as FILE_TOO_COMPLEX */
    maxJsonDepth: parseInt(
      process.env.EXTRACTION_MAX_JSON_DEPTH || '20', 10
    ),
    /** Max tag nesting depth for HTML — deeper is rejected as FILE_TOO_COMPLEX */
    maxHtmlTagDepth: parseInt(
      process.env.EXTRACTION_MAX_HTML_DEPTH || '100', 10
    ),
    /** Max rows for CSV — exceeded returns empty with warning logged */
    maxCsvRows: parseInt(
      process.env.EXTRACTION_MAX_CSV_ROWS || '100000', 10
    ),
    /** Max XML entries inside a PPTX ZIP — exceeded rejected as FILE_TOO_COMPLEX */
    maxPptxEntries: parseInt(
      process.env.EXTRACTION_MAX_PPTX_ENTRIES || '2000', 10
    ),
  },
  google: {
    /** Google OAuth 2.0 client ID for login (GIS, OIDC, public client). */
    clientId: process.env.GOOGLE_CLIENT_ID || '',
    /** Google OAuth 2.0 Web Client ID for Drive API (confidential client). */
    driveClientId: process.env.GOOGLE_DRIVE_CLIENT_ID || '',
    /** Google OAuth 2.0 Web Client secret for Drive API. */
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
    /** Drive API fetch timeout in ms. */
    driveTimeoutMs: parseInt(process.env.GOOGLE_DRIVE_TIMEOUT_MS || '10000', 10),
  },
  auth: {
    minPasswordLength: parseInt(process.env.MIN_PASSWORD_LENGTH || '8', 10),
    resetTokenExpiresIn: 300, // 5 minutes for password reset token
  },
  batch: {
    /** Max prompt length for batch inference (256KB for meeting transcripts). */
    maxPromptLength: parseInt(process.env.BATCH_MAX_PROMPT_LENGTH || '262144', 10),
    /** JSON body parser limit for batch endpoint (512KB). */
    bodyLimit: '512kb',
  },
  subagent: {
    /** Max concurrent sub-agents running in parallel. */
    concurrency: parseInt(process.env.SUBAGENT_CONCURRENCY || '3', 10),
    /** Max attempts per sub-agent before marking failed. */
    maxAttempts: parseInt(process.env.SUBAGENT_MAX_ATTEMPTS || '2', 10),
    /** Timeout per sub-agent execution in ms (120s). */
    timeoutMs: parseInt(process.env.SUBAGENT_TIMEOUT_MS || '120000', 10),
    /** Max tokens per agent before per-agent summarization is triggered. */
    tokenBudget: parseInt(process.env.SUBAGENT_TOKEN_BUDGET || '30000', 10),
  },
  pptx: {
    /** URL of the python-pptx microservice (Cloud Run internal URL). */
    serviceUrl: process.env.PPTX_SERVICE_URL || '',
  },
  session: {
    expiryHours: parseInt(process.env.SESSION_EXPIRY_HOURS || '24', 10),
    tokenBudget: parseInt(process.env.SESSION_TOKEN_BUDGET || '200000', 10),
    safetyMargin: parseInt(process.env.SESSION_SAFETY_MARGIN || '20000', 10),
    summaryThreshold: parseInt(process.env.SESSION_SUMMARY_THRESHOLD || '40', 10),
    charsPerToken: parseInt(process.env.SESSION_CHARS_PER_TOKEN || '4', 10),
    routingContextMaxChars: parseInt(process.env.SESSION_ROUTING_CONTEXT_MAX_CHARS || '500', 10),
    routingContextMaxTurns: parseInt(process.env.SESSION_ROUTING_CONTEXT_MAX_TURNS || '2', 10),
    maxHistoryTurns: parseInt(process.env.MAX_HISTORY_TURNS || '20', 10),
    maxContextCharacters: parseInt(process.env.MAX_CONTEXT_CHARACTERS || '640000', 10),
    listPageSize: parseInt(process.env.SESSION_LIST_PAGE_SIZE || '50', 10),
  },
  knowledge: {
    /** Embedding model — Cohere Embed v4 via cross-region inference profile.
     *  Bare `cohere.embed-v4:0` is rejected ("on-demand throughput isn't supported");
     *  the `global.` profile routes correctly from ap-southeast-3. */
    embeddingModel: process.env.KNOWLEDGE_EMBEDDING_MODEL || 'global.cohere.embed-v4:0',
    /** Embedding dimensions — Cohere Embed v4 emits a fixed 1536-dim vector
     *  (the Bedrock inference profile rejects a `dimensions` param). */
    embeddingDimensions: 1536,
    /** Timeout per embedding call. */
    embeddingTimeoutMs: parseInt(process.env.EMBEDDING_TIMEOUT_MS || '2000', 10),
    /** Chunks embedded per Bedrock call during ingestion. */
    embedBatchSize: parseInt(process.env.KNOWLEDGE_EMBED_BATCH_SIZE || '32', 10),
    /** Timeout for a batched ingestion embedding call. */
    embeddingBatchTimeoutMs: parseInt(process.env.EMBEDDING_BATCH_TIMEOUT_MS || '15000', 10),
    /** Timeout for knowledge retrieval during inference. */
    searchTimeoutMs: parseInt(process.env.KNOWLEDGE_SEARCH_TIMEOUT_MS || '2000', 10),
    /** Chunk size in tokens (~4 chars per token). */
    chunkSizeTokens: parseInt(process.env.KNOWLEDGE_CHUNK_SIZE || '1000', 10),
    /** Chunk overlap in tokens. */
    chunkOverlapTokens: parseInt(process.env.KNOWLEDGE_CHUNK_OVERLAP || '100', 10),
    /** Max chunks injected into the system prompt during inference. */
    topK: parseInt(process.env.KNOWLEDGE_TOP_K || '5', 10),
    /** Cosine gate for retrieval: below this, the KB is treated as "not covering" the
     *  query → empty result → sovereign routing escalates open text to Tier 3. Calibrated
     *  to this corpus: genuine in-domain queries score ≥0.40, out-of-domain ≤0.33. */
    minRelevanceScore: parseFloat(process.env.KNOWLEDGE_MIN_SCORE || '0.4'),
  },
} as const;
