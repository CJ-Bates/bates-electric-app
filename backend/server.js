const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

// Create the server
const app = express();
const PORT = process.env.PORT || 3000;

// Connect to Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// Middleware - tools that run on every request
app.use(cors());
app.use(express.json());

// Test route - just to make sure everything works
app.get('/health', (req, res) => {
  res.json({ 
    status: 'Bates Electric API is running!',
    timestamp: new Date().toISOString()
  });
});

// Start the server
app.listen(PORT, () => {
  console.log(`Bates Electric backend running on port ${PORT}`);
});