import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchDocument, fetchFolder } from '../../src/services/google-drive.service.js';

function mockFetchResponse(status: number, body: any) {
  return new Response(JSON.stringify(body), {
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    headers: { 'content-type': 'application/json' },
  });
}

function mockFetchText(status: number, text: string) {
  return new Response(text, {
    status,
    statusText: status === 200 ? 'OK' : 'Error',
  });
}

describe('fetchDocument', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fetches and exports a Google Document as text', async () => {
    // Metadata response
    fetchMock.mockResolvedValueOnce(
      mockFetchResponse(200, { id: 'doc1', name: 'Laporan', mimeType: 'application/vnd.google-apps.document' })
    );
    // Export response
    fetchMock.mockResolvedValueOnce(
      mockFetchText(200, 'Ini isi dokumen')
    );

    const result = await fetchDocument('doc1', 'token123');
    expect(result.title).toBe('Laporan');
    expect(result.text).toBe('Ini isi dokumen');
    expect(result.mimeType).toBe('application/vnd.google-apps.document');

    // First call: metadata fetch
    expect(fetchMock.mock.calls[0][0]).toContain('/drive/v3/files/doc1?fields=id,name,mimeType,size');
    // Second call: export
    expect(fetchMock.mock.calls[1][0]).toContain('/export?mimeType=text%2Fplain');
  });

  it('fetches and exports a Spreadsheet as CSV', async () => {
    fetchMock.mockResolvedValueOnce(
      mockFetchResponse(200, { id: 's1', name: 'Data', mimeType: 'application/vnd.google-apps.spreadsheet' })
    );
    fetchMock.mockResolvedValueOnce(
      mockFetchText(200, 'col1,col2\nv1,v2')
    );

    const result = await fetchDocument('s1', 'token123');
    expect(result.title).toBe('Data');
    expect(result.text).toBe('col1,col2\nv1,v2');
  });

  it('fetches and exports a Presentation as text', async () => {
    fetchMock.mockResolvedValueOnce(
      mockFetchResponse(200, { id: 'p1', name: 'Deck', mimeType: 'application/vnd.google-apps.presentation' })
    );
    fetchMock.mockResolvedValueOnce(
      mockFetchText(200, 'Slide 1 content')
    );

    const result = await fetchDocument('p1', 'token123');
    expect(result.title).toBe('Deck');
    expect(result.text).toBe('Slide 1 content');
  });

  it('downloads binary files and routes through document extractor', async () => {
    // text/plain is a registered extractor path with no magic-byte gate — deterministic.
    const textBuffer = Buffer.from('hello drive');
    fetchMock.mockResolvedValueOnce(
      mockFetchResponse(200, { id: 'f1', name: 'notes.txt', mimeType: 'text/plain', size: String(textBuffer.length) })
    );
    fetchMock.mockResolvedValueOnce(
      new Response(textBuffer, { status: 200, statusText: 'OK' })
    );

    const result = await fetchDocument('f1', 'token123');
    expect(result.title).toBe('notes.txt');
    expect(result.mimeType).toBe('text/plain');
    expect(result.sizeBytes).toBe(textBuffer.length);
    expect(result.text).toBe('hello drive');
  });

  it('degrades gracefully to empty text when binary extraction fails', async () => {
    // Fake PDF passes the magic-byte gate but pdf-parse cannot parse it.
    fetchMock.mockResolvedValueOnce(
      mockFetchResponse(200, { id: 'f1', name: 'broken.pdf', mimeType: 'application/pdf', size: '100' })
    );
    fetchMock.mockResolvedValueOnce(
      new Response(Buffer.from('%PDF-1.4 not really a pdf'), { status: 200, statusText: 'OK' })
    );

    const result = await fetchDocument('f1', 'token123');
    expect(result.title).toBe('broken.pdf');
    expect(result.mimeType).toBe('application/pdf');
    expect(result.text).toBe('');
  });

  it('rejects files larger than 10MB with GOOGLE_DRIVE_TOO_LARGE', async () => {
    const big = String(11 * 1024 * 1024);
    fetchMock.mockResolvedValueOnce(
      mockFetchResponse(200, { id: 'f1', name: 'big.pdf', mimeType: 'application/pdf', size: big })
    );

    await expect(fetchDocument('f1', 'token')).rejects.toMatchObject({
      code: 'GOOGLE_DRIVE_TOO_LARGE',
      statusCode: 413,
    });
    // Download must never be attempted for oversized files
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('throws 403 access denied error', async () => {
    fetchMock.mockResolvedValueOnce(
      mockFetchResponse(403, { error: 'insufficient permissions' })
    );

    await expect(fetchDocument('doc1', 'token')).rejects.toMatchObject({
      code: 'GOOGLE_DRIVE_ACCESS_DENIED',
      statusCode: 403,
    });
  });

  it('throws 404 not found error', async () => {
    fetchMock.mockResolvedValueOnce(
      mockFetchResponse(404, { error: 'not found' })
    );

    await expect(fetchDocument('doc1', 'token')).rejects.toMatchObject({
      code: 'GOOGLE_DRIVE_NOT_FOUND',
      statusCode: 404,
    });
  });

  it('throws 429 rate limit error', async () => {
    fetchMock.mockResolvedValueOnce(
      mockFetchResponse(429, { error: 'rate limit' })
    );

    await expect(fetchDocument('doc1', 'token')).rejects.toMatchObject({
      code: 'GOOGLE_DRIVE_RATE_LIMITED',
      statusCode: 429,
    });
  });

  it('sends authorization header', async () => {
    fetchMock.mockResolvedValueOnce(
      mockFetchResponse(200, { id: 'd1', name: 'Doc', mimeType: 'application/vnd.google-apps.document' })
    );
    fetchMock.mockResolvedValueOnce(mockFetchText(200, 'test'));

    await fetchDocument('d1', 'my-token');
    expect(fetchMock.mock.calls[0][1]?.headers?.['Authorization']).toBe('Bearer my-token');
  });
});

