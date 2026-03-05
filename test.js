// test.js - Run with: node test.js

const API_URL = 'https://script.google.com/macros/s/AKfycbwuTodU2_Rlr4dGOyF4hgVKPs7A4hzd8uurKymE3ZsTiuxpleu03WBB4ijEdFisfEC4/exec'; // ← Replace with YOUR actual Vercel URL
const API_KEY = 'urbor-secure-key-2026-abc123xyz789'; // ← Must match Vercel env var

async function testOrder() {
  try {
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': API_KEY
      },
      body: JSON.stringify({
        transactionId: 'TEST' + Date.now().toString().slice(-6),
        name: 'Test User',
        email: 'test@urboressentials.com',
        phone: '01711111111',
        address: 'Test Address, Dhaka',
        total: '1.00',
        items: 'Test Item (x1)'
      })
    });

    const result = await response.json();
    
    console.log('✅ Status:', response.status);
    console.log('✅ Response:', JSON.stringify(result, null, 2));
    
    if (response.ok) {
      console.log('\n🎉 Test PASSED - Order submitted successfully!');
    } else {
      console.log('\n❌ Test FAILED -', result.error);
    }
  } catch (error) {
    console.error('❌ Fetch Error:', error.message);
    console.error('💡 Tip: Check your API_URL and internet connection');
  }
}

testOrder();