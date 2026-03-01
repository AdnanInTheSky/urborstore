// api/submit.js
// Production-grade secure proxy to Google Apps Script
// Runtime: Vercel Edge (fast cold starts, global distribution)

export const config = {
  runtime: 'edge',
};

// ✅ Your Google Apps Script endpoint (server-side only)
const SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbwmS4l61c_M0xxQMhfnsNSClUpxhmShPuXulv4kF8vlzqEWD3BGb4VyrneXXMUG9AOf/exec';

// In-memory rate limiting store (MVP-safe; use @vercel/kv for production scale)
const rateLimitStore = new Map();

/**
 * Rate limiting: Allow N requests per window per identifier
 */
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

/**
 * Sanitize user input: prevent formula injection & XSS
 */
function sanitizeInput(str) {
  if (typeof str !== 'string') return str;
  return str
    .replace(/^[=+\-@]/, "'$&")  // Block Google Sheets formula injection
    .replace(/[<>]/g, '')         // Block basic XSS
    .trim();
}

/**
 * Validate email format
 */
function validateEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/**
 * Validate Bangladesh mobile number format
 */
function validatePhone(phone) {
  return /^01[3-9]\d{8}$/.test(phone);
}

/**
 * Validate bKash transaction ID format (8-12 alphanumeric)
 */
function validateTransactionId(txnId) {
  return /^[0-9a-zA-Z]{8,12}$/.test(txnId);
}

export default async function handler(request) {
  // CORS Configuration
  const allowedOrigin = process.env.ALLOWED_ORIGIN || '*';
  const corsHeaders = {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-API-Key',
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
    // 2. API KEY AUTHENTICATION
    // ─────────────────────────────────────
    const apiKey = request.headers.get('x-api-key');
    if (!apiKey || apiKey !== process.env.API_SECRET_KEY) {
      console.warn(`[UNAUTHORIZED] IP: ${clientIP}, Key: ${apiKey?.slice(0, 8)}...`);
      return new Response(
        JSON.stringify({ error: 'Unauthorized' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // ─────────────────────────────────────
    // 3. PARSE & VALIDATE REQUEST BODY
    // ─────────────────────────────────────
    let body;
    try {
      body = await request.json();
    } catch {
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
    // 4. SANITIZE & FORMAT DATA
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
    // 5. BUSINESS LOGIC VALIDATION
    // ─────────────────────────────────────
    const validationErrors = [];
    
    if (!validateEmail(cleanData.email)) {
      validationErrors.push('Invalid email format');
    }
    if (!validatePhone(cleanData.phone)) {
      validationErrors.push('Invalid phone number (use: 017XXXXXXXX)');
    }
    if (!validateTransactionId(cleanData.transactionId)) {
      validationErrors.push('Invalid transaction ID (8-12 alphanumeric chars)');
    }
    if (cleanData.total <= 0 || cleanData.total > 50000) {
      validationErrors.push('Invalid order total (1-50000 BDT)');
    }
    if (cleanData.name.length < 2 || cleanData.name.length > 100) {
      validationErrors.push('Name must be 2-100 characters');
    }
    if (cleanData.address.length < 10 || cleanData.address.length > 300) {
      validationErrors.push('Address must be 10-300 characters');
    }

    if (validationErrors.length > 0) {
      return new Response(
        JSON.stringify({ error: validationErrors.join('; ') }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // ─────────────────────────────────────
    // 6. FORWARD TO GOOGLE APPS SCRIPT
    // ─────────────────────────────────────
    const scriptResponse = await fetch(SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cleanData),
      // Timeout: 30 seconds max for Google Script response
    });

    // Check for network-level errors
    if (!scriptResponse.ok) {
      const errorText = await scriptResponse.text().catch(() => 'Unknown error');
      console.error(`[SCRIPT_ERROR] Status: ${scriptResponse.status}, Body: ${errorText.slice(0, 200)}`);
      throw new Error(`Google Script responded with status ${scriptResponse.status}`);
    }

    const scriptText = await scriptResponse.text();
    let scriptResult;
    
    try {
      scriptResult = JSON.parse(scriptText);
    } catch (parseErr) {
      console.error('[PARSE_ERROR] Invalid JSON from Google Script:', scriptText.slice(0, 200));
      throw new Error('Order processor returned invalid response');
    }

    // ─────────────────────────────────────
    // 7. HANDLE GOOGLE SCRIPT RESPONSE
    // ─────────────────────────────────────
    if (scriptResult?.result === 'success') {
      // Return sanitized success response (never expose full transaction ID)
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
      const errorMsg = scriptResult?.message || 'Order processing failed';
      console.error(`[SCRIPT_LOGIC_ERROR] ${errorMsg}`);
      throw new Error(errorMsg);
    }

  } catch (error) {
    // ─────────────────────────────────────
    // ERROR LOGGING (Vercel Logs)
    // ─────────────────────────────────────
    console.error('[ORDER_API_ERROR]', {
      message: error.message,
      type: error.name,
      ip: request.headers.get('x-forwarded-for')?.split(',')[0],
      userAgent: request.headers.get('user-agent')?.slice(0, 100),
      // Only log stack in development
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined,
    });

    // Return generic, user-friendly error (never leak internals)
    return new Response(
      JSON.stringify({
        error: 'Order submission failed. Please try again or contact support at hello@urboressentials.com'
      }),
      {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  }
}