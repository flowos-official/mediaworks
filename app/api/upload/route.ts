import { NextRequest, NextResponse } from 'next/server';
import { getServiceClient } from '@/lib/supabase';

const SUPPORTED_MIME_TYPES: Record<string, string> = {
  'application/pdf': 'application/pdf',
  'application/vnd.ms-powerpoint': 'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/msword': 'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'image/jpeg': 'image/jpeg',
  'image/png': 'image/png',
  'image/gif': 'image/gif',
  'image/webp': 'image/webp',
};

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const file = formData.get('file') as File;
    // Accept locale from the form data; defaults to 'en'
    const locale = (formData.get('locale') as string) || 'en';

    if (!file) {
      return NextResponse.json({ error: 'No file provided' }, { status: 400 });
    }

    const mimeType = SUPPORTED_MIME_TYPES[file.type] || file.type;
    const supabase = getServiceClient();

    // Upload file to Supabase Storage
    const fileBuffer = await file.arrayBuffer();
    const fileBytes = new Uint8Array(fileBuffer);
    const fileName = `${Date.now()}-${file.name}`;

    const { error: storageError } = await supabase.storage
      .from('product-files')
      .upload(fileName, fileBytes, {
        contentType: file.type,
        upsert: false
      });

    if (storageError) {
      console.error('Storage error:', storageError);
      return NextResponse.json({ error: 'Failed to upload file' }, { status: 500 });
    }

    const { data: urlData } = supabase.storage
      .from('product-files')
      .getPublicUrl(fileName);

    // Create product record with pending status
    const { data: product, error: productError } = await supabase
      .from('products')
      .insert({
        name: file.name.replace(/\.[^/.]+$/, ''),
        description: null,
        file_url: urlData.publicUrl,
        file_name: fileName,
        status: 'pending'
      })
      .select()
      .single();

    if (productError) {
      console.error('Product insert error:', productError);
      return NextResponse.json({ error: 'Failed to create product record' }, { status: 500 });
    }

    // Trigger async analysis with locale
    const base64 = Buffer.from(fileBytes).toString('base64');
    
    // Start async analysis (fire and forget)
    const baseUrl = request.nextUrl.origin;
    fetch(`${baseUrl}/api/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        productId: product.id,
        fileBase64: base64,
        mimeType,
        fileName: file.name,
        locale  // ← pass locale to analysis pipeline
      })
    }).catch(console.error);

    return NextResponse.json({ 
      success: true, 
      product,
      message: 'File uploaded. Analysis started.'
    });

  } catch (error) {
    console.error('Upload error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
