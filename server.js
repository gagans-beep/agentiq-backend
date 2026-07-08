require('dotenv').config();
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3001;

// ── Clients ──
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

if (!process.env.ANTHROPIC_API_KEY) { console.error('Missing ANTHROPIC_API_KEY'); process.exit(1); }
if (!process.env.SUPABASE_URL) { console.error('Missing SUPABASE_URL'); process.exit(1); }

app.use(cors({ origin: process.env.FRONTEND_URL || '*', methods: ['GET','POST','PUT','DELETE'] }));
app.use(express.json({ limit: '8mb' }));
app.use('/api/', rateLimit({ windowMs: 15*60*1000, max: 200, message: { error: 'Too many requests.' } }));

// ── Claude helper ──
async function callClaude(system, messages, maxTokens=1000) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type':'application/json', 'x-api-key':process.env.ANTHROPIC_API_KEY, 'anthropic-version':'2023-06-01' },
    body: JSON.stringify({ model:'claude-sonnet-4-5', max_tokens:maxTokens, system, messages })
  });
  if (!res.ok) { const e = await res.json(); throw new Error(e.error?.message || 'Claude API error'); }
  const data = await res.json();
  return data.content?.[0]?.text || '';
}

// ── Auth middleware ──
async function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token provided' });
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return res.status(401).json({ error: 'Invalid token' });
  req.user = user;
  // Get company_id from users table
  const { data: userData } = await supabase.from('users').select('*').eq('id', user.id).single();
  req.userData = userData;
  next();
}

app.get('/', (req, res) => res.json({ status:'ok', service:'AgentIQ API', version:'4.0.0' }));

// ════════════════════════════════
// AUTH ENDPOINTS
// ════════════════════════════════

// Sign up
app.post('/api/auth/signup', async (req, res) => {
  const { email, password, name, company_name } = req.body;
  if (!email || !password || !name || !company_name)
    return res.status(400).json({ error: 'All fields required.' });
  try {
    // Create auth user
    const { data: authData, error: authError } = await supabase.auth.admin.createUser({
      email, password, email_confirm: true,
      user_metadata: { name }
    });
    if (authError) return res.status(400).json({ error: authError.message });

    // Create company
    const { data: company, error: companyError } = await supabase
      .from('companies').insert({ name: company_name, plan: 'free' }).select().single();
    if (companyError) throw companyError;

    // Create user record
    await supabase.from('users').insert({
      id: authData.user.id, email, name,
      company_id: company.id, role: 'admin'
    });

    res.json({ message: 'Account created successfully. Please log in.' });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Login
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required.' });
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) return res.status(401).json({ error: 'Invalid email or password.' });

  const { data: userData } = await supabase.from('users').select('*, companies(*)').eq('id', data.user.id).single();
  res.json({ token: data.session.access_token, user: userData });
});

// Get current user
app.get('/api/auth/me', authMiddleware, async (req, res) => {
  const { data } = await supabase.from('users').select('*, companies(*)').eq('id', req.user.id).single();
  res.json(data);
});

// ════════════════════════════════
// AGENTS
// ════════════════════════════════

