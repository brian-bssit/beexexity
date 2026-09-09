import { config } from '../config/index.js';
import { extractDocumentText } from './document-extractor.service.js';

/** Max downloadable file size (bytes) — larger documents must be uploaded manually. */
const MAX_DRIVE_BYTES = 10 * 1024 * 1024;

export interface DriveFetchResult {
  title: string;
  text: string;
  mimeType: string;
  sizeBytes: number;
}

/** MIME type → export format mapping for Google-native formats. */
const EXPORT_MAP: Record<string, string> = {
  'application/vnd.google-apps.document': 'text/plain',
  'application/vnd.google-apps.spreadsheet': 'text/csv',
  'application/vnd.google-apps.presentation': 'text/plain',
};

/** Fetch and export a Google Workspace document. */
export async function fetchDocument(
  fileId: string,
  accessToken: string,
): Promise<DriveFetchResult> {
  const baseUrl = 'https://www.googleapis.com/drive/v3/files';
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
  };
  const signal = AbortSignal.timeout(config.google.driveTimeoutMs);

  // 1. Get metadata
  const metaUrl = `${baseUrl}/${encodeURIComponent(fileId)}?fields=id,name,mimeType,size`;
  const metaRes = await fetch(metaUrl, { headers, signal });
  if (!metaRes.ok) {
    throw mapDriveError(metaRes.status, metaRes.statusText);
  }
  const meta: { id: string; name: string; mimeType: string; size?: string } = await metaRes.json();

  // Reject oversized downloads up-front (Google-native exports report no size).
  if (meta.size && Number(meta.size) > MAX_DRIVE_BYTES) {
    throw Object.assign(new Error('Dokumen melebihi batas 10MB, silakan upload manual'), {
      code: 'GOOGLE_DRIVE_TOO_LARGE',
      statusCode: 413,
    });
  }

  const exportMime = EXPORT_MAP[meta.mimeType];
  let text: string;
  let sizeBytes: number;

  if (exportMime) {
    // 2a. Export Google-native format
    const exportUrl = `${baseUrl}/${encodeURIComponent(fileId)}/export?mimeType=${encodeURIComponent(exportMime)}`;
    const exportRes = await fetch(exportUrl, { headers, signal });
    if (!exportRes.ok) {
      throw mapDriveError(exportRes.status, `Export failed: ${exportRes.statusText}`);
    }
    text = await exportRes.text();
    sizeBytes = new TextEncoder().encode(text).length;
  } else {
    // 2b. Download binary file
    const downloadUrl = `${baseUrl}/${encodeURIComponent(fileId)}?alt=media`;
    const downloadRes = await fetch(downloadUrl, { headers, signal });
    if (!downloadRes.ok) {
      throw mapDriveError(downloadRes.status, `Download failed: ${downloadRes.statusText}`);
    }
    const buffer = Buffer.from(await downloadRes.arrayBuffer());
    sizeBytes = buffer.length;

    // Route binary files through the existing format-aware extractor (PDF/DOCX/XLSX/...).
    try {
      const extracted = await extractDocumentText({
        buffer,
        mimetype: meta.mimeType,
        originalname: meta.name,
        size: sizeBytes,
      });
      text = extracted.text;
    } catch (err: unknown) {
      // Unsupported/corrupt file — degrade to empty rather than block the turn.
      console.warn(`[google-drive] Extraction failed for ${meta.name} (${meta.mimeType}): ${(err as Error).message}`);
      text = '';
    }
  }

  return {
    title: meta.name,
    text,
    mimeType: meta.mimeType,
    sizeBytes,
  };
}

/** Map Drive API HTTP errors to user-friendly errors. */
function mapDriveError(status: number, statusText: string): Error {
  switch (status) {
    case 403:
      return Object.assign(new Error('Anda tidak memiliki akses ke dokumen ini'), {
        code: 'GOOGLE_DRIVE_ACCESS_DENIED',
        statusCode: 403,
      });
    case 404:
      return Object.assign(new Error('Dokumen tidak ditemukan atau sudah dihapus'), {
        code: 'GOOGLE_DRIVE_NOT_FOUND',
        statusCode: 404,
      });
    case 429:
      return Object.assign(new Error('Terlalu banyak permintaan, coba lagi dalam 1 menit'), {
        code: 'GOOGLE_DRIVE_RATE_LIMITED',
        statusCode: 429,
      });
    default:
      return Object.assign(new Error(`Google Drive API error: ${statusText}`), {
        code: 'GOOGLE_DRIVE_ERROR',
        statusCode: status,
      });
  }
}
