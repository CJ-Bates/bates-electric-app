require('dotenv').config();
const express = require('express');
const cors = require('cors');

const authRoutes = require('./routes/auth');
const inspectionRoutes = require('./routes/inspections');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
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

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Server error' });
});

app.listen(PORT, () => {
  console.log(`Bates Electric backend running on port ${PORT}`);
});
