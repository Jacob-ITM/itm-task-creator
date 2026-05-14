const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const ASANA_TOKEN = process.env.ASANA_TOKEN;
const BOX_CLIENT_ID = process.env.BOX_CLIENT_ID;
const BOX_CLIENT_SECRET = process.env.BOX_CLIENT_SECRET;
const BOX_PARENT_FOLDER_ID = '378152598280';
const ASANA_WORKSPACE = '1209414882370188';
const TOKEN_FILE = path.join('/tmp', 'box_tokens.json');

// Load tokens from file if they exist
let boxTokens = { access_token: null, refresh_token: null };
if (fs.existsSync(TOKEN_FILE)) {
  try {
    boxTokens = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
    console.log('Box tokens loaded from file');
  } catch (e) {
    console.log('Could not load Box tokens from file');
  }
}

function saveTokens(tokens) {
  boxTokens = tokens;
  try {
    fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokens));
    console.log('Box tokens saved to file');
  } catch (e) {
    console.log('Could not save Box tokens to file:', e.message);
  }
}

async function getBoxToken() {
  if (!boxTokens.refresh_token) throw new Error('No Box refresh token available');
  const res = await axios.post('https://api.box.com/oauth2/token', new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: boxTokens.refresh_token,
    client_id: BOX_CLIENT_ID,
    client_secret: BOX_CLIENT_SECRET,
  }));
  saveTokens({
    access_token: res.data.access_token,
    refresh_token: res.data.refresh_token,
  });
  return res.data.access_token;
}

// One-time Box login
app.get('/box/login', (req, res) => {
  const redirectUri = `https://${process.env.RAILWAY_PUBLIC_DOMAIN}/box/callback`;
  const authUrl = `https://account.box.com/api/oauth2/authorize?response_type=code&client_id=${BOX_CLIENT_ID}&redirect_uri=${encodeURIComponent(redirectUri)}`;
  res.redirect(authUrl);
});

// Box callback after login
app.get('/box/callback', async (req, res) => {
  const { code } = req.query;
  const redirectUri = `https://${process.env.RAILWAY_PUBLIC_DOMAIN}/box/callback`;
  try {
    const tokenRes = await axios.post('https://api.box.com/oauth2/token', new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: BOX_CLIENT_ID,
      client_secret: BOX_CLIENT_SECRET,
      redirect_uri: redirectUri,
    }));
    saveTokens({
      access_token: tokenRes.data.access_token,
      refresh_token: tokenRes.data.refresh_token,
    });
    res.send('✅ Box connected successfully! You may return and use the Slack bot.');
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.send('❌ Box authorization failed. Please try again.');
  }
});

app.post('/slack/events', async (req, res) => {
  const body = req.body;
  if (body.type === 'url_verification') return res.json({ challenge: body.challenge });
  res.sendStatus(200);

  const event = body.event;
  if (!event || event.type !== 'message' || event.subtype || !event.text) return;

  const text = event.text.trim();
  if (!text.startsWith('#create')) return;

  const parts = text.split('|').map(p => p.trim());
  const taskName = parts[1] || 'Untitled Task';
  const taskDesc = parts[2] || 'No description provided.';
  const emailField = parts[3] || null;
  const emailList = emailField ? emailField.split(',').map(e => e.trim()) : [];
  const assigneeEmail = emailList[0] || null;
  const followerEmails = emailList.slice(1).join(',') || null;
  const channel = event.channel;
  const slackUserId = event.user;

  try {
    await postSlack(channel, `⏳ Got it! Creating task *${taskName}*...`);

    // Determine assignee
    let asanaAssignee = null;
    if (assigneeEmail) {
      asanaAssignee = assigneeEmail;
