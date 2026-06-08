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

app.use(cors({ origin: process.env.FRONTEND_URL || '*', methods: ['GET','POST'] }));
app.use(express.json({ limit: '4mb' }));
const limiter = rateLimit({ windowMs: 15*60*1000, max: 80, message: { error: 'Too many requests.' } });
app.use('/api/', limiter);

app.get('/', (req, res) => res.json({ status:'ok', service:'AgentIQ API', version:'3.0.0' }));

// ── Helper: call Claude ──
async function callClaude(system, messages, maxTokens = 600) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type':'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version':'2023-06-01' },
    body: JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: maxTokens, system, messages })
  });
  if (!response.ok) {
    const err = await response.json();
    throw new Error(err.error?.message || 'Anthropic API error');
  }
  const data = await response.json();
  return data.content?.[0]?.text || '';
}

// ── NEW: Generate scenarios from SOP ──
app.post('/api/generate-scenarios', async (req, res) => {
  const { sop } = req.body;
  if (!sop || sop.trim().length < 50) {
    return res.status(400).json({ error: 'Please provide a more detailed SOP (at least 50 characters).' });
  }

  const prompt = `You are an expert customer service trainer. Read the following company SOP / policy document and generate 6 realistic training scenarios that would test whether a support agent properly understands and follows these specific policies.

SOP / POLICY DOCUMENT:
${sop.slice(0, 4000)}

Generate 6 scenarios that:
1. Are DIRECTLY based on the actual policies in this SOP (not generic scenarios)
2. Cover a range of difficulty levels
3. Test edge cases and tricky situations from the policy
4. Would realistically happen to a customer

Return ONLY valid JSON — no markdown, no backticks, no explanation:
[
  {
    "id": "sop_1",
    "icon": "💳",
    "title": "Short scenario title",
    "desc": "One line description",
    "diff": "Easy",
    "diffClass": "diff-easy",
    "brief": "Detailed situation the customer is in, referencing specific policy details",
    "hints": ["hint 1", "hint 2", "hint 3"],
    "sopGenerated": true
  }
]

Use diffClass: "diff-easy" for Easy, "diff-medium" for Medium, "diff-hard" for Hard.
Use relevant emojis for icons.`;

  try {
    const raw = await callClaude('You are a customer service training expert. Return only valid JSON.', [{ role:'user', content: prompt }], 2000);
    const cleaned = raw.replace(/```json|```/g,'').trim();
    const scenarios = JSON.parse(cleaned);
    res.json({ scenarios });
  } catch(err) {
    console.error('Generate scenarios error:', err);
    res.status(500).json({ error: 'Could not generate scenarios. Please try again.' });
  }
});

// ── Chat endpoint ──
app.post('/api/chat', async (req, res) => {
  const { scenario, mood, moodPrompt, moodName, history, isOpening, sop } = req.body;
  if (!scenario || !mood) return res.status(400).json({ error: 'Missing required fields.' });

  const sopSection = sop
    ? `\n\nCOMPANY POLICY / SOP:\n${sop.slice(0,3000)}\nYou are aware of these policies. If the agent violates them or gives wrong information, react accordingly — question them, push back, or express concern.`
    : '';

  const system = `You are roleplaying as a customer in a live support chat.
Scenario: ${scenario}
Your name is ${moodName}. ${moodPrompt}${sopSection}
${isOpening
  ? 'Open the conversation by describing your issue naturally in 1-3 sentences.'
  : 'Respond to the agent. Stay in character. React naturally — soften if they help well, push back if they are vague or wrong. Keep replies to 1-4 sentences.'
}
Never break character. Never say you are an AI.`;

  const messages = isOpening ? [{ role:'user', content:'Start the conversation.' }] : history;

  try {
    const reply = await callClaude(system, messages, 400);
    res.json({ reply });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Evaluate endpoint ──
app.post('/api/evaluate', async (req, res) => {
  const { scenarioBrief, mood, transcript, sop } = req.body;
  if (!transcript) return res.status(400).json({ error: 'No transcript.' });

  const sopSection = sop
    ? `\n\nCOMPANY SOP PROVIDED:\n${sop.slice(0,3000)}\n\nAlso include "sop_compliance": a 2-3 sentence assessment of how well the agent followed the specific SOP rules.`
    : '';

  const evalPrompt = `You are an expert customer service trainer evaluating a support agent.

Scenario: ${scenarioBrief}
Customer mood: ${mood}${sopSection}

Transcript:
${transcript}

Score across 5 dimensions (0–20 each):
1. Empathy & tone
2. Problem understanding  
3. Resolution quality
4. Communication clarity
5. Professionalism

Return ONLY valid JSON:
{"total":78,"grade":"Good","summary":"One sentence.","rubric":{"Empathy & tone":16,"Problem understanding":15,"Resolution quality":14,"Communication clarity":17,"Professionalism":16},"strengths":["s1","s2"],"improvements":["i1","i2"],"coaching":"2-3 sentences of specific advice."${sop ? ',"sop_compliance":"SOP compliance feedback."' : ''}}`;

  try {
    const raw = await callClaude('You are a customer service training expert. Return only valid JSON.', [{ role:'user', content: evalPrompt }], 1000);
    const cleaned = raw.replace(/```json|```/g,'').trim();
    res.json(JSON.parse(cleaned));
  } catch(err) {
    res.status(500).json({ error: 'Could not evaluate session.' });
  }
});

app.listen(PORT, () => console.log(`✅  AgentIQ v3 running on port ${PORT}`));
