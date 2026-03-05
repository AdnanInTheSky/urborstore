// api/submit.js
// Vercel Edge Function - Secure proxy to Google Apps Script (No API Key)

export const config = {
  runtime: 'edge',
};

// ✅ FIXED: Removed trailing spaces from URL
const SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbwCTprJJomeXczBnjnP8DMxq9YJ28oa3DzvErTMvQt1mI69hzGoU0liHmFOBsbN7AcK/exec';

// In-memory rate limiting store (note: resets on cold start in Edge Functions)
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

function sanitizeInput(str) {
  if (typeof str !== 'string') return str;
  return str.replace(/^[=+\-@]/, "'$&").replace(/[<>]/g, '').trim();
}

function validateEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function validatePhone(phone) {
  return /^01[3-9]\d{8}$/.test(phone);
}

function validateTransactionId(txnId) {
  return /^[0-9a-zA-Z]{8,12}$/.test(txnId);
}

export default async function handler(request) {
  // CORS Configuration
  const allowedOrigin = process.env.ALLOWED_ORIGIN || '*';
  const corsHeaders = {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };

  // Handle preflight OPTIONS request
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  // Reject non-POST methods
  if (request.method !== 'POST') {
    return new Response(
      JSON.stringify({ error: 'Method not allowed' }),
      { status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  try {
    // ─────────────────────────────────────
    // 1. RATE LIMITING
    // ─────────────────────────────────────
    const clientIP = request.headers.get('x-forwarded-for')?.split(',')[0] || 'unknown';
    if (isRateLimited(clientIP)) {
      return new Response(
        JSON.stringify({ error: 'Too many requests. Please wait 60 seconds.' }),
        { status: 429, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // ─────────────────────────────────────
    // 2. PARSE & VALIDATE REQUEST BODY
    // ─────────────────────────────────────
    let body;
    try {
      body = await request.json();
    } catch (parseError) {
      console.error('[PARSE_ERROR] Invalid JSON body:', parseError.message);
      return new Response(
        JSON.stringify({ error: 'Invalid JSON in request body' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Required fields check
    const required = ['transactionId', 'name', 'email', 'phone', 'address', 'total'];
    const missing = required.filter(field => !body[field]?.toString().trim());
    if (missing.length > 0) {
      return new Response(
        JSON.stringify({ error: `Missing required fields: ${missing.join(', ')}` }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // ─────────────────────────────────────
    // 3. SANITIZE & FORMAT DATA
    // ─────────────────────────────────────
    const cleanData = {
      transactionId: sanitizeInput(body.transactionId),
      name: sanitizeInput(body.name),
      email: sanitizeInput(body.email).toLowerCase(),
      phone: sanitizeInput(body.phone),
      address: sanitizeInput(body.address),
      total: parseFloat(body.total) || 0,
      items: sanitizeInput(body.items || ''),
      receivedAt: new Date().toISOString(),
      source: 'web-frontend',
    };

    // ─────────────────────────────────────
    // 4. BUSINESS LOGIC VALIDATION
    // ─────────────────────────────────────
    const validationErrors = [];
    
    if (!validateEmail(cleanData.email)) validationErrors.push('Invalid email format');
    if (!validatePhone(cleanData.phone)) validationErrors.push('Invalid phone number (use: 017XXXXXXXX)');
    if (!validateTransactionId(cleanData.transactionId)) validationErrors.push('Invalid transaction ID (8-12 alphanumeric chars)');
    if (cleanData.total <= 0 || cleanData.total > 50000) validationErrors.push('Invalid order total (1-50000 BDT)');
    if (cleanData.name.length < 2 || cleanData.name.length > 100) validationErrors.push('Name must be 2-100 characters');
    if (cleanData.address.length < 10 || cleanData.address.length > 300) validationErrors.push('Address must be 10-300 characters');

    if (validationErrors.length > 0) {
      return new Response(
        JSON.stringify({ error: validationErrors.join('; ') }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // ─────────────────────────────────────
    // 5. FORWARD TO GOOGLE APPS SCRIPT
    // ─────────────────────────────────────
    console.log('[FORWARDING] To Google Script:', { 
      transactionId: cleanData.transactionId, 
      total: cleanData.total,
      url: SCRIPT_URL 
    });

    let scriptResponse;
    try {
      scriptResponse = await fetch(SCRIPT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cleanData),
        // ⚠️ Edge Functions don't support redirect: 'manual', so we handle redirects manually
      });
    } catch (fetchError) {
      console.error('[FETCH_ERROR] Failed to reach Google Script:', fetchError.message);
      throw new Error(`Unable to connect to order processor: ${fetchError.message}`);
    }

    // Read response as text FIRST to debug non-JSON responses
    const scriptText = await scriptResponse.text();
    console.log('[SCRIPT_RESPONSE] Status:', scriptResponse.status, 'Body preview:', scriptText.slice(0, 300));

    // Check if response is actually JSON
    if (!scriptResponse.headers.get('content-type')?.includes('application/json')) {
      console.error('[CONTENT_TYPE_ERROR] Expected JSON but got:', scriptResponse.headers.get('content-type'));
      // Google Apps Script sometimes returns HTML errors - surface this for debugging
      if (scriptText.includes('<!DOCTYPE html') || scriptText.includes('<html')) {
        throw new Error('Google Script returned an HTML error page. Check your script deployment and CORS settings.');
      }
    }

    let scriptResult;
    try {
      scriptResult = JSON.parse(scriptText);
    } catch (parseErr) {
      console.error('[PARSE_ERROR] Invalid JSON from Google Script:', {
        raw: scriptText.slice(0, 500),
        error: parseErr.message
      });
      throw new Error(`Order processor returned invalid response: ${parseErr.message}`);
    }

    // ─────────────────────────────────────
    // 6. HANDLE GOOGLE SCRIPT RESPONSE
    // ─────────────────────────────────────
    if (scriptResult?.result === 'success') {
      return new Response(
        JSON.stringify({
          success: true,
          message: 'Order received successfully',
          transactionId: cleanData.transactionId.slice(0, 4) + '****',
          timestamp: cleanData.receivedAt,
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    } else {
      // Propagate specific error from Google Script if available
      const errorMsg = scriptResult?.error || scriptResult?.message || 'Order processing failed';
      throw new Error(errorMsg);
    }

  } catch (error) {
    console.error('[ORDER_API_ERROR]', {
      message: error.message,
      type: error.name,
      stack: error.stack,
      ip: request.headers.get('x-forwarded-for')?.split(',')[0],
    });

    return new Response(
      JSON.stringify({
        error: error.message || 'Order submission failed. Please try again or contact support.'
      }),
      {
        status: error.message?.includes('Google Script') ? 502 : 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  }
}