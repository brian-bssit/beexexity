import { fetchDocument } from './google-drive.service.js';
import { getValidAccessToken } from './google-drive-token.service.js';
import type { DriveFetchResult } from './google-drive.service.js';

export interface GoogleWorkspaceUrl {
  fileId: string;
  fullUrl: string;
  type: 'document' | 'spreadsheet' | 'presentation' | 'drive';
}

export interface UrlInterceptorResult {
  /** Prompt with GWS URL replaced by `[Google {type}: {title}]` placeholder. */
  cleanedPrompt: string;
  /** Raw document text extracted from Drive (pre-PII). */
  extractedDocumentText: string;
  documentTitle: string;
  fileId: string;
  mimeType: string;
}

/**
 * Regex matches all Google Workspace URL formats:
 * - docs.google.com/document/d/{fileId}
 * - docs.google.com/spreadsheets/d/{fileId}
 * - docs.google.com/presentation/d/{fileId}
 * - drive.google.com/file/d/{fileId}
 * Captures full URL in group 1, fileId in group 2.
 */
const GWS_URL_REGEX = /((?:https?:\/\/)?(?:docs\.google\.com\/(?:document|spreadsheets|presentation)\/d\/|drive\.google\.com\/file\/d\/)([a-zA-Z0-9_-]{10,100}))(?:[/?#]\S*)?/g;

/** Fenced (```) and inline (`) markdown code spans — content is not scanned. */
const CODE_SPAN_REGEX = /```[\s\S]*?(?:```|$)|`[^`\n]*`/g;

/**
 * Extract all Google Workspace URLs from a prompt.
 * URLs inside markdown code blocks (backtick-delimited) are ignored (FR-1).
 */
export function extractUrls(prompt: string): GoogleWorkspaceUrl[] {
  // Blank code spans with equal-length spaces (keeps indices/offsets stable)
  // so a docs URL that appears inside code is never treated as a fetch target.
  const scrubbed = prompt.replace(CODE_SPAN_REGEX, (m) => ' '.repeat(m.length));
  const urls: GoogleWorkspaceUrl[] = [];
  const matches = scrubbed.matchAll(GWS_URL_REGEX);

  for (const m of matches) {
    const fullUrl = m[1];
    const fileId = m[2];

    let type: GoogleWorkspaceUrl['type'] = 'drive';
    if (fullUrl.includes('/document/')) type = 'document';
    else if (fullUrl.includes('/spreadsheets/')) type = 'spreadsheet';
    else if (fullUrl.includes('/presentation/')) type = 'presentation';

    urls.push({ fileId, fullUrl, type });
  }

  return urls;
}

/** Replace GWS URLs in prompt with short placeholders. */
export function replaceUrlsWithPlaceholders(
  prompt: string,
  urls: GoogleWorkspaceUrl[],
  title: string,
): string {
  let result = prompt;
  for (const url of urls) {
    const typeLabel = url.type === 'drive' ? 'File' : `Google ${url.type.charAt(0).toUpperCase() + url.type.slice(1)}`;
    result = result.replace(url.fullUrl, `[${typeLabel}: ${title}]`);
  }
  return result;
}

/**
 * Intercept Google Workspace URLs in a prompt.
 * Returns null if no GWS URL found.
 * Throws GoogleDriveNotAuthorizedError if user hasn't authorized Drive.
 */
export async function interceptUrls(
  prompt: string,
  userId: string,
): Promise<UrlInterceptorResult | null> {
  const urls = extractUrls(prompt);

  if (urls.length === 0) return null;

  // Warn if >3 URLs (logged server-side, not blocking)
  if (urls.length > 3) {
    console.warn(`[url-interceptor] User ${userId} has ${urls.length} GWS URLs — processing first only`);
  }

  const target = urls[0];

  // Check token exists (throws if not)
  const token = await getValidAccessToken(userId);

  // Fetch document
  const doc: DriveFetchResult = await fetchDocument(target.fileId, token);

  // Replace URLs with placeholder
  const cleanedPrompt = replaceUrlsWithPlaceholders(prompt, urls, doc.title);

  return {
    cleanedPrompt,
    extractedDocumentText: doc.text,
    documentTitle: doc.title,
    fileId: target.fileId,
    mimeType: doc.mimeType,
  };
}
