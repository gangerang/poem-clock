require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.static('public'));

// OpenRouter configuration
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'anthropic/claude-3.5-sonnet';
const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';

// Validate API key on startup
if (!OPENROUTER_API_KEY) {
  console.error('ERROR: OPENROUTER_API_KEY environment variable is not set!');
  console.error('Please create a .env file with your OpenRouter API key.');
  process.exit(1);
}

// API endpoint to generate poem
app.post('/api/generate-poem', async (req, res) => {
  try {
    const { prompt, timeString } = req.body;

    if (!prompt) {
      return res.status(400).json({ error: 'Prompt is required' });
    }

    console.log(`\n${'='.repeat(60)}`);
    console.log(`⏰ Generating poem for time: ${timeString || 'unknown'}`);
    console.log(`${'='.repeat(60)}`);

    // Make request to OpenRouter
    const response = await fetch(OPENROUTER_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': process.env.APP_URL || 'http://localhost:3000',
        'X-Title': 'Poem Clock'
      },
      body: JSON.stringify({
        model: OPENROUTER_MODEL,
        messages: [
          {
            role: 'user',
            content: prompt
          }
        ],
        temperature: 0.8,
        max_tokens: 200
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`OpenRouter API error: ${response.status} - ${errorText}`);
      throw new Error(`OpenRouter API returned ${response.status}`);
    }

    const data = await response.json();

    // Extract the poem from OpenRouter's response
    const poem = data.choices?.[0]?.message?.content || '';

    if (!poem) {
      throw new Error('No poem content in response');
    }

    // Log the generated poem
    console.log(`\n📜 Generated Poem:`);
    console.log(`${'-'.repeat(60)}`);
    console.log(poem.trim());
    console.log(`${'-'.repeat(60)}\n`);

    res.json({ poem: poem.trim() });

  } catch (error) {
    console.error('❌ Error generating poem:', error.message);
    res.status(500).json({
      error: 'Failed to generate poem',
      message: error.message
    });
  }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    model: OPENROUTER_MODEL,
    timestamp: new Date().toISOString()
  });
});

// Serve index.html for all other routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server
app.listen(PORT, () => {
  console.log(`✨ Poem Clock server running on port ${PORT}`);
  console.log(`📝 Using OpenRouter model: ${OPENROUTER_MODEL}`);
  console.log(`🌐 Open http://localhost:${PORT} in your browser`);
});
