const express = require('express');
const cors = require('cors');
const Razorpay = require('razorpay');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
// Serve static files from the 'public' directory
app.use(express.static('public')); 

// Explicitly serve index.html for the root route
const path = require('path');
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Initialize Razorpay
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// Endpoint to fetch the Razorpay Key ID for the frontend safely
app.get('/api/config', (req, res) => {
    res.json({ keyId: process.env.RAZORPAY_KEY_ID });
});

// 1. Create Order Endpoint
app.post('/api/create-order', async (req, res) => {
  try {
    const { amount, receipt } = req.body;

    // Validate amount (must be at least 100 paise = 1 INR)
    if (!amount || amount < 100) {
        return res.status(400).json({ error: 'Invalid amount. Minimum amount is 100 paise.' });
    }

    const options = {
      amount: amount, // amount in the smallest currency unit (paise)
      currency: 'INR',
      receipt: receipt || `receipt_${Date.now()}`,
    };

    const order = await razorpay.orders.create(options);
    
    if (!order) {
        return res.status(500).json({ error: 'Failed to create order with Razorpay.' });
    }

    res.json(order);

  } catch (error) {
    console.error('Error creating order:', error);
    res.status(500).json({ error: error.message || 'Internal Server Error' });
  }
});

// 2. Verify Payment Signature Endpoint
app.post('/api/verify-payment', (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
        return res.status(400).json({ error: 'Missing required payment verification fields.' });
    }

    const secret = process.env.RAZORPAY_KEY_SECRET;

    // Create the expected signature
    const hmac = crypto.createHmac('sha256', secret);
    hmac.update(razorpay_order_id + "|" + razorpay_payment_id);
    const expectedSignature = hmac.digest('hex');

    // Compare signatures
    if (expectedSignature === razorpay_signature) {
      // Signatures match - payment is verified
      res.json({ success: true, message: 'Payment verified successfully.' });
    } else {
      // Signatures do not match
      res.status(400).json({ success: false, error: 'Payment verification failed. Invalid signature.' });
    }

  } catch (error) {
    console.error('Error verifying payment:', error);
    res.status(500).json({ error: 'Internal Server Error during verification' });
  }
});

// Export the Express API for Vercel
module.exports = app;

// Only listen locally if not on Vercel
if (process.env.NODE_ENV !== 'production') {
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
        console.log(`Server is running on port ${PORT}`);
    });
}