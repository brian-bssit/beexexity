import 'dotenv/config';

/**
 * Application configuration.
 * AWS Bedrock is locked to ap-southeast-3 (Jakarta) for data residency compliance.
 * Database is GCP Cloud SQL (public IP).
 */

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
    clientId: process.env.GOOGLE_CLIENT_ID || '',
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
  orchestration: {
    /** Max steps in a sequential reasoning plan (2-10). */
    maxSequentialSteps: parseInt(process.env.MAX_SEQUENTIAL_STEPS || '6', 10),
    /** Char threshold for map-reduce — documents larger trigger Step 1 Data Cruncher. */
    largeDocumentThreshold: parseInt(process.env.LARGE_DOCUMENT_THRESHOLD || '50000', 10),
    /** Max wall-clock for full orchestration before abort. */
    orchestrationTimeoutMs: parseInt(process.env.ORCHESTRATION_TIMEOUT_MS || '120000', 10),
    /** Max attempts per step before skipping. */
    stepRetryCount: parseInt(process.env.STEP_RETRY_COUNT || '2', 10),
    /** Emit interim synthesis every N steps (0 = disabled). */
    progressiveInterval: parseInt(process.env.PROGRESSIVE_INTERVAL || '3', 10),
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
    /** Embedding model (Bedrock Titan Embeddings v2, 1024 dims). */
    embeddingModel: 'amazon.titan-embed-text-v2:0',
    /** Embedding dimensions (matches migration 024 VECTOR(1024)). */
    embeddingDimensions: 1024,
    /** Timeout per embedding call. */
    embeddingTimeoutMs: parseInt(process.env.EMBEDDING_TIMEOUT_MS || '2000', 10),
    /** Timeout for knowledge retrieval during inference. */
    searchTimeoutMs: parseInt(process.env.KNOWLEDGE_SEARCH_TIMEOUT_MS || '2000', 10),
    /** Chunk size in tokens (~4 chars per token). */
    chunkSizeTokens: parseInt(process.env.KNOWLEDGE_CHUNK_SIZE || '1000', 10),
    /** Chunk overlap in tokens. */
    chunkOverlapTokens: parseInt(process.env.KNOWLEDGE_CHUNK_OVERLAP || '100', 10),
    /** Max chunks injected into the system prompt during inference. */
    topK: parseInt(process.env.KNOWLEDGE_TOP_K || '5', 10),
    /** Below this cosine score, semantic results are considered noise → keyword fallback. */
    hybridThreshold: parseFloat(process.env.KNOWLEDGE_HYBRID_THRESHOLD || '0.4'),
    /** Below this score, results are not injected into the prompt. */
    minRelevanceScore: parseFloat(process.env.KNOWLEDGE_MIN_SCORE || '0.3'),
  },
} as const;
