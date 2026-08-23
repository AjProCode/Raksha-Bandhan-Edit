const express = require('express');
const cors = require('cors');
const Razorpay = require('razorpay');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
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

const mailer = process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS
  ? nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: process.env.SMTP_SECURE === 'true',
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    })
  : null;
const testCouponCode = 'BMATEST1';

function validateOrderDetails(details) {
  const requiredFields = ['name', 'email', 'phone', 'deliveryDate', 'fulfillment', 'address', 'pickupTime'];
  if (!details || requiredFields.some(field => typeof details[field] !== 'string' || !details[field].trim())) {
    return 'All customer and delivery details are required.';
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(details.email.trim())) return 'Enter a valid email address.';
  if (!/^[+\d][\d\s()-]{7,}$/.test(details.phone.trim())) return 'Enter a valid phone number.';

  const requestedTime = new Date(`${details.deliveryDate}T${details.pickupTime}:00+05:30`);
  if (Number.isNaN(requestedTime.getTime()) || requestedTime.getTime() < Date.now() + 24 * 60 * 60 * 1000) {
    return 'Delivery or pickup must be scheduled at least 24 hours from now.';
  }

  const maxDate = new Date('2026-08-31T00:00:00+05:30');
  if (requestedTime.getTime() >= maxDate.getTime()) {
    return 'We are not accepting orders for after August 30th.';
  }

  return null;
}

// Endpoint to fetch the Razorpay Key ID for the frontend safely
app.get('/api/config', (req, res) => {
    res.json({ keyId: process.env.RAZORPAY_KEY_ID });
});

app.post('/api/validate-coupon', (req, res) => {
  const code = typeof req.body.code === 'string' ? req.body.code.trim().toUpperCase() : '';
  res.json({ valid: code === testCouponCode, discountType: 'fixed', discountAmount: 0 });
});

// 1. Create Order Endpoint
app.post('/api/create-order', async (req, res) => {
  try {
    const { amount, receipt, couponCode } = req.body;
    const couponApplied = typeof couponCode === 'string' && couponCode.trim().toUpperCase() === testCouponCode;
    const payableAmount = couponApplied ? 100 : amount;

    // Validate amount (must be at least 100 paise = 1 INR)
    if (!payableAmount || payableAmount < 100) {
        return res.status(400).json({ error: 'Invalid amount. Minimum amount is 100 paise.' });
    }

    const options = {
      amount: payableAmount, // amount in the smallest currency unit (paise)
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

// 3. Email the customer and store after a verified payment
app.post('/api/notify-order', async (req, res) => {
  try {
    const { details, items, totalAmount, subtotal, couponCode, paymentId, orderId, paymentDateTime } = req.body;
    const validationError = validateOrderDetails(details);
    if (validationError || !Array.isArray(items) || !items.length || !totalAmount || !paymentId) {
      return res.status(400).json({ error: validationError || 'Missing order information.' });
    }
    if (!mailer) return res.status(503).json({ error: 'Email service is not configured on the server.' });

    const itemLines = items.map(item => `${item.name} - Qty: ${item.qty} x INR ${item.price} = INR ${item.price * item.qty}`).join('\n');
    const text = [
      'Bake Me A Wish order confirmation',
      '',
      `Customer: ${details.name}`,
      `Email: ${details.email}`,
      `Phone: ${details.phone}`,
      `Fulfillment: ${details.fulfillment}`,
      `Delivery date: ${details.deliveryDate}`,
      `Pickup/delivery time: ${details.pickupTime}`,
      `Address: ${details.address}`,
      '',
      'Items:',
      itemLines,
      '',
      `Subtotal: INR ${subtotal || totalAmount}`,
      couponCode ? `Coupon applied: ${couponCode}` : 'Coupon applied: None',
      `Total amount paid: INR ${totalAmount}`,
      `Payment date and time: ${paymentDateTime || new Date().toISOString()}`,
      `Payment ID: ${paymentId}`,
      `Razorpay order ID: ${orderId || 'N/A'}`,
    ].join('\n');

    await mailer.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to: [details.email, 'agarwal.reshu@gmail.com'],
      subject: `Order confirmation - ${details.name}`,
      text,
    });

    res.json({ success: true });
  } catch (error) {
    console.error('Error sending order notification:', error);
    res.status(500).json({ error: 'Payment succeeded, but order email could not be sent.' });
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
