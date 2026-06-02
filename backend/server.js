require('dotenv').config();
const express = require('express');
const path = require('path');
const cors = require('cors');

const authRoutes = require('./routes/auth');
const inspectionRoutes = require('./routes/inspections');
const generatorWebhookRouter = require('./routes/generator-webhook');
const generatorCareRouter = require('./routes/generator-care');
const generatorCareCronRouter = require('./routes/generator-care-cron');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
// Stripe webhook must receive raw body for signature verification
app.use('/webhooks/stripe', express.raw({ type: 'application/json' }), generatorWebhookRouter);

app.use(express.json({ limit: '10mb' }));

app.get('/health', (req, res) => {
  res.json({
    status: 'Bates Electric API is running!',
    timestamp: new Date().toISOString(),
  });
});

app.get('/config', (req, res) => {
  res.json({
    supabaseUrl: process.env.SUPABASE_URL,
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY,
  });
});

app.use('/auth', authRoutes);
// GET /me lives on the auth router but is commonly called without the prefix;
// mount it there as well for convenience.
app.use('/', authRoutes);
app.use('/inspections', inspectionRoutes);

// Serve the frontend as static files (after API routes so they take priority)
app.use(express.static(path.join(__dirname, '..', 'frontend')));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Server error' });
});

app.use('/api/generator-care', generatorCareRouter);
app.use('/api/cron/generator-care', generatorCareCronRouter);

app.listen(PORT, () => {
  console.log(`Bates Electric backend running on port ${PORT}`);
});
