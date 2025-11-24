require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.static('public'));

// OpenRouter configuration
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'anthropic/claude-3.5-sonnet';
const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';

// Database configuration
const DATABASE_PATH = process.env.DATABASE_PATH || './poems.db';
const POEM_RETENTION_HOURS = parseInt(process.env.POEM_RETENTION_HOURS || '24', 10);

// Validate API key on startup
if (!OPENROUTER_API_KEY) {
  console.error('ERROR: OPENROUTER_API_KEY environment variable is not set!');
  console.error('Please create a .env file with your OpenRouter API key.');
  process.exit(1);
}

// Ensure database directory exists
const dbDir = path.dirname(DATABASE_PATH);
if (!fs.existsSync(dbDir)) {
  console.log(`Creating database directory: ${dbDir}`);
  fs.mkdirSync(dbDir, { recursive: true });
}

// Initialize SQLite database
const db = new Database(DATABASE_PATH);
db.pragma('journal_mode = WAL'); // Better performance for concurrent reads

// Create poems table
db.exec(`
  CREATE TABLE IF NOT EXISTS poems (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp INTEGER NOT NULL,
    time_string TEXT NOT NULL,
    poem TEXT NOT NULL,
    model_used TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_timestamp ON poems(timestamp);
`);

console.log(`📚 Database initialized at: ${DATABASE_PATH}`);

// In-memory cache for current poem
let currentPoem = {
  timeString: '',
  poem: '',
  timestamp: 0,
  minute: -1
};

let nextPoem = {
  poem: '',
  minute: -1
};

// Prepared statements for better performance
const insertPoemStmt = db.prepare(`
  INSERT INTO poems (timestamp, time_string, poem, model_used)
  VALUES (?, ?, ?, ?)
`);

const cleanupOldPoemsStmt = db.prepare(`
  DELETE FROM poems WHERE timestamp < ?
`);

const getPoemHistoryStmt = db.prepare(`
  SELECT * FROM poems ORDER BY timestamp DESC LIMIT ?
`);

// Format time in 12-hour format
function formatTime(date) {
  return date.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: true
  });
}

// Generate poem using OpenRouter API
async function generatePoemFromAPI(timeString) {
  const prompt = `Write a very short (2-4 lines) minimalist poem about the time ${timeString}. The poem must rhyme and be elegant and simple. Focus on the specific numbers in the time. The poem should feel contemplative and precise, like a haiku but with rhyme. The poem MUST NOT include AM, PM, hush, shadow, contemplation, or derivations of these words in the response. Respond with ONLY the poem text, no title or explanation.`;

  console.log(`\n${'='.repeat(60)}`);
  console.log(`⏰ Generating poem for time: ${timeString}`);
  console.log(`${'='.repeat(60)}`);

  try {
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
    const poem = data.choices?.[0]?.message?.content || '';

    if (!poem) {
      throw new Error('No poem content in response');
    }

    console.log(`\n📜 Generated Poem:`);
    console.log(`${'-'.repeat(60)}`);
    console.log(poem.trim());
    console.log(`${'-'.repeat(60)}\n`);

    return poem.trim();
  } catch (error) {
    console.error('❌ Error generating poem:', error.message);
    return `At ${timeString} the clock does chime,\nMarking moments, keeping time.`;
  }
}

// Save poem to database
function savePoemToDatabase(timeString, poem, timestamp) {
  try {
    insertPoemStmt.run(timestamp, timeString, poem, OPENROUTER_MODEL);
    console.log(`💾 Poem saved to database for ${timeString}`);
  } catch (error) {
    console.error('❌ Error saving poem to database:', error.message);
  }
}

// Cleanup old poems beyond retention period
function cleanupOldPoems() {
  const retentionMillis = POEM_RETENTION_HOURS * 60 * 60 * 1000;
  const cutoffTimestamp = Date.now() - retentionMillis;

  try {
    const result = cleanupOldPoemsStmt.run(cutoffTimestamp);
    if (result.changes > 0) {
      console.log(`🗑️  Cleaned up ${result.changes} old poem(s)`);
    }
  } catch (error) {
    console.error('❌ Error cleaning up old poems:', error.message);
  }
}

