import { describe, it, expect } from 'vitest';
import { extractUrls, replaceUrlsWithPlaceholders } from '../../src/services/url-interceptor.service.js';

describe('extractUrls', () => {
  it('extracts docs.google.com/document/d/{id}', () => {
    const urls = extractUrls('lihat https://docs.google.com/document/d/abc123DEF456/edit');
    expect(urls).toHaveLength(1);
    expect(urls[0].fileId).toBe('abc123DEF456');
    expect(urls[0].type).toBe('document');
  });

  it('extracts docs.google.com/spreadsheets/d/{id}', () => {
    const urls = extractUrls('cek https://docs.google.com/spreadsheets/d/sheet1A2B3Cx');
    expect(urls).toHaveLength(1);
    expect(urls[0].fileId).toBe('sheet1A2B3Cx');
    expect(urls[0].type).toBe('spreadsheet');
  });

  it('extracts docs.google.com/presentation/d/{id}', () => {
    const urls = extractUrls('slide https://docs.google.com/presentation/d/deck_999_xyz_');
    expect(urls).toHaveLength(1);
    expect(urls[0].fileId).toBe('deck_999_xyz_');
    expect(urls[0].type).toBe('presentation');
  });

  it('extracts drive.google.com/file/d/{id}', () => {
    const urls = extractUrls('file https://drive.google.com/file/d/drive_abc123_long');
    expect(urls).toHaveLength(1);
    expect(urls[0].fileId).toBe('drive_abc123_long');
    expect(urls[0].type).toBe('drive');
  });

  it('extracts drive.google.com/drive/folders/{id}', () => {
    const urls = extractUrls('baca folder https://drive.google.com/drive/folders/1AbCdEfGhIjKl');
    expect(urls).toHaveLength(1);
    expect(urls[0].fileId).toBe('1AbCdEfGhIjKl');
    expect(urls[0].type).toBe('folder');
  });

  it('extracts folder URL with /drive/u/0/ segment and query params', () => {
    const urls = extractUrls('https://drive.google.com/drive/u/0/folders/1AbCdEfGhIjKl?usp=drive_link');
    expect(urls).toHaveLength(1);
    expect(urls[0].fileId).toBe('1AbCdEfGhIjKl');
    expect(urls[0].type).toBe('folder');
  });

  it('extracts multiple URLs from same prompt', () => {
    const urls = extractUrls(
      'doc1: https://docs.google.com/document/d/aaaaaaaaaaa doc2: https://docs.google.com/spreadsheets/d/bbbbbbbbbbb'
    );
    expect(urls).toHaveLength(2);
    expect(urls[0].fileId).toBe('aaaaaaaaaaa');
    expect(urls[1].fileId).toBe('bbbbbbbbbbb');
  });

  it('extracts URL with query params', () => {
    const urls = extractUrls('https://docs.google.com/document/d/abc123def456?usp=sharing&ouid=1');
    expect(urls).toHaveLength(1);
    expect(urls[0].fileId).toBe('abc123def456');
  });

  it('extracts URL with trailing slash', () => {
    const urls = extractUrls('https://docs.google.com/document/d/abc123def456/');
    expect(urls).toHaveLength(1);
    expect(urls[0].fileId).toBe('abc123def456');
  });

  it('extracts URL without protocol', () => {
    const urls = extractUrls('docs.google.com/document/d/abc123def456');
    expect(urls).toHaveLength(1);
    expect(urls[0].fileId).toBe('abc123def456');
  });

  it('returns empty array for non-GWS URLs', () => {
    const urls = extractUrls('https://example.com/file/d/abc123def456');
    expect(urls).toHaveLength(0);
  });

  it('returns empty array for plain text', () => {
    const urls = extractUrls('bagaimana cara kerja AI?');
    expect(urls).toHaveLength(0);
  });

  it('handles fileId with hyphens and underscores', () => {
    const urls = extractUrls('https://docs.google.com/document/d/1aB_-xY_99_abc');
    expect(urls).toHaveLength(1);
    expect(urls[0].fileId).toBe('1aB_-xY_99_abc');
  });

  it('does not match short fileIds (< 10 chars)', () => {
    const urls = extractUrls('https://docs.google.com/document/d/abc123');
    expect(urls).toHaveLength(0);
  });

  it('ignores URLs inside inline code (backticks)', () => {
    const urls = extractUrls('pakai `https://docs.google.com/document/d/aaaaaaaaaaa` sebagai contoh');
    expect(urls).toHaveLength(0);
  });

  it('ignores URLs inside fenced code blocks', () => {
    const urls = extractUrls(
      'contoh regex:\n```\nhttps://docs.google.com/spreadsheets/d/bbbbbbbbbbb\nhttps://drive.google.com/file/d/cccccccccc\n```\nlanjut'
    );
    expect(urls).toHaveLength(0);
  });

  it('ignores fenced block URL but detects real URL outside code', () => {
    const urls = extractUrls(
      'kode: ```\nhttps://docs.google.com/document/d/aaaaaaaaaaa\n```\nreview ini https://docs.google.com/document/d/ddddddddddd'
    );
    expect(urls).toHaveLength(1);
    expect(urls[0].fileId).toBe('ddddddddddd');
  });
});

