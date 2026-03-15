import { NextRequest, NextResponse } from 'next/server';
import { getServiceClient } from '@/lib/supabase';
import { extractProductInfo } from '@/lib/gemini';

export const maxDuration = 60;

export async function POST(request: NextRequest) {
  const { productId, fileBase64, mimeType, fileName, locale = 'en' } = await request.json();
  
  const supabase = getServiceClient();

  try {
    // Update status to analyzing
    await supabase
      .from('products')
      .update({ status: 'analyzing' })
      .eq('id', productId);

    // Step 1: Extract product info with Gemini (locale-aware, fast < 60s)
    console.log(`[${productId}] Extracting product info (locale: ${locale})...`);
    const productInfo = await extractProductInfo(fileBase64, mimeType, fileName, locale);

    // Update product name, description, and status to 'extracted'
    await supabase
      .from('products')
      .update({
        name: productInfo.name,
        description: productInfo.description,
        status: 'extracted'
      })
      .eq('id', productId);

    console.log(`[${productId}] Extraction complete, triggering synthesis...`);

    // Fire & forget: trigger synthesize step
    const baseUrl = process.env.NEXT_PUBLIC_SITE_URL || 'http://localhost:3000';
    fetch(`${baseUrl}/api/analyze/synthesize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        productId,
        productInfo,
        locale,
      }),
    }).catch((err) => {
      console.error(`[${productId}] Failed to trigger synthesize:`, err);
    });

    return NextResponse.json({ success: true, status: 'extracted' });

  } catch (error) {
    console.error(`[${productId}] Extraction failed:`, error);
    
    await supabase
      .from('products')
      .update({ status: 'failed' })
      .eq('id', productId);

    return NextResponse.json({ error: 'Analysis failed' }, { status: 500 });
  }
}
