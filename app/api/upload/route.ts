import { requireUser } from "@/lib/auth/require-user";
import { NextRequest, NextResponse, after } from 'next/server';
import { getServiceClient } from '@/lib/supabase';
import { checkAnalyzeRateLimit } from "@/lib/research/analyze-rate-limit";
import { checkMagicBytes } from "@/lib/upload/magic-bytes";
import { buildAnalyzeTriggerHeaders } from "@/lib/research/analyze-trigger-headers";

const SUPPORTED_MIME_TYPES = new Set([
  'application/pdf',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
]);

const MAX_SINGLE_FILE_BYTES = 15 * 1024 * 1024;
const MAX_TOTAL_UPLOAD_BYTES = 20 * 1024 * 1024;

// Fallback: infer MIME type from file extension when browser/curl doesn't set it
const EXT_TO_MIME: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

function resolveMimeType(file: File): string | null {
  if (file.type && SUPPORTED_MIME_TYPES.has(file.type)) return file.type;
  const ext = file.name.match(/\.[^.]+$/)?.[0]?.toLowerCase();
  if (ext && EXT_TO_MIME[ext]) return EXT_TO_MIME[ext];
  return null;
}

export async function POST(request: NextRequest) {
	// auth: requireUser
	const auth = await requireUser(["member", "admin"]);
	if ("error" in auth) return auth.error;

	const rateCheck = await checkAnalyzeRateLimit(auth.sb, auth.user.id, auth.role as "member" | "admin");
	if (rateCheck.kind !== "ok") {
		console.warn(`[upload] rate limit ${rateCheck.kind} for user=${auth.user.id}: ${rateCheck.current}/${rateCheck.max}`);
		const msg = rateCheck.kind === "inflight_exceeded"
			? `現在分析中の商品が ${rateCheck.current} 件あります (上限 ${rateCheck.max} 件)。完了後に再度お試しください。`
			: `本日のアップロード上限 (${rateCheck.max} 件/24h) に達しました。明日以降お試しください。`;
		return NextResponse.json({ error: msg, code: rateCheck.kind }, { status: 429 });
	}

  try {
    const formData = await request.formData();
    const locale = (formData.get('locale') as string) || 'ja';

    // Support both single 'file' and multiple 'files' fields
    let files = formData.getAll('files') as File[];
    if (files.length === 0) {
      const singleFile = formData.get('file') as File;
      if (singleFile) files = [singleFile];
    }

    if (files.length === 0) {
      return NextResponse.json({ error: 'No files provided' }, { status: 400 });
    }

    const acceptedFiles: Array<{ file: File; mimeType: string }> = [];
    for (const file of files) {
      const mimeType = resolveMimeType(file);
      if (!mimeType) {
        console.warn(`Skipping unsupported file: ${file.name} (type: ${file.type})`);
        continue;
      }
      if (file.size > MAX_SINGLE_FILE_BYTES) {
        return NextResponse.json(
          { error: `file '${file.name}' exceeds 15MB` },
          { status: 400 },
        );
      }
      acceptedFiles.push({ file, mimeType });
    }

    if (acceptedFiles.length === 0) {
      return NextResponse.json({ error: 'No supported files provided' }, { status: 400 });
    }

    const totalUploadBytes = acceptedFiles.reduce((sum, item) => sum + item.file.size, 0);
    if (totalUploadBytes > MAX_TOTAL_UPLOAD_BYTES) {
      return NextResponse.json(
        { error: 'Total upload payload exceeds 20MB' },
        { status: 400 },
      );
    }

    const cronSecret = process.env.CRON_SECRET;
    if (!cronSecret) {
      console.error('[upload] CRON_SECRET not configured — refusing to create unanalyzable product');
      return NextResponse.json({ error: 'CRON_SECRET not configured' }, { status: 500 });
    }

    const supabase = getServiceClient();
    const uploadedFiles: Array<{
      fileName: string;
      storageFileName: string;
      publicUrl: string;
      mimeType: string;
      fileBytes: Uint8Array;
    }> = [];

    // Upload all files to Supabase Storage
    for (const { file, mimeType } of acceptedFiles) {
      const fileBuffer = await file.arrayBuffer();
      const fileBytes = new Uint8Array(fileBuffer);
      const headBuffer = Buffer.from(fileBytes.slice(0, 16));
      const magic = checkMagicBytes(headBuffer, mimeType);
      if (magic.kind === "unsupported") {
        console.warn(`[upload] rejected ${file.name}: unsupported magic bytes (declared ${mimeType})`);
        return NextResponse.json(
          { error: `Unsupported file content: ${file.name}` },
          { status: 400 },
        );
      }
      if (magic.kind === "mismatch") {
        console.warn(`[upload] rejected ${file.name}: declared ${mimeType} but bytes look like ${magic.detectedMime}`);
        return NextResponse.json(
          { error: `File content does not match declared type for ${file.name}` },
          { status: 400 },
        );
      }
      const ext = file.name.match(/\.[^.]+$/)?.[0] ?? '';
      const safeName = file.name
        .replace(/\.[^.]+$/, '')
        .replace(/[^a-zA-Z0-9_-]/g, '_')
        .slice(0, 80);
      const storageFileName = `${Date.now()}-${safeName}${ext}`;

      const { error: storageError } = await supabase.storage
        .from('product-files')
        .upload(storageFileName, fileBytes, {
          contentType: mimeType,
          upsert: false,
        });

      if (storageError) {
        console.error(`Storage error for ${file.name}:`, storageError);
        continue;
      }

      // Phase 4: bucket is private — no public URL. Store path only.
      uploadedFiles.push({
        fileName: file.name,
        storageFileName,
        publicUrl: storageFileName,
        mimeType,
        fileBytes,
      });
    }

    if (uploadedFiles.length === 0) {
      return NextResponse.json({ error: 'No files could be uploaded' }, { status: 400 });
    }

    // Use the product name from form data, or derive from first file name
    const productName =
      (formData.get('productName') as string) ||
      uploadedFiles[0].fileName.replace(/\.[^/.]+$/, '');

    // Create product record (use first file as primary)
    const primary = uploadedFiles[0];
    const { data: product, error: productError } = await supabase
      .from('products')
      .insert({
        name: productName,
        description: null,
        file_url: primary.publicUrl,
        file_name: primary.storageFileName,
        status: 'pending',
        created_by: auth.user.id,
      })
      .select()
      .single();

    if (productError) {
      console.error('Product insert error:', productError);
      return NextResponse.json({ error: 'Failed to create product record' }, { status: 500 });
    }

    // Insert product_files records
    // Phase 4: f.publicUrl actually holds the storage path now (private bucket).
    const fileRecords = uploadedFiles.map((f, i) => ({
      product_id: product.id,
      file_url: f.storageFileName,
      file_name: f.storageFileName,
      mime_type: f.mimeType,
      is_primary: i === 0,
    }));

    const { error: filesError } = await supabase
      .from('product_files')
      .insert(fileRecords);

    if (filesError) {
      console.error('product_files insert error:', filesError);
      // Non-fatal — product was already created
    }

    // Trigger async analysis with all uploaded files
    const baseUrl = request.nextUrl.origin;
    const filesBody = uploadedFiles.map((f) => ({
      base64: Buffer.from(f.fileBytes).toString('base64'),
      mimeType: f.mimeType,
      fileName: f.fileName,
    }));

    // Dispatch the analyze trigger inside after() so the request is guaranteed to be
    // sent — and its failure-recording runs — after the response returns. A bare
    // fire-and-forget fetch can be dropped when the serverless function suspends,
    // leaving the trigger unsent. Mirrors app/api/discovery/enrich/[productId]/route.ts.
    after(() =>
      fetch(`${baseUrl}/api/analyze`, {
        method: 'POST',
        headers: buildAnalyzeTriggerHeaders(cronSecret),
        body: JSON.stringify({
          productId: product.id,
          files: filesBody,
          locale,
        }),
      })
        .then(async (res) => {
          if (res.status === 401 || res.status === 403 || res.status === 404) {
            await supabase
              .from('products')
              .update({ status: 'failed', error_reason: `analyze_trigger_http_${res.status}` })
              .eq('id', product.id);
          }
        })
        .catch(async (err) => {
          console.error('[upload] analyze trigger failed:', err);
          await supabase
            .from('products')
            .update({ status: 'failed', error_reason: 'analyze_trigger_failed' })
            .eq('id', product.id);
        }),
    );

    return NextResponse.json({
      success: true,
      product,
      filesUploaded: uploadedFiles.length,
      message: `${uploadedFiles.length} file(s) uploaded. Analysis started.`,
    });
  } catch (error) {
    console.error('Upload error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