describe('replaceUrlsWithPlaceholders', () => {
  it('replaces URL with [Google Document: title]', () => {
    const url = 'https://docs.google.com/document/d/abc123';
    const result = replaceUrlsWithPlaceholders(url, [
      { fileId: 'abc123', fullUrl: url, type: 'document' },
    ], 'Laporan Keuangan');
    expect(result).toBe('[Google Document: Laporan Keuangan]');
  });

  it('replaces URL with [Google Spreadsheet: title]', () => {
    const url = 'https://docs.google.com/spreadsheets/d/abc123';
    const result = replaceUrlsWithPlaceholders(url, [
      { fileId: 'abc123', fullUrl: url, type: 'spreadsheet' },
    ], 'Data Penjualan');
    expect(result).toBe('[Google Spreadsheet: Data Penjualan]');
  });

  it('replaces URL with [Google Presentation: title]', () => {
    const url = 'https://docs.google.com/presentation/d/abc123';
    const result = replaceUrlsWithPlaceholders(url, [
      { fileId: 'abc123', fullUrl: url, type: 'presentation' },
    ], 'Deck Q3');
    expect(result).toBe('[Google Presentation: Deck Q3]');
  });

  it('replaces URL with [File: title] for drive links', () => {
    const url = 'https://drive.google.com/file/d/abc123';
    const result = replaceUrlsWithPlaceholders(url, [
      { fileId: 'abc123', fullUrl: url, type: 'drive' },
    ], 'contract.pdf');
    expect(result).toBe('[File: contract.pdf]');
  });

  it('replaces multiple URLs', () => {
    const prompt = 'cek https://docs.google.com/document/d/a1 dan https://docs.google.com/spreadsheets/d/b2';
    const result = replaceUrlsWithPlaceholders(prompt, [
      { fileId: 'a1', fullUrl: 'https://docs.google.com/document/d/a1', type: 'document' },
      { fileId: 'b2', fullUrl: 'https://docs.google.com/spreadsheets/d/b2', type: 'spreadsheet' },
    ], 'Dokumen');
    expect(result).toBe('cek [Google Document: Dokumen] dan [Google Spreadsheet: Dokumen]');
  });

  it('preserves surrounding text', () => {
    const prompt = 'tolong review https://docs.google.com/document/d/abc123 dan kasih summary';
    const result = replaceUrlsWithPlaceholders(prompt, [
      { fileId: 'abc123', fullUrl: 'https://docs.google.com/document/d/abc123', type: 'document' },
    ], 'Review Doc');
    expect(result).toBe('tolong review [Google Document: Review Doc] dan kasih summary');
  });
  it('replaces URL with [Google Folder: title] for folder links', () => {
    const url = 'https://drive.google.com/drive/folders/abc123def4';
    const result = replaceUrlsWithPlaceholders(url, [
      { fileId: 'abc123def4', fullUrl: url, type: 'folder' },
    ], 'SOP Bank');
    expect(result).toBe('[Google Folder: SOP Bank]');
  });
});
