import { badRequest } from './errors.js';

/**
 * Server-side validation for customer-uploaded images (payment receipts and
 * the payment QR code).
 *
 * The client sends a data URL rather than a multipart file, so the endpoint
 * stays JSON-only and the existing body-size limit applies unchanged. That
 * choice is what makes this module necessary: a client fully controls the
 * string it sends, so the declared MIME type, the base64 payload, and the
 * size of the decoded image are all attacker-controlled until verified here.
 *
 * The checks are, in order:
 *
 *  1. Shape   — it must be a `data:` URL of an image type we accept.
 *  2. Size    — the DECODED bytes must fit the configured cap. The data URL's
 *               own length is already bounded by the schema, but that bounds
 *               the base64 text, not the image, so the real number is measured
 *               after decoding.
 *  3. Content — the decoded bytes must begin with the magic number of the type
 *               they claim to be.
 *
 * (3) is the one that carries the weight. Without it, "type: image/png" is
 * just a string the client chose, and a customer could submit an HTML or SVG
 * payload that the admin's browser later renders as part of reviewing the
 * payment. Magic numbers cannot be forged without actually producing a file of
 * that type, and restricting the allowlist to PNG/JPEG/WebP excludes SVG
 * entirely — the one image format that can carry script.
 */

export interface DecodedImage {
  bytes: Buffer;
  mime: 'image/png' | 'image/jpeg' | 'image/webp';
  /** The data URL to persist alongside the row. */
  dataUrl: string;
}

/**
 * The formats we accept, each with the byte sequence that identifies it.
 *
 * PNG and JPEG are what a phone screenshot actually is. WebP is included
 * because some Android screenshots arrive as it. SVG is deliberately absent:
 * it is XML that can carry script, and rendering one from untrusted customer
 * input in the admin's session is a stored-XSS vector with no legitimate need.
 */
const MAGIC: { mime: DecodedImage['mime']; bytes: number[]; offset: number }[] = [
  // 89 50 4E 47 0D 0A 1A 0A
  { mime: 'image/png', bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], offset: 0 },
  // FF D8 FF — the third byte is not fixed; JPEG markers vary.
  { mime: 'image/jpeg', bytes: [0xff, 0xd8, 0xff], offset: 0 },
  // "RIFF" .... "WEBP"
  { mime: 'image/webp', bytes: [0x52, 0x49, 0x46, 0x46], offset: 0 },
];

/** The declared type, for error messages, and the format its magic number implies. */
function matchMagic(buf: Buffer): DecodedImage['mime'] | null {
  for (const sig of MAGIC) {
    // WebP is a container: the "WEBP" fourcc sits at a fixed offset of 8,
    // after the 4-byte size field, so it is checked separately below.
    if (sig.mime === 'image/webp') {
      if (
        buf.length >= 12 &&
        buf.subarray(0, 4).equals(Buffer.from(sig.bytes)) &&
        buf.subarray(8, 12).toString('ascii') === 'WEBP'
      ) {
        return 'image/webp';
      }
      continue;
    }
    const slice = buf.subarray(sig.offset, sig.offset + sig.bytes.length);
    if (slice.length === sig.bytes.length && slice.equals(Buffer.from(sig.bytes))) {
      return sig.mime;
    }
  }
  return null;
}

/**
 * Parses, decodes and verifies a data URL.
 *
 * `maxBytes` is applied to the decoded image, which is the number that actually
 * matters. Throws a 400 `invalid_request` with a `param` naming the offending
 * field, so a customer pasting a screenshot gets a message about their
 * screenshot rather than a generic failure.
 */
export function decodeImageDataUrl(value: string, maxBytes: number, param: string): DecodedImage {
  const match = /^data:([a-z0-9.+-]+\/[a-z0-9.+-]+)(;[^,]*)?,(.*)$/is.exec(value.trim());
  if (!match) {
    throw badRequest('Upload must be a data URL', 'invalid_upload', param);
  }

  const declared = (match[1] ?? '').toLowerCase();
  const isBase64 = (match[2] ?? '').toLowerCase().includes(';base64');
  if (!isBase64) {
    throw badRequest('Upload must be base64 encoded', 'invalid_upload', param);
  }

  if (!['image/png', 'image/jpeg', 'image/webp', 'image/jpg'].includes(declared)) {
    throw badRequest('Upload must be a PNG, JPEG or WebP image', 'invalid_upload', param);
  }

  const payload = (match[3] ?? '').replace(/\s/g, '');
  let bytes: Buffer;
  try {
    bytes = Buffer.from(payload, 'base64');
  } catch {
    throw badRequest('Upload is not valid base64', 'invalid_upload', param);
  }

  if (bytes.byteLength === 0) {
    throw badRequest('Upload is empty', 'invalid_upload', param);
  }

  // Measured after decoding on purpose: a client controls the length of the
  // text it sends, so bounding the text bounds nothing.
  if (bytes.byteLength > maxBytes) {
    throw badRequest(
      `Upload is larger than the ${Math.floor(maxBytes / 1024 / 1024)}MB limit`,
      'upload_too_large',
      param,
    );
  }

  // The declared type is not trusted. The bytes decide what this is.
  const actual = matchMagic(bytes);
  if (!actual) {
    throw badRequest('Upload is not a valid PNG, JPEG or WebP image', 'invalid_upload', param);
  }
  // A client declaring one image type while sending another is not an
  // accident worth accepting silently: it means either a broken uploader or
  // a client probing what this endpoint will store.
  if (actual !== (declared === 'image/jpg' ? 'image/jpeg' : declared)) {
    throw badRequest('Upload content does not match its declared type', 'invalid_upload', param);
  }

  return { bytes, mime: actual, dataUrl: value.trim() };
}

/**
 * Re-decodes a stored data URL for outbound use (Telegram forwarding).
 *
 * The bytes were verified on the way IN, so this trusts the stored column and
 * only re-derives what forwarding needs. A row that somehow fails here yields
 * null rather than throwing, because it must not be able to break a retry.
 */
export function readStoredImage(dataUrl: string | null, mime: string | null): {
  bytes: Buffer;
  mime: string;
} | null {
  if (!dataUrl) return null;
  const match = /^data:([a-z0-9.+-]+\/[a-z0-9.+-]+)(;[^,]*)?,(.*)$/is.exec(dataUrl.trim());
  if (!match || !(match[2] ?? '').toLowerCase().includes(';base64')) return null;
  const resolvedMime = matchMime(mime) ?? match[1]!.toLowerCase();
  if (!resolvedMime.startsWith('image/')) return null;
  try {
    const bytes = Buffer.from((match[3] ?? '').replace(/\s/g, ''), 'base64');
    if (bytes.byteLength === 0) return null;
    return { bytes, mime: resolvedMime };
  } catch {
    return null;
  }
}

function matchMime(mime: string | null): string | null {
  if (!mime) return null;
  const lower = mime.toLowerCase();
  if (lower === 'image/jpg') return 'image/jpeg';
  return ['image/png', 'image/jpeg', 'image/webp'].includes(lower) ? lower : null;
}
