import { config } from '../config/index.js';
import { extractDocumentText } from './document-extractor.service.js';

/** Max downloadable file size (bytes) — larger documents must be uploaded manually. */
const MAX_DRIVE_BYTES = 10 * 1024 * 1024;

/** Folder crawl limits: ≤20 files, ≤50MB total (≤10MB per file, enforced by fetchDocument). */
const MAX_FOLDER_FILES = 20;
const MAX_FOLDER_BYTES = 50 * 1024 * 1024;
/** folder → its files + one nested level (subfolders directly inside). */
const FOLDER_MAX_DEPTH = 1;
const FOLDER_FETCH_CONCURRENCY = 4;
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const DRIVE_API = 'https://www.googleapis.com/drive/v3/files';

export interface DriveFetchResult {
  title: string;
  text: string;
  mimeType: string;
  sizeBytes: number;
}

/** Folder crawl result — `title` is the folder name, `text` the concatenated documents. */
export interface DriveFolderResult extends DriveFetchResult {
  fileCount: number;
}

/** MIME type → export format mapping for Google-native formats. */
const EXPORT_MAP: Record<string, string> = {
  'application/vnd.google-apps.document': 'text/plain',
  'application/vnd.google-apps.spreadsheet': 'text/csv',
  'application/vnd.google-apps.presentation': 'text/plain',
};

/** Fresh timeout per request — a shared signal would abort the whole crawl on one slow call. */
function driveSignal(): AbortSignal {
  return AbortSignal.timeout(config.google.driveTimeoutMs);
}

interface DriveFileMeta {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
}

/** Escape a Drive id for use inside a `q` string literal. */
function qLiteral(id: string): string {
  return `'${id.replace(/'/g, "\\'")}'`;
}

/** List a folder's direct children (one page-loop; trashed items excluded). */
async function listChildren(
  parentId: string,
  headers: Record<string, string>,
): Promise<DriveFileMeta[]> {
  const out: DriveFileMeta[] = [];
  let pageToken: string | undefined;

  do {
    const params = new URLSearchParams({
      q: `${qLiteral(parentId)} in parents and trashed=false`,
      fields: 'nextPageToken,files(id,name,mimeType,size)',
      pageSize: '100',
      orderBy: 'name',
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true',
    });
    if (pageToken) params.set('pageToken', pageToken);

    const res = await fetch(`${DRIVE_API}?${params}`, { headers, signal: driveSignal() });
    if (!res.ok) throw mapDriveError(res.status, res.statusText);

    const body: { files?: DriveFileMeta[]; nextPageToken?: string } = await res.json();
    out.push(...(body.files ?? []));
    pageToken = body.nextPageToken;
  } while (pageToken);

  return out;
}

/**
 * Crawl a Drive folder into a single text blob: list children (depth- and count-capped),
 * fetch each readable file with {@link fetchDocument}, and join them under `===== n. name =====`
 * headers. Oversized/unsupported/unreadable files are skipped — a bad file never blocks the turn.
 */
export async function fetchFolder(
  folderId: string,
  accessToken: string,
): Promise<DriveFolderResult> {
  const headers: Record<string, string> = { Authorization: `Bearer ${accessToken}` };

  // Folder name (also proves the id exists and is readable).
  const metaRes = await fetch(`${DRIVE_API}/${encodeURIComponent(folderId)}?fields=id,name`, {
    headers,
    signal: driveSignal(),
  });
  if (!metaRes.ok) throw mapDriveError(metaRes.status, metaRes.statusText);
  const folderMeta: { name: string } = await metaRes.json();

  // Breadth-first collect, capped at MAX_FOLDER_FILES.
  const files: DriveFileMeta[] = [];
  let frontier: string[] = [folderId];

  for (let depth = 0; depth <= FOLDER_MAX_DEPTH && frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const parentId of frontier) {
      const children = await listChildren(parentId, headers);
      for (const child of children) {
        if (child.mimeType === FOLDER_MIME) {
          if (depth < FOLDER_MAX_DEPTH) next.push(child.id);
          continue;
        }
        files.push(child);
        if (files.length >= MAX_FOLDER_FILES) break;
      }
      if (files.length >= MAX_FOLDER_FILES) break;
    }
    frontier = next;
  }

  // Fetch in bounded batches; keep the ≤50MB total budget.
  const docs: DriveFetchResult[] = [];
  let totalBytes = 0;

  for (let i = 0; i < files.length; i += FOLDER_FETCH_CONCURRENCY) {
    const settled = await Promise.allSettled(
      files.slice(i, i + FOLDER_FETCH_CONCURRENCY).map((f) => fetchDocument(f.id, accessToken)),
    );

    for (const outcome of settled) {
      if (outcome.status === 'rejected') {
        console.warn(`[google-drive] Folder file skipped: ${(outcome.reason as Error).message}`);
        continue;
      }
      const doc = outcome.value;
      if (!doc.text) continue; // unsupported/corrupt → empty extraction
      if (totalBytes + doc.sizeBytes > MAX_FOLDER_BYTES) {
        console.warn('[google-drive] Folder total size cap (50MB) reached — remaining files skipped');
        totalBytes = MAX_FOLDER_BYTES;
        break;
      }
      totalBytes += doc.sizeBytes;
      docs.push(doc);
    }

    if (totalBytes >= MAX_FOLDER_BYTES) break;
  }

  const text =
    docs.length === 0
      ? 'Folder kosong atau tidak ada dokumen yang bisa dibaca.'
      : docs.map((d, i) => `===== ${i + 1}. ${d.title} =====\n${d.text}`).join('\n\n');

  return {
    title: folderMeta.name,
    text,
    mimeType: FOLDER_MIME,
    sizeBytes: totalBytes,
    fileCount: docs.length,
  };
}

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
