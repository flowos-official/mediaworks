/**
 * 파일 시그니처 (magic bytes) 기반 MIME 검증.
 * 클라이언트 supplied Content-Type 또는 확장자가 아니라 실제 파일 머리 8 바이트로 판정.
 *
 * 반환값:
 *   - declaredMime 과 detected 가 일치 → 'match'
 *   - detected 가 supported 이지만 declaredMime 과 다름 → 'mismatch'
 *   - 어떤 known signature 와도 매치 안 됨 → 'unsupported'
 */

const SIGNATURES: Array<{ mime: string; magic: number[]; offset?: number }> = [
	{ mime: "application/pdf", magic: [0x25, 0x50, 0x44, 0x46] },                           // %PDF
	{ mime: "image/png",       magic: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },   // PNG
	{ mime: "image/jpeg",      magic: [0xff, 0xd8, 0xff] },                                  // JPEG
	{ mime: "image/gif",       magic: [0x47, 0x49, 0x46, 0x38] },                            // GIF8
	{ mime: "image/webp",      magic: [0x52, 0x49, 0x46, 0x46] },                            // RIFF (+ WEBP @+8)
	{ mime: "application/zip", magic: [0x50, 0x4b, 0x03, 0x04] },                            // ZIP (OOXML)
	{ mime: "application/x-cfb", magic: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1] }, // OLE2 (legacy Office)
];

const OOXML_MIMES = new Set([
	"application/vnd.openxmlformats-officedocument.presentationml.presentation",
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);

const LEGACY_OFFICE_MIMES = new Set([
	"application/vnd.ms-powerpoint",
	"application/msword",
	"application/vnd.ms-excel",
]);

export type MimeCheckResult =
	| { kind: "match"; detectedMime: string }
	| { kind: "mismatch"; detectedMime: string; declaredMime: string }
	| { kind: "unsupported"; declaredMime: string };

export function checkMagicBytes(bytes: Buffer, declaredMime: string): MimeCheckResult {
	if (bytes.length < 12) return { kind: "unsupported", declaredMime };

	for (const sig of SIGNATURES) {
		const offset = sig.offset ?? 0;
		const match = sig.magic.every((b, i) => bytes[offset + i] === b);
		if (!match) continue;

		// WEBP: also requires 'WEBP' at offset 8
		if (sig.mime === "image/webp") {
			const isWebp =
				bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50;
			if (!isWebp) continue;
		}

		// ZIP magic: only valid for OOXML declared types
		if (sig.mime === "application/zip") {
			if (OOXML_MIMES.has(declaredMime)) {
				return { kind: "match", detectedMime: declaredMime };
			}
			return { kind: "mismatch", detectedMime: "application/zip", declaredMime };
		}

		// OLE2 magic: only valid for legacy Office declared types
		if (sig.mime === "application/x-cfb") {
			if (LEGACY_OFFICE_MIMES.has(declaredMime)) {
				return { kind: "match", detectedMime: declaredMime };
			}
			return { kind: "mismatch", detectedMime: "application/x-cfb", declaredMime };
		}

		// Direct mime match for PDF / PNG / JPEG / GIF / WEBP
		if (declaredMime === sig.mime) {
			return { kind: "match", detectedMime: sig.mime };
		}
		return { kind: "mismatch", detectedMime: sig.mime, declaredMime };
	}

	return { kind: "unsupported", declaredMime };
}