// Generate and cache poem for specific time
async function generateAndCachePoem(date) {
  const timeString = formatTime(date);
  const minute = date.getMinutes();
  const timestamp = date.getTime();

  const poem = await generatePoemFromAPI(timeString);

  // Update current poem cache
  currentPoem = {
    timeString,
    poem,
    timestamp,
    minute
  };

  // Save to database
  savePoemToDatabase(timeString, poem, timestamp);

  return poem;
}

// Prefetch next minute's poem
async function prefetchNextMinute() {
  const now = new Date();
  const nextMinute = new Date(now);
  nextMinute.setMinutes(nextMinute.getMinutes() + 1);
  nextMinute.setSeconds(0);
  nextMinute.setMilliseconds(0);

  const nextMinuteValue = nextMinute.getMinutes();

  // Only prefetch if we haven't already
  if (nextPoem.minute !== nextMinuteValue) {
    console.log(`🔮 Prefetching poem for next minute: ${nextMinuteValue}`);
    const timeString = formatTime(nextMinute);
    const poem = await generatePoemFromAPI(timeString);

    nextPoem = {
      poem,
      minute: nextMinuteValue,
      timeString,
      timestamp: nextMinute.getTime()
    };

    console.log(`✅ Prefetch complete for minute: ${nextMinuteValue}`);
  }
}

// Background poem generator - runs every second
function startPoemGenerator() {
  console.log('🎬 Starting background poem generator...');

  setInterval(async () => {
    const now = new Date();
    const currentMinute = now.getMinutes();
    const currentSeconds = now.getSeconds();

    // At 45 seconds, prefetch next minute's poem
    if (currentSeconds === 45) {
      prefetchNextMinute();
    }

    // At the start of a new minute (0 seconds)
    if (currentSeconds === 0 && currentMinute !== currentPoem.minute) {
      console.log(`\n🕐 Minute changed to: ${currentMinute}`);

      // Check if we have a prefetched poem
      if (nextPoem.minute === currentMinute && nextPoem.poem) {
        console.log(`✨ Using prefetched poem for minute: ${currentMinute}`);
        currentPoem = {
          timeString: nextPoem.timeString,
          poem: nextPoem.poem,
          timestamp: nextPoem.timestamp,
          minute: currentMinute
        };

        // Save prefetched poem to database
        savePoemToDatabase(nextPoem.timeString, nextPoem.poem, nextPoem.timestamp);

        // Clear prefetch cache
        nextPoem = { poem: '', minute: -1 };
      } else {
        // Fallback: generate on demand
        console.log(`⚠️  No prefetched poem, generating on demand...`);
        await generateAndCachePoem(now);
      }

      // Cleanup old poems every hour (at minute 0)
      if (currentMinute === 0) {
        cleanupOldPoems();
      }
    }
  }, 1000); // Check every second

  // Generate initial poem on startup
  const now = new Date();
  generateAndCachePoem(now).then(() => {
    console.log('✅ Initial poem generated');
    // Start prefetch after initial generation
    setTimeout(() => {
      prefetchNextMinute();
    }, 2000);
  });
}

// API endpoint to get current poem
app.get('/api/current-poem', (req, res) => {
  if (!currentPoem.poem) {
    return res.status(503).json({
      error: 'Poem not ready yet',
      message: 'Server is initializing, please try again in a moment'
    });
  }

  res.json({
    poem: currentPoem.poem,
    timeString: currentPoem.timeString,
    timestamp: currentPoem.timestamp
  });
});

// API endpoint to get poem history
app.get('/api/poem-history', (req, res) => {
  const limit = parseInt(req.query.limit || '60', 10); // Default to 60 poems (1 hour)

  try {
    const poems = getPoemHistoryStmt.all(limit);
    res.json({
      poems,
      count: poems.length,
      retentionHours: POEM_RETENTION_HOURS
    });
  } catch (error) {
    console.error('❌ Error fetching poem history:', error.message);
    res.status(500).json({
      error: 'Failed to fetch poem history',
      message: error.message
    });
  }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    model: OPENROUTER_MODEL,
    timestamp: new Date().toISOString(),
    currentPoem: currentPoem.timeString || 'Initializing...',
    retentionHours: POEM_RETENTION_HOURS
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
  console.log(`💾 Database retention: ${POEM_RETENTION_HOURS} hours`);
  console.log(`🌐 Open http://localhost:${PORT} in your browser\n`);

  // Start background poem generator
  startPoemGenerator();
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n👋 Shutting down gracefully...');
  db.close();
  process.exit(0);
});
