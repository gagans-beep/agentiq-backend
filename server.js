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
app.use(express.json({ limit: '2mb' }));

const limiter = rateLimit({ windowMs: 15*60*1000, max: 60, message: { error: 'Too many requests.' } });
app.use('/api/', limiter);

app.get('/', (req, res) => res.json({ status:'ok', service:'AgentIQ API', version:'2.0.0' }));

// ── Chat endpoint ──
app.post('/api/chat', async (req, res) => {
  const { scenario, mood, moodPrompt, moodName, history, isOpening, sop } = req.body;
  if (!scenario || !mood) return res.status(400).json({ error: 'Missing required fields.' });

  const sopSection = sop
    ? `\n\nCOMPANY POLICY / SOP (you are aware of these policies as the customer — if the agent violates them, push back or question them):\n${sop.slice(0, 3000)}`
    : '';

  const system = `You are roleplaying as a customer in a live support chat session.
Scenario: ${scenario}
Your name is ${moodName}. ${moodPrompt}${sopSection}
${isOpening
  ? 'Open the conversation by describing your issue in 1-3 sentences. Be natural — speak as a real person would.'
  : 'Respond to the support agent. Stay fully in character. If a SOP is provided, you are aware of the company\'s policies — if the agent gives wrong information or violates policy, react accordingly. React naturally to how well they handle you. Keep replies to 1-4 sentences.'
}
Never break character. Never say you are an AI.`;

  const messages = isOpening ? [{ role:'user', content:'Start the conversation.' }] : history;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type':'application/json', 'x-api-key':ANTHROPIC_API_KEY, 'anthropic-version':'2023-06-01' },
      body: JSON.stringify({ model:'claude-sonnet-4-5', max_tokens:400, system, messages })
    });
    if (!response.ok) { const err = await response.json(); return res.status(response.status).json({ error: err.error?.message }); }
    const data = await response.json();
    res.json({ reply: data.content?.[0]?.text || '' });
  } catch(err) {
    res.status(500).json({ error: 'Server error.' });
  }
});

// ── Evaluate endpoint ──
app.post('/api/evaluate', async (req, res) => {
  const { scenarioBrief, mood, transcript, sop } = req.body;
  if (!transcript) return res.status(400).json({ error: 'No transcript.' });

  const sopSection = sop
    ? `\n\nCOMPANY SOP / POLICY PROVIDED:\n${sop.slice(0, 3000)}\n\nAlso add a "sop_compliance" field in your JSON — 2-3 sentences assessing how well the agent followed the company's specific SOP/policy rules.`
    : '';

  const evalPrompt = `You are an expert customer service trainer evaluating an agent's chat performance.

Scenario: ${scenarioBrief}
Customer mood: ${mood}${sopSection}

Full transcript:
${transcript}

Score the agent across 5 dimensions (0–20 each, 100 total):
1. Empathy & tone
2. Problem understanding
3. Resolution quality
4. Communication clarity
5. Professionalism

Return ONLY valid JSON — no markdown, no backticks:
{"total":78,"grade":"Good","summary":"One-sentence overall summary.","rubric":{"Empathy & tone":16,"Problem understanding":15,"Resolution quality":14,"Communication clarity":17,"Professionalism":16},"strengths":["strength one","strength two"],"improvements":["area one","area two"],"coaching":"2-3 sentences of specific actionable coaching advice."${sop ? ',"sop_compliance":"How well the agent followed the company SOP."' : ''}}`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type':'application/json', 'x-api-key':ANTHROPIC_API_KEY, 'anthropic-version':'2023-06-01' },
      body: JSON.stringify({ model:'claude-sonnet-4-5', max_tokens:1000, messages:[{ role:'user', content:evalPrompt }] })
    });
    if (!response.ok) { const err = await response.json(); return res.status(response.status).json({ error: err.error?.message }); }
    const data = await response.json();
    let raw = (data.content?.[0]?.text || '{}').replace(/```json|```/g,'').trim();
    res.json(JSON.parse(raw));
  } catch(err) {
    res.status(500).json({ error: 'Could not evaluate.' });
  }
});

app.listen(PORT, () => console.log(`✅  AgentIQ v2 running on port ${PORT}`));
