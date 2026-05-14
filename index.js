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
const processedEvents = new Set();

let boxTokens = {
  access_token: null,
  refresh_token: process.env.BOX_REFRESH_TOKEN || null
};

async function getBoxToken() {
  if (!boxTokens.refresh_token) {
    throw new Error('No Box refresh token available');
  }
  const res = await axios.post(
    'https://api.box.com/oauth2/token',
    new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: boxTokens.refresh_token,
      client_id: BOX_CLIENT_ID,
      client_secret: BOX_CLIENT_SECRET
    })
  );
  boxTokens.access_token = res.data.access_token;
  boxTokens.refresh_token = res.data.refresh_token;
  return boxTokens.access_token;
}

async function postSlack(channel, text) {
  await axios.post(
    'https://slack.com/api/chat.postMessage',
    { channel: channel, text: text },
    { headers: { Authorization: 'Bearer ' + SLACK_BOT_TOKEN } }
  );
}

app.get('/box/login', function(req, res) {
  const redirectUri = 'https://' + process.env.RAILWAY_PUBLIC_DOMAIN + '/box/callback';
  const authUrl = 'https://account.box.com/api/oauth2/authorize?response_type=code&client_id=' + BOX_CLIENT_ID + '&redirect_uri=' + encodeURIComponent(redirectUri);
  res.redirect(authUrl);
});

app.get('/box/callback', function(req, res) {
  const code = req.query.code;
  const redirectUri = 'https://' + process.env.RAILWAY_PUBLIC_DOMAIN + '/box/callback';
  axios.post(
    'https://api.box.com/oauth2/token',
    new URLSearchParams({
      grant_type: 'authorization_code',
      code: code,
      client_id: BOX_CLIENT_ID,
      client_secret: BOX_CLIENT_SECRET,
      redirect_uri: redirectUri
    })
  ).then(function(tokenRes) {
    boxTokens.access_token = tokenRes.data.access_token;
    boxTokens.refresh_token = tokenRes.data.refresh_token;
    res.send('<h2>Box connected!</h2><p>Copy this refresh token and save it as BOX_REFRESH_TOKEN in Railway:</p><textarea rows="4" cols="80" onclick="this.select()">' + tokenRes.data.refresh_token + '</textarea>');
  }).catch(function(err) {
    console.error(err.response ? err.response.data : err.message);
    res.send('Box authorization failed. Please try again.');
  });
});

app.post('/slack/events', function(req, res) {
  const body = req.body;

  if (body.type === 'url_verification') {
    return res.json({ challenge: body.challenge });
  }

  res.sendStatus(200);

  const eventId = body.event_id;
  if (!eventId || processedEvents.has(eventId)) {
    return;
  }
  processedEvents.add(eventId);
  setTimeout(function() { processedEvents.delete(eventId); }, 60000);

  const event = body.event;
  if (!event || event.type !== 'message' || event.subtype || !event.text) {
    return;
  }

  const text = event.text.trim();
  if (!text.startsWith('#create')) {
    return;
  }

  const parts = text.split('|').map(function(p) { return p.trim(); });
  const taskName = parts[1] || 'Untitled Task';
  const taskDesc = parts[2] || 'No description provided.';
  const emailField = parts[3] || null;
  const emailList = emailField ? emailField.split(',').map(function(e) { return e.trim(); }) : [];
  const assigneeEmail = emailList[0] || null;
  const followerEmails = emailList.slice(1).join(',') || null;
  const channel = event.channel;
  const slackUserId = event.user;

  postSlack(channel, 'Got it! Creating task ' + taskName + '...')
  .then(function() {
    if (assigneeEmail) {
      return Promise.resolve(assigneeEmail);
    }
    return axios.get(
      'https://slack.com/api/users.info?user=' + slackUserId,
      { headers: { Authorization: 'Bearer ' + SLACK_BOT_TOKEN } }
    ).then(function(slackRes) {
      if (slackRes.data.ok) {
        return slackRes.data.user.profile.email;
      }
      return null;
    });
  })
  .then(function(asanaAssignee) {
    const asanaData = {
      name: taskName,
      notes: taskDesc,
      workspace: ASANA_WORKSPACE
    };
    if (asanaAssignee) asanaData.assignee = asanaAssignee;
    if (followerEmails) asanaData.followers = followerEmails;

    return axios.post(
      'https://app.asana.com/api/1.0/tasks',
      { data: asanaData },
      { headers: { Authorization: 'Bearer ' + ASANA_TOKEN } }
    ).then(function(asanaRes) {
      const asanaTask = asanaRes.data.data;
      const asanaUrl = 'https://app.asana.com/0/0/' + asanaTask.gid;
      return { asanaTask: asanaTask, asanaUrl: asanaUrl, asanaAssignee: asanaAssignee };
    });
  })
  .then(function(data) {
    return getBoxToken().then(function(boxToken) {
      return axios.post(
        'https://api.box.com/2.0/folders',
        { name: taskName, parent: { id: BOX_PARENT_FOLDER_ID } },
        { headers: { Authorization: 'Bearer ' + boxToken } }
      ).catch(function(err) {
        if (err.response && err.response.data && err.response.data.code === 'item_name_in_use') {
          const now = new Date();
          const timestamp = now.toISOString().slice(0, 16).replace('T', ' ');
          const newName = taskName + ' (' + timestamp + ')';
          return axios.post(
            'https://api.box.com/2.0/folders',
            { name: newName, parent: { id: BOX_PARENT_FOLDER_ID } },
            { headers: { Authorization: 'Bearer ' + boxToken } }
          );
        }
        throw err;
      });
    }).then(function(boxRes) {
      const boxFolder = boxRes.data;
      const boxUrl = 'https://app.box.com/folder/' + boxFolder.id;
      return { data: data, boxUrl: boxUrl };
    });
  })
  .then(function(result) {
    const asanaTask = result.data.asanaTask;
    const asanaUrl = result.data.asanaUrl;
    const asanaAssignee = result.data.asanaAssignee;
    const boxUrl = result.boxUrl;

    return axios.put(
      'https://app.asana.com/api/1.0/tasks/' + asanaTask.gid,
      { data: { notes: taskDesc + '\n\nBox Folder: ' + boxUrl } },
      { headers: { Authorization: 'Bearer ' + ASANA_TOKEN } }
    ).then(function() {
      let msg = 'Done!\n Asana Task: ' + asanaUrl + '\n Box Folder: ' + boxUrl;
      if (asanaAssignee) msg += '\n Assigned to: ' + asanaAssignee;
      if (followerEmails) msg += '\n Followers: ' + followerEmails;
      return postSlack(channel, msg);
    });
  })
  .catch(function(err) {
    console.error(err.response ? err.response.data : err.message);
    postSlack(channel, 'Something went wrong. Please try again.');
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, function() {
  console.log('Server running on port ' + PORT);
});
