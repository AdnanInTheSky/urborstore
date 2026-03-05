// api/submit.js
// Vercel Edge Function - Secure proxy to Google Apps Script
// NO API KEY - Uses rate limiting for basic protection

export const config = {
  runtime: 'edge',
};

// ✅ Clean URL - NO trailing spaces
const SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbzjifcgdtEvb68ZSypcyowVTtSH0RfU2NK8y6f5ixI8vwEtCcsJrkr21F3d2OKiFk2M/exec';

// In-memory rate limiting (resets on cold start)
const rateLimitStore = new Map();

function isRateLimited(identifier, limit = 15, windowMs = 60000) {
  const now = Date.now();
  const record = rateLimitStore.get(identifier) || { count: 0, resetAt: now + windowMs };
  if (now > record.resetAt) {
    record.count = 1;
    record.resetAt = now + windowMs;
  } else {
    record.count++;
  }
  rateLimitStore.set(identifier, record);
  return record.count > limit;
}

export default async function handler(request) {
  // ✅ CORS Headers - MUST be on EVERY response
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  // ✅ 1. Handle OPTIONS preflight FIRST
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  // ✅ 2. Only allow POST
  if (request.method !== 'POST') {
    return new Response(
      JSON.stringify({ error: 'Method not allowed', allowed: ['POST', 'OPTIONS'] }),
      { status: 405, headers: corsHeaders }
    );
  }

  try {
    // ✅ 3. Rate limiting
    const clientIP = request.headers.get('x-forwarded-for')?.split(',')[0] || 'unknown';
    if (isRateLimited(clientIP)) {
      return new Response(
        JSON.stringify({ error: 'Too many requests. Please wait 60 seconds.' }),
        { status: 429, headers: corsHeaders }
      );
    }

    // ✅ 4. Parse request body
    let body;
    try {
      body = await request.json();
    } catch (parseError) {
      return new Response(
        JSON.stringify({ error: 'Invalid JSON in request body' }),
        { status: 400, headers: corsHeaders }
      );
    }

    // ✅ 5. Basic validation
    const required = ['transactionId', 'name', 'email', 'phone', 'address', 'total'];
    const missing = required.filter(field => !body[field]?.toString().trim());
    if (missing.length > 0) {
      return new Response(
        JSON.stringify({ error: `Missing required fields: ${missing.join(', ')}` }),
        { status: 400, headers: corsHeaders }
      );
    }

    // ✅ 6. Forward to Google Apps Script
    console.log('[FORWARDING] To Google Script:', {
      transactionId: body.transactionId?.slice(0, 4) + '****',
      total: body.total
    });

    const gasResponse = await fetch(SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    // ✅ 7. Read response as text first
    const gasText = await gasResponse.text();
    console.log('[SCRIPT_RESPONSE] Status:', gasResponse.status, 'Preview:', gasText.slice(0, 300));

    // ✅ 8. Parse GAS response
    let gasResult;
    try {
      gasResult = JSON.parse(gasText);
    } catch (parseErr) {
      console.error('[PARSE_ERROR] Invalid JSON from Google Script:', gasText.slice(0, 500));
      throw new Error('Order processor returned invalid response');
    }

    // ✅ 9. Handle response
    if (gasResult?.result === 'success') {
      return new Response(
        JSON.stringify({
          success: true,
          message: 'Order received successfully',
          transactionId: body.transactionId?.slice(0, 4) + '****',
          timestamp: new Date().toISOString(),
        }),
        { status: 200, headers: corsHeaders }
      );
    } else {
      return new Response(
        JSON.stringify({
          error: gasResult?.message || 'Order processing failed',
          details: gasResult
        }),
        { status: 400, headers: corsHeaders }
      );
    }

  } catch (error) {
    console.error('[ORDER_API_ERROR]', {
      message: error.message,
      type: error.name,
      ip: request.headers.get('x-forwarded-for')?.split(',')[0],
    });

    return new Response(
      JSON.stringify({
        error: error.message || 'Order submission failed. Please try again.'
      }),
      {
        status: error.message?.includes('Google Script') ? 502 : 500,
        headers: corsHeaders,
      }
    );
  }
}