import { NextRequest, NextResponse } from 'next/server';
import { getServiceClient } from '@/lib/supabase';

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

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const locale = (formData.get('locale') as string) || 'en';

    // Support both single 'file' and multiple 'files' fields
    let files = formData.getAll('files') as File[];
    if (files.length === 0) {
      const singleFile = formData.get('file') as File;
      if (singleFile) files = [singleFile];
    }

    if (files.length === 0) {
      return NextResponse.json({ error: 'No files provided' }, { status: 400 });
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
    for (const file of files) {
      if (!SUPPORTED_MIME_TYPES.has(file.type)) {
        console.warn(`Skipping unsupported file type: ${file.type} (${file.name})`);
        continue;
      }

      const fileBuffer = await file.arrayBuffer();
      const fileBytes = new Uint8Array(fileBuffer);
      const storageFileName = `${Date.now()}-${file.name}`;

      const { error: storageError } = await supabase.storage
        .from('product-files')
        .upload(storageFileName, fileBytes, {
          contentType: file.type,
          upsert: false,
        });

      if (storageError) {
        console.error(`Storage error for ${file.name}:`, storageError);
        continue;
      }

      const { data: urlData } = supabase.storage
        .from('product-files')
        .getPublicUrl(storageFileName);

      uploadedFiles.push({
        fileName: file.name,
        storageFileName,
        publicUrl: urlData.publicUrl,
        mimeType: file.type,
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
      })
      .select()
      .single();

    if (productError) {
      console.error('Product insert error:', productError);
      return NextResponse.json({ error: 'Failed to create product record' }, { status: 500 });
    }

    // Insert product_files records
    const fileRecords = uploadedFiles.map((f, i) => ({
      product_id: product.id,
      file_url: f.publicUrl,
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

    // Trigger async analysis with primary file
    const base64 = Buffer.from(primary.fileBytes).toString('base64');
    const baseUrl = request.nextUrl.origin;
    fetch(`${baseUrl}/api/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        productId: product.id,
        fileBase64: base64,
        mimeType: primary.mimeType,
        fileName: primary.fileName,
        locale,
      }),
    }).catch(console.error);

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
