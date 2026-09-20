/**
 * On macOS Ventura and later, `message.text` is frequently NULL and the body
 * lives in `attributedBody`, an NSAttributedString serialised in Apple's
 * legacy "typedstream" format. Full typedstream parsing is overkill for
 * read-only text extraction, so this pulls out the first NSString payload:
 *
 *   ... "NSString" | "NSMutableString" ... 0x2B ('+', UTF-8 string tag) <len> <bytes>
 *
 * <len> is a typedstream integer: one byte if < 0x80, 0x81 + int16 LE,
 * or 0x82 + int32 LE.
 */
const MARKERS = [Buffer.from("NSMutableString"), Buffer.from("NSString")];

export function decodeAttributedBody(blob: Uint8Array | null | undefined): string | null {
  if (!blob || blob.length === 0) return null;
  const buf = Buffer.isBuffer(blob) ? blob : Buffer.from(blob.buffer, blob.byteOffset, blob.byteLength);

  let start = -1;
  for (const m of MARKERS) {
    const i = buf.indexOf(m);
    if (i !== -1 && (start === -1 || i < start)) start = i + m.length;
  }
  if (start === -1) return null;

  // The '+' tag sits a few bytes after the class name.
  const plus = buf.indexOf(0x2b, start);
  if (plus === -1 || plus - start > 16) return null;

  let p = plus + 1;
  if (p >= buf.length) return null;
  let len: number;
  const first = buf[p]!;
  if (first === 0x81) {
    if (p + 3 > buf.length) return null;
    len = buf.readUInt16LE(p + 1);
    p += 3;
  } else if (first === 0x82) {
    if (p + 5 > buf.length) return null;
    len = buf.readUInt32LE(p + 1);
    p += 5;
  } else {
    len = first;
    p += 1;
  }
  if (len <= 0 || p + len > buf.length) return null;
  // U+FFFC is the placeholder Messages inserts where an attachment sits.
  const text = buf.subarray(p, p + len).toString("utf8").replace(/\uFFFC/g, "").trim();
  return text.length ? text : null;
}

/** Test helper: builds a minimal blob shaped like the real thing. */
export function encodeAttributedBodyForTest(text: string, mutable = true): Buffer {
  const body = Buffer.from(text, "utf8");
  let len: Buffer;
  if (body.length < 0x80) len = Buffer.from([body.length]);
  else if (body.length <= 0xffff) { len = Buffer.alloc(3); len[0] = 0x81; len.writeUInt16LE(body.length, 1); }
  else { len = Buffer.alloc(5); len[0] = 0x82; len.writeUInt32LE(body.length, 1); }
  return Buffer.concat([
    Buffer.from([0x04, 0x0b]), Buffer.from("streamtyped"), Buffer.from([0x81, 0xe8, 0x03, 0x84, 0x01, 0x40, 0x84, 0x84, 0x84, 0x12]),
    Buffer.from(mutable ? "NSMutableAttributedString" : "NSAttributedString"), Buffer.from([0x00, 0x84, 0x84, 0x08]),
    Buffer.from("NSObject"), Buffer.from([0x00, 0x85, 0x92, 0x84, 0x84, 0x84, 0x0f]),
    Buffer.from(mutable ? "NSMutableString" : "NSString"), Buffer.from([0x01, 0x94, 0x84, 0x01, 0x2b]),
    len, body, Buffer.from([0x86, 0x84, 0x02, 0x69, 0x49, 0x01]),
  ]);
}
