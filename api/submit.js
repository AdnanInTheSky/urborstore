// api/submit.js
// Vercel Edge Function - Secure proxy to Google Apps Script
// Handles CORS, validation, rate limiting, and error handling

export const config = {
  runtime: 'edge',
};

// ✅ FIXED: Clean URL with NO trailing spaces
const SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbzjifcgdtEvb68ZSypcyowVTtSH0RfU2NK8y6f5ixI8vwEtCcsJrkr21F3d2OKiFk2M/exec';

// In-memory rate limiting (resets on cold start in Edge Functions)
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
  // Prevent formula injection in spreadsheets
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
  // 🐛 DEBUG: Log incoming request
  console.log('[REQUEST] Method:', request.method, 'URL:', request.url);
  console.log('[REQUEST] Origin:', request.headers.get('origin'));
  
  // ✅ CORS Headers - MUST be included in EVERY response
  const allowedOrigin = process.env.ALLOWED_ORIGIN || request.headers.get('origin') || '*';
  const corsHeaders = {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With, Accept',
    'Access-Control-Max-Age': '86400',
    'Content-Type': 'application/json',
  };

  // ✅ 1. Handle preflight OPTIONS request FIRST (critical for CORS)
  if (request.method === 'OPTIONS') {
    console.log('[PREFLIGHT] OPTIONS request - returning 204');
    return new Response(null, { 
      status: 204, 
      headers: corsHeaders 
    });
  }

  // ✅ 2. Reject non-POST methods with helpful error
  if (request.method !== 'POST') {
    console.warn('[405] Method not allowed:', request.method);
    return new Response(
      JSON.stringify({ 
        error: 'Method not allowed', 
        allowed: ['POST', 'OPTIONS'],
        received: request.method 
      }),
      { 
        status: 405, 
        headers: corsHeaders 
      }
    );
  }

  try {
    // ✅ 3. Rate limiting check
    const clientIP = request.headers.get('x-forwarded-for')?.split(',')[0] || 'unknown';
    if (isRateLimited(clientIP)) {
      console.warn('[RATE_LIMIT] Blocked request from:', clientIP);
      return new Response(
        JSON.stringify({ error: 'Too many requests. Please wait 60 seconds.' }),
        { status: 429, headers: corsHeaders }
      );
    }

    // ✅ 4. Parse & validate request body
    let body;
    try {
      body = await request.json();
    } catch (parseError) {
      console.error('[PARSE_ERROR] Invalid JSON body:', parseError.message);
      return new Response(
        JSON.stringify({ error: 'Invalid JSON in request body' }),
        { status: 400, headers: corsHeaders }
      );
    }

    // Required fields validation
    const required = ['transactionId', 'name', 'email', 'phone', 'address', 'total'];
    const missing = required.filter(field => !body[field]?.toString().trim());
    if (missing.length > 0) {
      return new Response(
        JSON.stringify({ error: `Missing required fields: ${missing.join(', ')}` }),
        { status: 400, headers: corsHeaders }
      );
    }

    // ✅ 5. Sanitize & format data
    const cleanData = {
      transactionId: sanitizeInput(body.transactionId),
      name: sanitizeInput(body.name),
      email: sanitizeInput(body.email).toLowerCase(),
      phone: sanitizeInput(body.phone),
      address: sanitizeInput(body.address),
      total: parseFloat(body.total) || 0,
      items: sanitizeInput(body.items || ''),
      receivedAt: new Date().toISOString(),
      source: 'vercel-edge-proxy',
    };

    // ✅ 6. Business logic validation
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
        { status: 400, headers: corsHeaders }
      );
    }

    // ✅ 7. Forward to Google Apps Script
    console.log('[FORWARDING] To Google Script:', { 
      transactionId: cleanData.transactionId, 
      total: cleanData.total 
    });

    let scriptResponse;
    try {
      scriptResponse = await fetch(SCRIPT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cleanData),
      });
    } catch (fetchError) {
      console.error('[FETCH_ERROR] Failed to reach Google Script:', fetchError.message);
      throw new Error(`Unable to connect to order processor: ${fetchError.message}`);
    }

    // ✅ 8. Read response as TEXT first to handle non-JSON responses
    const scriptText = await scriptResponse.text();
    console.log('[SCRIPT_RESPONSE] Status:', scriptResponse.status, 'Preview:', scriptText.slice(0, 300));

    // Check if response is actually JSON
    const contentType = scriptResponse.headers.get('content-type');
    if (!contentType || !contentType.includes('application/json')) {
      console.error('[CONTENT_TYPE_ERROR] Expected JSON but got:', contentType);
      if (scriptText.includes('<!DOCTYPE html') || scriptText.includes('<html')) {
        throw new Error('Google Script returned an HTML error page. Check deployment and "Anyone" access setting.');
      }
    }

    // Parse the JSON response
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

    // ✅ 9. Handle Google Script response
    if (scriptResult?.result === 'success') {
      return new Response(
        JSON.stringify({
          success: true,
          message: 'Order received successfully',
          transactionId: cleanData.transactionId.slice(0, 4) + '****',
          timestamp: cleanData.receivedAt,
        }),
        { status: 200, headers: corsHeaders }
      );
    } else {
      // Propagate specific error from Google Script
      const errorMsg = scriptResult?.error || scriptResult?.message || 'Order processing failed';
      throw new Error(errorMsg);
    }

  } catch (error) {
    console.error('[ORDER_API_ERROR]', {
      message: error.message,
      type: error.name,
      stack: error.stack?.split('\n')[0],
      ip: request.headers.get('x-forwarded-for')?.split(',')[0],
    });

    // Return appropriate status code based on error type
    const statusCode = 
      error.message?.includes('Missing') ? 400 :
      error.message?.includes('Invalid') ? 400 :
      error.message?.includes('Google Script') ? 502 :
      error.message?.includes('Unable to connect') ? 503 :
      500;

    return new Response(
      JSON.stringify({
        error: error.message || 'Order submission failed. Please try again or contact support.',
        ...(process.env.NODE_ENV === 'development' && { debug: error.stack })
      }),
      {
        status: statusCode,
        headers: corsHeaders,
      }
    );
  }
}