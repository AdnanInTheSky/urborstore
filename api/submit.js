// api/submit.js - WITH ENHANCED DEBUGGING
export const config = {
  runtime: 'edge',
};

// ✅ PASTE YOUR FRESH GAS URL HERE (no trailing spaces!)
const SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbwuTodU2_Rlr4dGOyF4hgVKPs7A4hzd8uurKymE3ZsTiuxpleu03WBB4ijEdFisfEC4/exec';

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
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (request.method !== 'POST') {
    return new Response(
      JSON.stringify({ error: 'Method not allowed' }),
      { status: 405, headers: corsHeaders }
    );
  }

  try {
    const clientIP = request.headers.get('x-forwarded-for')?.split(',')[0] || 'unknown';
    if (isRateLimited(clientIP)) {
      return new Response(
        JSON.stringify({ error: 'Too many requests' }),
        { status: 429, headers: corsHeaders }
      );
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return new Response(
        JSON.stringify({ error: 'Invalid JSON body' }),
        { status: 400, headers: corsHeaders }
      );
    }

    const required = ['transactionId', 'name', 'email', 'phone', 'address', 'total'];
    const missing = required.filter(field => !body[field]?.toString().trim());
    if (missing.length > 0) {
      return new Response(
        JSON.stringify({ error: `Missing: ${missing.join(', ')}` }),
        { status: 400, headers: corsHeaders }
      );
    }

    console.log('[FORWARDING] To GAS:', SCRIPT_URL);

    let gasResponse;
    try {
      gasResponse = await fetch(SCRIPT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (fetchErr) {
      console.error('[FETCH_ERROR]', fetchErr.message);
      throw new Error(`Cannot reach Google Script: ${fetchErr.message}`);
    }

    const gasText = await gasResponse.text();
    console.log('[GAS_RESPONSE] Status:', gasResponse.status);
    console.log('[GAS_RESPONSE] Body:', gasText.slice(0, 500));
    console.log('[GAS_RESPONSE] Content-Type:', gasResponse.headers.get('content-type'));

    // ✅ Check if response is HTML (common GAS error)
    if (gasText.trim().startsWith('<!DOCTYPE') || gasText.trim().startsWith('<html')) {
      console.error('[GAS_ERROR] Returned HTML instead of JSON!');
      throw new Error('Google Script returned HTML. Check deployment settings (must be "Anyone" access)');
    }

    let gasResult;
    try {
      gasResult = JSON.parse(gasText);
    } catch (parseErr) {
      console.error('[PARSE_ERROR]', parseErr.message, 'Raw:', gasText.slice(0, 200));
      throw new Error(`Invalid response from Google Script: ${parseErr.message}`);
    }

    if (gasResult?.result === 'success') {
      return new Response(
        JSON.stringify({
          success: true,
          message: 'Order received',
          transactionId: body.transactionId?.slice(0, 4) + '****',
        }),
        { status: 200, headers: corsHeaders }
      );
    } else {
      return new Response(
        JSON.stringify({
          error: gasResult?.message || 'Order failed',
          details: gasResult
        }),
        { status: 400, headers: corsHeaders }
      );
    }

  } catch (error) {
    console.error('[API_ERROR]', {
      message: error.message,
      stack: error.stack?.split('\n')[0],
    });

    return new Response(
      JSON.stringify({
        error: error.message || 'Order submission failed',
        hint: 'Check Vercel logs for details'
      }),
      {
        status: 500,
        headers: corsHeaders,
      }
    );
  }
}