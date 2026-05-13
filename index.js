const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const ASANA_TOKEN = process.env.ASANA_TOKEN;
const BOX_CLIENT_ID = process.env.BOX_CLIENT_ID;
const BOX_CLIENT_SECRET = process.env.BOX_CLIENT_SECRET;
const BOX_PARENT_FOLDER_ID = '378152598280';
const ASANA_WORKSPACE = '1209414882370188';

let boxTokens = {
  access_token: process.env.BOX_ACCESS_TOKEN || null,
  refresh_token: process.env.BOX_REFRESH_TOKEN || null,
};

async function getBoxToken() {
  if (!boxTokens.refresh_token) throw new Error('No Box refresh token available');
  try {
    const res = await axios.post('https://api.box.com/oauth2/token', new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: boxTokens.refresh_token,
      client_id: BOX_CLIENT_ID,
      client_secret: BOX_CLIENT_SECRET,
    }));
    boxTokens.access_token = res.data.access_token;
    boxTokens.refresh_token = res.data.refresh_token;

    // Save new refresh token back to Railway
    await axios.post(
      'https://backboard.railway.app/graphql/v2',
      {
        query: `mutation {
          upsertVariable(input: {
            projectId: "${process.env.RAILWAY_PROJECT_ID}",
            environmentId: "${process.env.RAILWAY_ENVIRONMENT_ID}",
            serviceId: "${process.env.RAILWAY_SERVICE_ID}",
            name: "BOX_REFRESH_TOKEN",
            value: "${res.data.refresh_token}"
          }) { id }
        }`
      },
      { headers: { Authorization: `Bearer ${process.env.RAILWAY_API_TOKEN}` } }
    );

    return boxTokens.access_token;
  } catch (err) {
    console.error('Box token refresh failed:', err.response?.data || err.message);
    throw err;
  }
}

// One-time Box login — visit this URL in browser once to authorize
app.get('/box/login', (req, res) => {
  const redirectUri = `https://${process.env.RAILWAY_PUBLIC_DOMAIN}/box/callback`;
  const authUrl = `https://account.box.com/api/oauth2/authorize?response_type=code&client_id=${BOX_CLIENT_ID}&redirect_uri=${encodeURIComponent(redirectUri)}`;
  res.redirect(authUrl);
});

// Box sends token here after login
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

    boxTokens.access_token = tokenRes.data.access_token;
    boxTokens.refresh_token = tokenRes.data.refresh_token;

    // Save both tokens to Railway permanently
    await axios.post(
      'https://backboard.railway.app/graphql/v2',
      {
        query: `mutation {
          upsertVariable(input: {
            projectId: "${process.env.RAILWAY_PROJECT_ID}",
            environmentId: "${process.env.RAILWAY_ENVIRONMENT_ID}",
            serviceId: "${process.env.RAILWAY_SERVICE_ID}",
            name: "BOX_REFRESH_TOKEN",
            value: "${tokenRes.data.refresh_token}"
          }) { id }
        }`
      },
      { headers: { Authorization: `Bearer ${process.env.RAILWAY_API_TOKEN}` } }
    );

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
  const taskNa
