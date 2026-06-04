require('dotenv').config();
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3001;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

if (!ANTHROPIC_API_KEY) {
  console.error('❌  ANTHROPIC_API_KEY is missing from .env');
  process.exit(1);
}

// ── Middleware ──
app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  methods: ['GET', 'POST'],
}));
app.use(express.json());

// ── Rate limiting: 60 requests per IP per 15 minutes ──
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  message: { error: 'Too many requests — please slow down and try again shortly.' }
});
app.use('/api/', limiter);

// ── Health check ──
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'AgentIQ API', version: '1.0.0' });
});

// ── Chat endpoint: AI customer replies ──
app.post('/api/chat', async (req, res) => {
  const { scenario, mood, moodPrompt, moodName, history, isOpening } = req.body;

  if (!scenario || !mood) {
    return res.status(400).json({ error: 'Missing required fields: scenario, mood' });
  }

  const system = `You are roleplaying as a customer in a live support chat session.
Scenario: ${scenario}
Your name is ${moodName}. ${moodPrompt}
${isOpening
  ? 'Open the conversation by describing your issue in 1-3 sentences. Be natural — speak as a real person would, not a list of bullet points.'
  : 'Respond to the support agent. Stay fully in character. React naturally — if they are empathetic and helpful, soften slightly. If they are vague or unhelpful, push back. Do NOT resolve the issue unless the agent has genuinely addressed it well. Keep replies to 1-4 sentences.'
}
Never break character. Never say you are an AI.`;

  const messages = isOpening
    ? [{ role: 'user', content: 'Start the conversation.' }]
    : history;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 400,
        system,
        messages
      })
    });

    if (!response.ok) {
      const err = await response.json();
      return res.status(response.status).json({ error: err.error?.message || 'Anthropic API error' });
    }

    const data = await response.json();
    const text = data.content?.[0]?.text || '';
    res.json({ reply: text });

  } catch (err) {
    console.error('Chat error:', err);
    res.status(500).json({ error: 'Server error — please try again.' });
  }
});

// ── Evaluate endpoint: score the session ──
app.post('/api/evaluate', async (req, res) => {
  const { scenarioBrief, mood, transcript } = req.body;

  if (!transcript || transcript.length === 0) {
    return res.status(400).json({ error: 'No transcript provided.' });
  }

  const evalPrompt = `You are an expert customer service trainer evaluating an agent's chat performance.

Scenario: ${scenarioBrief}
Customer mood: ${mood}

Full transcript:
${transcript}

Score the agent across 5 dimensions (0–20 each, 100 total):
1. Empathy & tone
2. Problem understanding
3. Resolution quality
4. Communication clarity
5. Professionalism

Return ONLY valid JSON — no markdown, no explanation, no backticks:
{"total":78,"grade":"Good","summary":"One-sentence overall summary.","rubric":{"Empathy & tone":16,"Problem understanding":15,"Resolution quality":14,"Communication clarity":17,"Professionalism":16},"strengths":["strength one","strength two"],"improvements":["area one","area two"],"coaching":"2-3 sentences of specific actionable coaching advice tailored to this transcript."}`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 800,
        messages: [{ role: 'user', content: evalPrompt }]
      })
    });

    if (!response.ok) {
      const err = await response.json();
      return res.status(response.status).json({ error: err.error?.message || 'Anthropic API error' });
    }

    const data = await response.json();
    let raw = (data.content?.[0]?.text || '{}').replace(/```json|```/g, '').trim();
    const result = JSON.parse(raw);
    res.json(result);

  } catch (err) {
    console.error('Evaluate error:', err);
    res.status(500).json({ error: 'Could not evaluate session.' });
  }
});

app.listen(PORT, () => {
  console.log(`✅  AgentIQ backend running on port ${PORT}`);
});
