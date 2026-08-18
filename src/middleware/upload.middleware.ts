import multer from 'multer';
import { Request, Response, NextFunction } from 'express';
import { ErrorResponse } from '../types/error.types.js';

/**
 * Allowed MIME types for file uploads.
 * PDF, DOCX (documents) and PNG, JPEG, WEBP (images).
 *
 * @see Requirements 1.1, 1.3
 */
export const ALLOWED_MIME_TYPES = [
  // Documents
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  // Images
  'image/png',
  'image/jpeg',
  'image/webp',
  // Structured text
  'text/html',
  'text/markdown',
  'application/json',
  'text/csv',
  'text/plain',
  'application/xml',
  'text/xml',
] as const;

/** Maximum file size: 15 MB per file. @see Requirement 1.4 */
export const MAX_FILE_SIZE = 15 * 1024 * 1024; // 15 MB

/** Maximum number of files per request. @see Requirement 1.6 */
export const MAX_FILE_COUNT = 5;

/**
 * Multer instance configured with memory storage (no disk writes),
 * file size limit, file count limit, and MIME type filtering.
 *
 * @see Requirements 1.1, 1.3, 1.4, 1.5, 1.6
 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_FILE_SIZE,
    files: MAX_FILE_COUNT,
  },
  fileFilter: (_req, file, cb) => {
    if ((ALLOWED_MIME_TYPES as readonly string[]).includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`Unsupported file type: ${file.mimetype}. Allowed: PDF, DOCX, PNG, JPEG, WEBP`));
    }
  },
});

/**
 * Express middleware that accepts up to MAX_FILE_COUNT files
 * under the 'files' field name from multipart/form-data requests.
 */
export const uploadMiddleware = upload.array('files', MAX_FILE_COUNT);

/**
 * Express middleware that accepts a single file under the 'file' field.
 * Used by the knowledge upload endpoint (POST /api/v1/knowledge/documents).
 */
export const knowledgeUploadMiddleware = upload.single('file');

/**
 * Express error-handling middleware that converts multer-specific errors
 * into standard API error responses with appropriate HTTP status codes.
 *
 * @see Requirements 1.4, 1.6
 */
export const multerErrorHandler = (
  err: Error,
  _req: Request,
  res: Response,
  next: NextFunction
): void => {
  if (err instanceof multer.MulterError) {
    let errorResponse: ErrorResponse;

    switch (err.code) {
      case 'LIMIT_FILE_SIZE':
        errorResponse = {
          error: 'FILE_TOO_LARGE',
          message: 'File exceeds the 10 MB size limit',
        };
        break;
      case 'LIMIT_FILE_COUNT':
        errorResponse = {
          error: 'TOO_MANY_FILES',
          message: 'Maximum 5 file attachments per request',
        };
        break;
      case 'LIMIT_UNEXPECTED_FILE':
        errorResponse = {
          error: 'UNEXPECTED_FILE',
          message: 'Unexpected file field',
        };
        break;
      default:
        errorResponse = {
          error: 'UPLOAD_ERROR',
          message: err.message,
        };
        break;
    }

    res.status(400).json(errorResponse);
    return;
  }

  // Non-multer errors from fileFilter rejection
  if (err.message && err.message.includes('Unsupported file type')) {
    const errorResponse: ErrorResponse = {
      error: 'UNSUPPORTED_FILE_TYPE',
      message: err.message,
    };
    res.status(400).json(errorResponse);
    return;
  }

  // Pass unrelated errors to the next error handler
  next(err);
};
