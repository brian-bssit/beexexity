import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchDocument } from '../../src/services/google-drive.service.js';

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