describe('fetchFolder', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  /** Route mocked requests by URL shape (folder meta / listing / file meta / media). */
  function route(handlers: {
    folderName?: string;
    list?: () => { files: { id: string; name: string; mimeType: string }[]; nextPageToken?: string };
    fileMime?: (id: string) => string;
    media?: (id: string) => string;
  }) {
    return async (url: string) => {
      if (url.includes('?fields=id,name') && !url.includes('mimeType')) {
        return mockFetchResponse(200, { id: 'folder1', name: handlers.folderName ?? 'Folder SOP' });
      }
      if (url.includes('/files?q=')) {
        return mockFetchResponse(200, handlers.list ? handlers.list() : { files: [] });
      }
      const meta = url.match(/\/files\/([^?]+)\?fields=id,name,mimeType,size/);
      if (meta) {
        const id = decodeURIComponent(meta[1]);
        const mimeType = handlers.fileMime ? handlers.fileMime(id) : 'text/plain';
        return mockFetchResponse(200, { id, name: `${id}.txt`, mimeType });
      }
      if (url.includes('alt=media')) {
        const id = url.match(/\/files\/([^?]+)\?/)?.[1] ?? '';
        return mockFetchText(200, handlers.media ? handlers.media(decodeURIComponent(id)) : `isi ${id}`);
      }
      return mockFetchResponse(404, { error: 'unexpected' });
    };
  }

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('joins every readable file under a numbered header', async () => {
    fetchMock.mockImplementation(route({
      folderName: 'SOP Bank',
      list: () => ({ files: [
        { id: 'f1', name: 'a', mimeType: 'text/plain' },
        { id: 'f2', name: 'b', mimeType: 'text/plain' },
      ] }),
    }));

    const result = await fetchFolder('folder1', 'token');
    expect(result.title).toBe('SOP Bank');
    expect(result.fileCount).toBe(2);
    expect(result.mimeType).toBe('application/vnd.google-apps.folder');
    expect(result.text).toContain('===== 1. f1.txt =====');
    expect(result.text).toContain('===== 2. f2.txt =====');
    expect(result.text).toContain('isi f1');
    expect(result.text).toContain('isi f2');
  });

  it('descends one nested level but no deeper', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('?fields=id,name') && !url.includes('mimeType')) return mockFetchResponse(200, { id: 'folder1', name: 'Root' });
      if (url.includes('/files?q=')) {
        const q = decodeURIComponent(url.match(/q=([^&]*)/)![1]).replace(/\+/g, ' ');
        const parent = q.match(/'([^']+)' in parents/)![1];
        if (parent === 'folder1') return mockFetchResponse(200, { files: [{ id: 'sub', name: 'Sub', mimeType: 'application/vnd.google-apps.folder' }] });
        if (parent === 'sub') return mockFetchResponse(200, { files: [
          { id: 'deep', name: 'Deep', mimeType: 'application/vnd.google-apps.folder' },
          { id: 'leaf', name: 'Leaf', mimeType: 'text/plain' },
        ] });
        throw new Error(`unexpected listing for ${parent}`);
      }
      const meta = url.match(/\/files\/([^?]+)\?fields=id,name,mimeType,size/);
      if (meta) return mockFetchResponse(200, { id: meta[1], name: 'leaf.txt', mimeType: 'text/plain' });
      if (url.includes('alt=media')) return mockFetchText(200, 'isi leaf');
      return mockFetchResponse(404, {});
    });

    const result = await fetchFolder('folder1', 'token');
    expect(result.fileCount).toBe(1);
    expect(result.text).toContain('isi leaf');
  });

  it('caps the crawl at 20 files', async () => {
    const many = Array.from({ length: 25 }, (_, i) => ({ id: `f${i + 1}`, name: `f${i + 1}`, mimeType: 'text/plain' }));
    fetchMock.mockImplementation(route({ list: () => ({ files: many }) }));

    const result = await fetchFolder('folder1', 'token');
    expect(result.fileCount).toBe(20);
    const downloads = fetchMock.mock.calls.filter((c) => String(c[0]).includes('alt=media'));
    expect(downloads).toHaveLength(20);
  });

  it('reports an empty folder instead of returning nothing', async () => {
    fetchMock.mockImplementation(route({ list: () => ({ files: [] }) }));

    const result = await fetchFolder('folder1', 'token');
    expect(result.fileCount).toBe(0);
    expect(result.text).toBe('Folder kosong atau tidak ada dokumen yang bisa dibaca.');
  });

  it('maps a missing folder to GOOGLE_DRIVE_NOT_FOUND', async () => {
    fetchMock.mockResolvedValueOnce(mockFetchResponse(404, { error: 'not found' }));

    await expect(fetchFolder('gone', 'token')).rejects.toMatchObject({
      code: 'GOOGLE_DRIVE_NOT_FOUND',
      statusCode: 404,
    });
  });
});
