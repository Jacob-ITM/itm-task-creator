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

// Load refresh token from Railway environment variable
let boxTokens = {
  access_token: null,
  refresh_token: process.env.BOX_REFRESH_TOKEN || null,
};

async function getBoxToken() {
  if (!boxTokens.refresh_token) throw new Error('No Box refresh token available');
  const res = await axios.post('https://api.box.com/oauth2/token', new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: boxTokens.refresh_token,
    client_id: BOX_CLIENT_ID,
    client_secret: BOX_CLIENT_SECRET,
  }));
  // Update tokens in memory
  boxTokens.access_token = res.data.access_token;
  boxTokens.refresh_token = res.data.refresh_token;
  return boxTokens.access_token;
}

// One-time Box login — visit once in browser to authorize
app.get('/box/login', (req, res) => {
  const redirectUri = `https://${process.env.RAILWAY_PUBLIC_DOMAIN}/box/callback`;
  const authUrl = `https://account.box.com/api/oauth2/authorize?response_type=code&client_id=${BOX_CLIENT_ID}&redirect_uri=${encodeURIComponent(redirectUri)}`;
  res.redirect(authUrl);
});

// Box sends tokens here after login
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

    // Show the refresh token so you can save it to Railway manually
    res.send(`
      <h2>✅ Box connected successfully!</h2>
      <p>Copy the refresh token below and save it as <strong>BOX_REFRESH_TOKEN</strong> in your Railway variables:</p>
      <textarea rows="4" cols="80" onclick="this.select()">${tokenRes.data.refresh_token}</textarea>
      <p>Once saved in Railway, you will never need to do this again.</p>
    `);
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
    } else {
      const slackUserRes = await axios.get(
        `https://slack.com/api/users.info?user=${slackUserId}`,
        { headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` } }
      );
      if (slackUserRes.data.ok) asanaAssignee = slackUserRes.data.user.profile.email;
    }

    // Create Asana task
    const asanaBody = {
      data: { name: taskName, notes: taskDesc, workspace: ASANA_WORKSPACE }
    };
    if (asanaAssignee) asanaBody.data.assignee = asanaAssignee;
    if (followerEmails) asanaBody.data.followers = followerEmails;

    const asanaRes = await axios.post(
      'https://app.asana.com/api/1.0/tasks',
      asanaBody,
      { headers: { Authorization: `Bearer ${ASANA_TOKEN}` } }
    );
    const asanaTask = asanaRes.data.data;
    const asanaUrl = `https://app.asana.com/0/0/${asanaTask.gid}`;

    // Create Box folder with fresh token
    const boxToken = await getBoxToken();
    const boxRes = await axios.post(
      'https://api.box.com/2.0/folders',
      { name: taskName, parent: { id: BOX_PARENT_FOLDER_ID } },
      { headers: { Authorization: `Bearer ${boxToken}` } }
    );
    const boxFolder = boxRes.data;
    const boxUrl = `https://app.box.com/folder/${boxFolder.id}`;

    // Update Asana task with Box link
    await axios.put(
      `https://app.asana.com/api/1.0/tasks/${asanaTask.gid}`,
      { data: { notes: `${taskDesc}\n\nBox Folder: ${boxUrl}` } },
      { headers: { Authorization: `Bearer ${ASANA_TOKEN}` } }
    );

    const assignedTo = asanaAssignee ? `\n👤 *Assigned to:* ${asanaAssignee}` : '';
    const followers = followerEmails ? `\n👥 *Followers:* ${followerEmails}` : '';
    await postSlack(channel,
      `✅ Done!\n📋 *Asana Task:* ${asanaUrl}\n📁 *Box Folder:* ${boxUrl}${assignedTo}${followers}`
    );

  } catch (err) {
    console.error(err.response?.data || err.message);
    await postSlack(channel, `❌ Something went wrong. Please try again.`);
  }
});

async function postSlack(channel, text) {
  await axios.post(
    'https://slack.com/api/chat.postMessage',
    { channel, text },
    { headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` } }
  );
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
