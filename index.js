const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const ASANA_TOKEN = process.env.ASANA_TOKEN;
const BOX_DEVELOPER_TOKEN = process.env.BOX_DEVELOPER_TOKEN;
const BOX_PARENT_FOLDER_ID = '378152598280';
const ASANA_WORKSPACE = '1209414882370188';

// Map Slack user IDs to Asana emails
const SLACK_TO_ASANA = {
  // This gets populated automatically via Slack API
};

app.post('/slack/events', async (req, res) => {
  const body = req.body;

  if (body.type === 'url_verification') {
    return res.json({ challenge: body.challenge });
  }

  res.sendStatus(200);

  const event = body.event;
  if (!event || event.type !== 'message' || event.subtype || !event.text) return;

  const text = event.text.trim();
  if (!text.startsWith('#create')) return;

  const parts = text.split('|').map(p => p.trim());
  const taskName = parts[1] || 'Untitled Task';
  const taskDesc = parts[2] || 'No description provided.';
  const assigneeEmail = parts[3] || null;
  const channel = event.channel;
  const slackUserId = event.user;

  try {
    await postSlack(channel, `⏳ Got it! Creating task *${taskName}*...`);

    // Determine assignee
    let asanaAssignee = null;

    if (assigneeEmail) {
      // Use the email provided in the command
      asanaAssignee = assigneeEmail;
    } else {
      // Look up the Slack user's email and use that
      const slackUserRes = await axios.get(
        `https://slack.com/api/users.info?user=${slackUserId}`,
        { headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` } }
      );
      if (slackUserRes.data.ok) {
        asanaAssignee = slackUserRes.data.user.profile.email;
      }
    }

    // Create Asana task
    const asanaBody = {
      data: {
        name: taskName,
        notes: taskDesc,
        workspace: ASANA_WORKSPACE,
      }
    };
    if (asanaAssignee) asanaBody.data.assignee = asanaAssignee;

    const asanaRes = await axios.post(
      'https://app.asana.com/api/1.0/tasks',
      asanaBody,
      { headers: { Authorization: `Bearer ${ASANA_TOKEN}` } }
    );
    const asanaTask = asanaRes.data.data;
    const asanaUrl = `https://app.asana.com/0/0/${asanaTask.gid}`;

    // Create Box folder
    const boxRes = await axios.post(
      'https://api.box.com/2.0/folders',
      { name: taskName, parent: { id: BOX_PARENT_FOLDER_ID } },
      { headers: { Authorization: `Bearer ${BOX_DEVELOPER_TOKEN}` } }
    );
    const boxFolder = boxRes.data;
    const boxUrl = `https://app.box.com/folder/${boxFolder.id}`;

    // Update Asana task with Box link
    await axios.put(
      `https://app.asana.com/api/1.0/tasks/${asanaTask.gid}`,
      { data: { notes: `${taskDesc}\n\nBox Folder: ${boxUrl}` } },
      { headers: { Authorization: `Bearer ${ASANA_TOKEN}` } }
    );

    const assignedTo = asanaAssignee ? `👤 *Assigned to:* ${asanaAssignee}` : '';
    await postSlack(channel,
      `✅ Done! Here's what was created:\n📋 *Asana Task:* ${asanaUrl}\n📁 *Box Folder:* ${boxUrl}${assignedTo ? '\n' + assignedTo : ''}`
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
