// api/sub.js
import { MongoClient } from 'mongodb';

// 🔗 Your MongoDB Atlas connection string
// ⚠️ For production: Move this to Vercel Environment Variables
const MONGODB_URI = 'mongodb+srv://adnaninsky:980Orwo7M5xB8fnh@cluster0.bd9ywas.mongodb.net/urbor_essentials?retryWrites=true&w=majority';

export default async function handler(req, res) {
  // CORS headers for frontend access
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  // Handle preflight requests
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Only allow POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const client = new MongoClient(MONGODB_URI);

  try {
    const { name, phone, email, address, transactionId, total, items } = req.body;

    // Server-side validation
    const errors = [];
    if (!name?.trim()) errors.push('Name is required');
    if (!phone?.trim()) errors.push('Phone is required');
    if (!email?.trim()) errors.push('Email is required');
    if (!address?.trim()) errors.push('Address is required');
    if (!transactionId?.trim()) errors.push('Transaction ID is required');
    if (!total || isNaN(parseFloat(total))) errors.push('Valid total amount is required');
    
    if (errors.length > 0) {
      return res.status(400).json({ error: errors.join(', ') });
    }

    // Connect to MongoDB Atlas
    await client.connect();
    const db = client.db('urbor_essentials'); // Database name
    const collection = db.collection('orders');

    // Create order document
    const order = {
      name: name.trim(),
      phone: phone.trim(),
      email: email.trim().toLowerCase(),
      address: address.trim(),
      transactionId: transactionId.trim().toUpperCase(),
      total: parseFloat(total),
      items: items || '',
      status: 'pending', // ✅ For admin panel: 'pending' or 'finished'
      paymentMethod: 'bKash',
      paymentOnDelivery: true, // ✅ Your preference
      createdAt: new Date(),
      updatedAt: new Date()
    };

    // Insert into MongoDB
    const result = await collection.insertOne(order);

    return res.status(201).json({
      success: true,
      message: 'Order placed successfully',
      transactionId: order.transactionId,
      orderId: result.insertedId.toString()
    });

  } catch (error) {
    console.error('🔥 Order submission error:', error);
    return res.status(500).json({ 
      error: 'Failed to process order',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  } finally {
    // Always close connection to prevent leaks
    await client.close();
  }
}