app.get('/api/agents', authMiddleware, async (req, res) => {
  const { data, error } = await supabase.from('agents')
    .select('*').eq('company_id', req.userData.company_id).order('name');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post('/api/agents', authMiddleware, async (req, res) => {
  const { name, agent_code, team, role } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required.' });
  const { data, error } = await supabase.from('agents')
    .insert({ name, agent_code, team, role, company_id: req.userData.company_id }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.delete('/api/agents/:id', authMiddleware, async (req, res) => {
  await supabase.from('agents').delete().eq('id', req.params.id).eq('company_id', req.userData.company_id);
  res.json({ success: true });
});

// ════════════════════════════════
// SOPs
// ════════════════════════════════

app.get('/api/sops', authMiddleware, async (req, res) => {
  const { data, error } = await supabase.from('sops')
    .select('*').eq('company_id', req.userData.company_id).order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post('/api/sops', authMiddleware, async (req, res) => {
  const { name, text } = req.body;
  if (!name || !text) return res.status(400).json({ error: 'Name and text required.' });
  const { data, error } = await supabase.from('sops')
    .insert({ name, text, company_id: req.userData.company_id, created_by: req.user.id }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.put('/api/sops/:id', authMiddleware, async (req, res) => {
  const { name, text } = req.body;
  const { data, error } = await supabase.from('sops')
    .update({ name, text, updated_at: new Date() }).eq('id', req.params.id)
    .eq('company_id', req.userData.company_id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.delete('/api/sops/:id', authMiddleware, async (req, res) => {
  await supabase.from('sops').delete().eq('id', req.params.id).eq('company_id', req.userData.company_id);
  res.json({ success: true });
});

// ════════════════════════════════
// SCORECARDS
// ════════════════════════════════

app.get('/api/scorecards', authMiddleware, async (req, res) => {
  const { data } = await supabase.from('scorecards')
    .select('*').eq('company_id', req.userData.company_id).order('created_at', { ascending: false });
  res.json(data || []);
});

app.post('/api/scorecards', authMiddleware, async (req, res) => {
  const { name, parameters } = req.body;
  if (!name || !parameters) return res.status(400).json({ error: 'Name and parameters required.' });
  const { data, error } = await supabase.from('scorecards')
    .insert({ name, parameters, company_id: req.userData.company_id, created_by: req.user.id }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.delete('/api/scorecards/:id', authMiddleware, async (req, res) => {
  await supabase.from('scorecards').delete().eq('id', req.params.id).eq('company_id', req.userData.company_id);
  res.json({ success: true });
});

// ════════════════════════════════
// QA SESSIONS
// ════════════════════════════════

app.get('/api/qa-sessions', authMiddleware, async (req, res) => {
  const { agent_id, limit = 50 } = req.query;
  let query = supabase.from('qa_sessions')
    .select('*, agents(name, team, agent_code)')
    .eq('company_id', req.userData.company_id)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (agent_id) query = query.eq('agent_id', agent_id);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post('/api/qa-sessions', authMiddleware, async (req, res) => {
  const { agent_id, transcript, score, grade, parameters, sop_violations, oms_discrepancies, coaching, source, sop_id, scorecard_id, ticket_ref } = req.body;
  const { data, error } = await supabase.from('qa_sessions').insert({
    company_id: req.userData.company_id,
    agent_id, transcript, score, grade,
    parameters, sop_violations, oms_discrepancies,
    coaching, source, sop_id, scorecard_id, ticket_ref,
    scored_by: req.user.id
  }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ════════════════════════════════
// TRAINING SESSIONS
// ════════════════════════════════

app.get('/api/training-sessions', authMiddleware, async (req, res) => {
  const { agent_id, limit = 50 } = req.query;
  let query = supabase.from('training_sessions')
    .select('*, agents(name, team)')
    .eq('company_id', req.userData.company_id)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (agent_id) query = query.eq('agent_id', agent_id);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post('/api/training-sessions', authMiddleware, async (req, res) => {
  const { agent_id, scenario, mood, score, grade, coaching } = req.body;
  const { data, error } = await supabase.from('training_sessions').insert({
    company_id: req.userData.company_id,
    agent_id, scenario, mood, score, grade, coaching
  }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ════════════════════════════════
// CONNECTORS (Zendesk, Freshdesk etc)
// ════════════════════════════════

app.get('/api/connectors', authMiddleware, async (req, res) => {
  const { data } = await supabase.from('connectors')
    .select('id, type, config_public, active, created_at')
    .eq('company_id', req.userData.company_id);
  res.json(data || []);
});

app.post('/api/connectors', authMiddleware, async (req, res) => {
  const { type, config } = req.body;
  // Store sensitive keys only server-side
  const configPublic = { type, subdomain: config.subdomain, email: config.email };
  const { data, error } = await supabase.from('connectors').upsert({
    company_id: req.userData.company_id, type,
    config_public: configPublic, config_secret: config,
    active: true
  }, { onConflict: 'company_id,type' }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, id: data.id });
});

// Test + fetch from Zendesk (server-side — no CORS issues)
app.post('/api/connectors/zendesk/fetch', authMiddleware, async (req, res) => {
  const { subdomain, email, token, count = 10, status = 'solved' } = req.body;
  if (!subdomain || !email || !token) return res.status(400).json({ error: 'Missing credentials.' });
  try {
    const creds = Buffer.from(`${email}/token:${token}`).toString('base64');
    const statusFilter = status !== 'all' ? ` status:${status}` : '';
    const url = `https://${subdomain}.zendesk.com/api/v2/search.json?query=type:ticket${statusFilter}&sort_by=created_at&sort_order=desc&per_page=${count}`;
    const r = await fetch(url, { headers: { 'Authorization': `Basic ${creds}` } });
    if (!r.ok) {
      const e = await r.json();
      return res.status(r.status).json({ error: e.error || `Zendesk error ${r.status}` });
    }
    const data = await r.json();
    // Fetch comments for each ticket
    const tickets = await Promise.all((data.results || []).map(async t => {
      try {
        const cr = await fetch(`https://${subdomain}.zendesk.com/api/v2/tickets/${t.id}/comments.json`,
          { headers: { 'Authorization': `Basic ${creds}` } });
        const cd = await cr.json();
        const transcript = (cd.comments || []).map(c =>
          `${c.via?.source?.from?.name || 'Agent'}: ${c.plain_body || ''}`
        ).filter(l => l.trim()).join('\n');
        return { id: t.id, subject: t.subject, status: t.status, created: t.created_at, transcript };
      } catch { return { id: t.id, subject: t.subject, status: t.status, created: t.created_at, transcript: '' }; }
    }));
    res.json({ tickets });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Fetch from Freshdesk (server-side)
app.post('/api/connectors/freshdesk/fetch', authMiddleware, async (req, res) => {
  const { subdomain, api_key, count = 10, status = 'resolved' } = req.body;
  if (!subdomain || !api_key) return res.status(400).json({ error: 'Missing credentials.' });
  try {
    const creds = Buffer.from(`${api_key}:X`).toString('base64');
    const statusMap = { resolved: 4, closed: 5 };
    const statusParam = statusMap[status] ? `&status=${statusMap[status]}` : '';
    const url = `https://${subdomain}.freshdesk.com/api/v2/tickets?per_page=${count}${statusParam}&order_by=created_at&order_type=desc`;
    const r = await fetch(url, { headers: { 'Authorization': `Basic ${creds}` } });
    if (!r.ok) return res.status(r.status).json({ error: `Freshdesk error ${r.status} — check API key` });
    const tickets = await r.json();
    const result = await Promise.all(tickets.map(async t => {
      try {
        const cr = await fetch(`https://${subdomain}.freshdesk.com/api/v2/tickets/${t.id}/conversations`,
          { headers: { 'Authorization': `Basic ${creds}` } });
        const convs = await cr.json();
        const transcript = (convs || []).map(c =>
          `${c.incoming ? 'Customer' : 'Agent'}: ${c.body_text || ''}`
        ).filter(l => l.trim()).join('\n');
        return { id: t.id, subject: t.subject, status: t.status, created: t.created_at, transcript };
      } catch { return { id: t.id, subject: t.subject, status: t.status, created: t.created_at, transcript: '' }; }
    }));
    res.json({ tickets: result });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Intercom (server-side)
app.post('/api/connectors/intercom/fetch', authMiddleware, async (req, res) => {
  const { access_token, count = 10 } = req.body;
  if (!access_token) return res.status(400).json({ error: 'Missing access token.' });
  try {
    const r = await fetch(`https://api.intercom.io/conversations?per_page=${count}&order=desc`, {
      headers: { 'Authorization': `Bearer ${access_token}`, 'Accept': 'application/json' }
    });
    if (!r.ok) return res.status(r.status).json({ error: `Intercom error ${r.status}` });
    const data = await r.json();
    const tickets = (data.conversations || []).map(c => {
      const parts = c.conversation_parts?.conversation_parts || [];
      const transcript = [
        `Customer: ${c.conversation_message?.body || ''}`,
        ...parts.map(p => `${p.author?.type === 'admin' ? 'Agent' : 'Customer'}: ${p.body || ''}`)
      ].filter(l => l.trim()).join('\n');
      return { id: c.id, subject: c.conversation_message?.subject || `Conversation ${c.id}`, status: c.state, created: new Date(c.created_at*1000).toISOString(), transcript };
    });
    res.json({ tickets });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Custom API connector (server-side)
app.post('/api/connectors/custom/fetch', authMiddleware, async (req, res) => {
  const { url, auth_type, token, transcript_field, title_field, count } = req.body;
  if (!url) return res.status(400).json({ error: 'API URL required.' });
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (token) {
      if (auth_type === 'bearer') headers['Authorization'] = `Bearer ${token}`;
      else if (auth_type === 'apikey') headers['X-API-Key'] = token;
      else if (auth_type === 'basic') headers['Authorization'] = `Basic ${Buffer.from(token).toString('base64')}`;
    }
    const r = await fetch(`${url}${count ? `?limit=${count}` : ''}`, { headers });
    if (!r.ok) throw new Error(`API returned ${r.status}`);
    const data = await r.json();
    const items = Array.isArray(data) ? data : (data.data || data.results || data.conversations || data.tickets || [data]);
    const tickets = items.map((item, i) => ({
      id: item.id || item[title_field] || i,
      subject: item[title_field] || item.subject || item.title || `Item ${i+1}`,
      status: item.status || 'unknown',
      created: item.created_at || new Date().toISOString(),
      transcript: typeof item[transcript_field] === 'string' ? item[transcript_field] : JSON.stringify(item[transcript_field] || item)
    }));
    res.json({ tickets });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════
// WEBHOOK — real-time auto-score
// ════════════════════════════════

app.post('/api/webhook/:company_id', async (req, res) => {
  const { company_id } = req.params;
  const { ticket_id, subject, agent_name, transcript } = req.body;
  if (!transcript) return res.status(400).json({ error: 'No transcript.' });

  // Acknowledge immediately
  res.json({ received: true, ticket_id });

  // Process async
  try {
    // Get company's default SOP and scorecard
    const { data: sops } = await supabase.from('sops').select('*').eq('company_id', company_id).limit(1);
    const { data: scorecards } = await supabase.from('scorecards').select('*').eq('company_id', company_id).limit(1);

    const sop = sops?.[0]?.text || '';
    const scorecard = scorecards?.[0]?.parameters || [
      { name:'Empathy & Tone', max:20, pass:14 },
      { name:'Problem Understanding', max:20, pass:14 },
      { name:'Resolution Quality', max:25, pass:18 },
      { name:'SOP Compliance', max:15, pass:12 },
      { name:'Communication', max:10, pass:7 },
      { name:'Closing', max:10, pass:7 },
    ];

    const result = await scoreChat(transcript, sop, scorecard);

    // Find or create agent
    let agentId = null;
    if (agent_name) {
      const { data: existingAgent } = await supabase.from('agents')
        .select('id').eq('company_id', company_id).eq('name', agent_name).single();
      if (existingAgent) { agentId = existingAgent.id; }
      else {
        const { data: newAgent } = await supabase.from('agents')
          .insert({ company_id, name: agent_name }).select().single();
        agentId = newAgent?.id;
      }
    }

    // Save QA session
    await supabase.from('qa_sessions').insert({
      company_id, agent_id: agentId,
      transcript, ticket_ref: ticket_id,
      score: result.total_score, grade: result.grade,
      parameters: result.parameters,
      sop_violations: result.sop_violations,
      coaching: result.coaching,
      source: 'webhook'
    });
  } catch(e) { console.error('Webhook processing error:', e.message); }
});

// ════════════════════════════════
// AI ENDPOINTS
// ════════════════════════════════

// Chat (training)
app.post('/api/chat', async (req, res) => {
  const { scenario, mood, moodPrompt, moodName, history, isOpening, sop } = req.body;
  const sopSection = sop ? `\n\nCOMPANY POLICY:\n${sop.slice(0,3000)}` : '';
  const system = `You are roleplaying as a customer in a live support chat.
Scenario: ${scenario}. Your name is ${moodName}. ${moodPrompt}${sopSection}
${isOpening ? 'Open with your issue in 1-3 sentences.' : 'Respond naturally. Stay in character. Keep replies to 1-4 sentences.'}
Never break character.`;
  try {
    const reply = await callClaude(system, isOpening ? [{ role:'user', content:'Start.' }] : history, 400);
    res.json({ reply });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Generate scenarios from SOP
app.post('/api/generate-scenarios', async (req, res) => {
  const { sop } = req.body;
  if (!sop) return res.status(400).json({ error: 'SOP required.' });
  try {
    const raw = await callClaude('Return only valid JSON array.', [{
      role:'user', content:`Generate 6 training scenarios based on this SOP. Return ONLY a JSON array:
[{"id":"s1","icon":"💳","title":"Short title","desc":"One line","diff":"Easy","diffClass":"diff-easy","brief":"Detailed situation","hints":["h1","h2","h3"],"sopGenerated":true}]
SOP: ${sop.slice(0,4000)}`
    }], 2000);
    res.json({ scenarios: JSON.parse(raw.replace(/```json|```/g,'').trim()) });
  } catch(e) { res.status(500).json({ error: 'Could not generate scenarios.' }); }
});

// QA Score
app.post('/api/qa-score', async (req, res) => {
  const { sop, chat, scorecard, agentName, omsContext } = req.body;
  if (!chat || !scorecard?.length) return res.status(400).json({ error: 'Missing chat or scorecard.' });
  try {
    const result = await scoreChat(chat, sop || '', scorecard, omsContext);
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Extract order ID
app.post('/api/extract-order-id', async (req, res) => {
  const { transcript } = req.body;
  try {
    const raw = await callClaude('Return only valid JSON.', [{
      role:'user', content:`Extract order/ticket ID from this chat. Return: {"order_id":"ID or null"}\n\n${transcript?.slice(0,2000)}`
    }], 100);
    res.json(JSON.parse(raw.replace(/```json|```/g,'').trim()));
  } catch { res.json({ order_id: null }); }
});

// ════════════════════════════════
// DASHBOARD STATS
// ════════════════════════════════

app.get('/api/stats', authMiddleware, async (req, res) => {
  const company_id = req.userData.company_id;
  try {
    const [
      { count: agentCount },
      { data: qaSessions },
      { data: trainingSessions },
      { count: certCount }
    ] = await Promise.all([
      supabase.from('agents').select('*', { count:'exact', head:true }).eq('company_id', company_id),
      supabase.from('qa_sessions').select('score, agent_id, created_at').eq('company_id', company_id).order('created_at', { ascending: false }).limit(200),
      supabase.from('training_sessions').select('score, agent_id, created_at').eq('company_id', company_id).order('created_at', { ascending: false }).limit(200),
      supabase.from('certifications').select('*', { count:'exact', head:true }).eq('company_id', company_id)
    ]);

    const allSessions = [...(qaSessions||[]), ...(trainingSessions||[])];
    const avgScore = allSessions.length ? Math.round(allSessions.reduce((s,x)=>s+x.score,0)/allSessions.length) : 0;
    const needCoaching = new Set((qaSessions||[]).filter(s=>s.score<70).map(s=>s.agent_id)).size;

    res.json({
      agent_count: agentCount || 0,
      avg_score: avgScore,
      total_sessions: allSessions.length,
      qa_sessions: qaSessions?.length || 0,
      training_sessions: trainingSessions?.length || 0,
      need_coaching: needCoaching,
      cert_count: certCount || 0,
      recent_sessions: qaSessions?.slice(0,10) || []
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Certifications
app.get('/api/certifications', authMiddleware, async (req, res) => {
  const { data } = await supabase.from('certifications')
    .select('*, agents(name, team)').eq('company_id', req.userData.company_id)
    .order('created_at', { ascending: false });
  res.json(data || []);
});

app.post('/api/certifications', authMiddleware, async (req, res) => {
  const { agent_id, name, qualifying_score } = req.body;
  const { data, error } = await supabase.from('certifications').insert({
    company_id: req.userData.company_id, agent_id, name, qualifying_score, awarded_by: req.user.id
  }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.delete('/api/certifications/:id', authMiddleware, async (req, res) => {
  await supabase.from('certifications').delete().eq('id', req.params.id).eq('company_id', req.userData.company_id);
  res.json({ success: true });
});

// ── Core scoring function ──
async function scoreChat(chat, sop, scorecard, omsContext=null) {
  const totalMax = scorecard.reduce((s,p) => s+p.max, 0);
  const scorecardText = scorecard.map(p => `- "${p.name}": max ${p.max} pts, pass at ${p.pass} pts`).join('\n');
  const omsSection = omsContext && !omsContext.error
    ? `\nACTUAL ORDER DATA FROM OMS:\n${JSON.stringify(omsContext,null,2).slice(0,2000)}\nCompare agent's statements against this OMS data.\n` : '';

  const prompt = `You are a strict customer service QA analyst. Score ONLY what is ACTUALLY IN the transcript.

${sop ? `SOP:\n${sop.slice(0,3500)}\n` : ''}${omsSection}
TRANSCRIPT:
${chat.slice(0,4000)}

SCORECARD (${totalMax} pts total):
${scorecardText}

RULES:
1. Read the full transcript first
2. Score only what you can verify happened
3. Quotes must be exact text from transcript
4. total_score = exact sum of all scored values
5. Be strict — 90+ = excellent on every parameter

Return ONLY valid JSON:
{"total_score":68,"grade":"Needs Improvement","summary":"One sentence.","parameters":[{"name":"exact name","max":20,"pass":14,"scored":12,"reason":"What agent did/didn't do.","good_quote":"exact quote or null","bad_quote":"exact quote or null"}],"sop_violations":["specific violation"],"oms_discrepancies":[],"coaching":"3 specific points."}`;

  const raw = await callClaude('Strict QA analyst. Return only valid JSON.', [{ role:'user', content:prompt }], 2000);
  return JSON.parse(raw.replace(/```json|```/g,'').trim());
}

app.listen(PORT, () => console.log(`✅ AgentIQ v4 on port ${PORT}`));
