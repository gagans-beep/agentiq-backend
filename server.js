require('dotenv').config();
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3001;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

if (!ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY missing'); process.exit(1);
}

app.use(cors({ origin: process.env.FRONTEND_URL || '*', methods: ['GET','POST'] }));
app.use(express.json({ limit: '6mb' }));
const limiter = rateLimit({ windowMs: 15*60*1000, max: 100, message: { error: 'Too many requests.' } });
app.use('/api/', limiter);

app.get('/', (req, res) => res.json({ status:'ok', service:'AgentIQ API', version:'4.0.0' }));

async function callClaude(system, messages, maxTokens=800) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type':'application/json', 'x-api-key':ANTHROPIC_API_KEY, 'anthropic-version':'2023-06-01' },
    body: JSON.stringify({ model:'claude-sonnet-4-5', max_tokens:maxTokens, system, messages })
  });
  if (!response.ok) {
    const err = await response.json();
    throw new Error(err.error?.message || `API error ${response.status}`);
  }
  const data = await response.json();
  return data.content?.[0]?.text || '';
}

// ── Training chat ──
app.post('/api/chat', async (req, res) => {
  const { scenario, mood, moodPrompt, moodName, history, isOpening, sop } = req.body;
  if (!scenario || !mood) return res.status(400).json({ error: 'Missing required fields.' });

  const sopSection = sop
    ? `\n\nCOMPANY POLICY / SOP:\n${sop.slice(0,3000)}\nYou are aware of these policies. If the agent violates them, react accordingly.`
    : '';

  const system = `You are roleplaying as a customer in a live support chat.
Scenario: ${scenario}
Your name is ${moodName}. ${moodPrompt}${sopSection}
${isOpening
  ? 'Open the conversation by describing your issue naturally in 1-3 sentences.'
  : 'Respond to the agent. Stay in character. React based on how well they handle you. Keep replies to 1-4 sentences.'
}
Never break character. Never say you are an AI.`;

  const messages = isOpening ? [{ role:'user', content:'Start the conversation.' }] : history;
  try {
    const reply = await callClaude(system, messages, 400);
    res.json({ reply });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Generate scenarios from SOP ──
app.post('/api/generate-scenarios', async (req, res) => {
  const { sop } = req.body;
  if (!sop || sop.trim().length < 50) return res.status(400).json({ error: 'SOP too short.' });

  const prompt = `You are a customer service trainer. Read this SOP and generate 6 realistic training scenarios that test whether agents follow these SPECIFIC policies.

SOP:
${sop.slice(0,4000)}

Each scenario must be DIRECTLY based on an actual rule in this SOP. Return ONLY valid JSON array:
[{"id":"sop_1","icon":"💳","title":"Short title","desc":"One line","diff":"Easy","diffClass":"diff-easy","brief":"Detailed situation referencing specific policy","hints":["hint 1","hint 2","hint 3"],"sopGenerated":true}]
diffClass: diff-easy/diff-medium/diff-hard`;

  try {
    const raw = await callClaude('Return only valid JSON array.', [{ role:'user', content:prompt }], 2000);
    const scenarios = JSON.parse(raw.replace(/```json|```/g,'').trim());
    res.json({ scenarios });
  } catch(e) { res.status(500).json({ error: 'Could not generate scenarios.' }); }
});

// ── QA Score — IMPROVED PROMPT ──
app.post('/api/qa-score', async (req, res) => {
  const { sop, chat, scorecard, agentName, agentId } = req.body;
  if (!chat || !scorecard?.length) return res.status(400).json({ error: 'Missing chat or scorecard.' });

  const totalMax = scorecard.reduce((s,p) => s+p.max, 0);
  const scorecardText = scorecard.map(p =>
    `- "${p.name}": max ${p.max} pts, pass at ${p.pass} pts`
  ).join('\n');

  // IMPROVED PROMPT: forces Claude to quote the transcript before scoring each parameter
  const evalPrompt = `You are a strict, accurate customer service QA analyst. Your job is to score this chat ONLY based on what was ACTUALLY SAID in the transcript — not what you assume happened.

${sop ? `COMPANY SOP / POLICY:\n${sop.slice(0,3500)}\n\n` : ''}CHAT TRANSCRIPT:
${chat.slice(0,4000)}

SCORECARD (${totalMax} total points):
${scorecardText}

INSTRUCTIONS:
1. Read the full transcript carefully first.
2. For EACH parameter, find the specific lines in the transcript that are relevant.
3. Score ONLY what you can see happened — if something is missing, score it low.
4. good_quote and bad_quote must be ACTUAL QUOTES copied from the transcript above (or null if none).
5. total_score must equal the exact sum of all scored values.
6. Be honest and strict — a 90+ score means the agent was excellent on EVERY parameter.

Return ONLY valid JSON, no markdown:
{
  "total_score": 68,
  "grade": "Needs Improvement",
  "summary": "One accurate sentence based on what happened in the chat.",
  "parameters": [
    {
      "name": "exact parameter name from scorecard",
      "max": 20,
      "pass": 14,
      "scored": 12,
      "reason": "2-3 sentences explaining what the agent DID or DIDN'T do, with specific reference to the transcript.",
      "good_quote": "exact quote from transcript that earned points, or null",
      "bad_quote": "exact quote from transcript showing what was wrong, or null"
    }
  ],
  "sop_violations": [
    "Specific policy from SOP that was violated, and which line in the transcript violated it"
  ],
  "coaching": "3 specific, actionable coaching points based on what actually happened in this chat."
}`;

  try {
    const raw = await callClaude(
      'You are a strict QA analyst. Score ONLY what you see in the transcript. Return only valid JSON.',
      [{ role:'user', content:evalPrompt }],
      2000
    );
    const result = JSON.parse(raw.replace(/```json|```/g,'').trim());
    res.json(result);
  } catch(e) {
    console.error('QA score error:', e.message);
    res.status(500).json({ error: 'Could not score the chat. Please try again.' });
  }
});

// ── Webhook auto-score ──
app.post('/api/webhook', async (req, res) => {
  const { ticket_id, subject, agent_name, transcript, sop, scorecard } = req.body;
  if (!transcript) return res.status(400).json({ error: 'No transcript provided.' });

  const defaultScorecard = [
    { name:'Greeting & Introduction', max:10, pass:7 },
    { name:'Empathy & Tone', max:20, pass:14 },
    { name:'Problem Understanding', max:20, pass:14 },
    { name:'Resolution Quality', max:25, pass:18 },
    { name:'SOP / Policy Compliance', max:15, pass:12 },
    { name:'Closing & Follow-up', max:10, pass:7 },
  ];

  res.json({ received: true, ticket_id, status: 'queued' });
});

app.listen(PORT, () => console.log(`AgentIQ v4 running on port ${PORT}`));
