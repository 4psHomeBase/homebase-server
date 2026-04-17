# HomeBase + WhatsApp Setup Guide

This guide will get you chatting with Geronimo on WhatsApp in about 30 minutes.
You'll set up three things: **Twilio** (WhatsApp), **Railway** (free hosting), and connect your app.

---

## Step 1 — Create a free Twilio account

1. Go to **https://twilio.com** and click **Sign Up** (free, no credit card needed)
2. Verify your phone number when prompted
3. Once inside the Twilio Console, note down:
   - **Account SID** (looks like `ACxxxxxxxx...`)
   - **Auth Token** (click the eye icon to reveal it)

4. In the left menu go to **Messaging → Try it out → Send a WhatsApp message**
5. You'll see the **Sandbox number** (e.g. `+1 415 523 8886`) — note this down
6. Follow Twilio's instructions to **join the sandbox** by sending a WhatsApp message
   from your phone to that number (it'll say something like "join [two-words]")

---

## Step 2 — Deploy to Railway (free hosting)

Railway gives you a free server that stays online 24/7.

1. Go to **https://railway.app** and click **Login with GitHub**
   (Create a free GitHub account first at github.com if you don't have one)

2. Click **New Project → Deploy from GitHub repo**

3. Upload the `homebase-server` folder to a new GitHub repository:
   - Go to **https://github.com/new** and create a repo called `homebase-server`
   - Upload all files from the `homebase-server` folder
   - (Drag and drop works on GitHub's web interface)

4. Back in Railway, select your `homebase-server` repo → Deploy

5. Once deployed, go to **Settings → Domains** and click **Generate Domain**
   - You'll get a URL like `https://homebase-server-production-xxxx.up.railway.app`
   - **Save this URL** — you'll need it in Steps 3 and 4

---

## Step 3 — Set your environment variables in Railway

In your Railway project, click on the service → go to **Variables** tab.
Add each of these:

| Variable | Value |
|---|---|
| `API_KEY` | Make up a long random password, e.g. `Gerry-HomeBase-2024-XYZ` |
| `TWILIO_ACCOUNT_SID` | Your Account SID from Step 1 |
| `TWILIO_AUTH_TOKEN` | Your Auth Token from Step 1 |
| `TWILIO_WHATSAPP_FROM` | `whatsapp:+14155238886` (Twilio sandbox number) |
| `OWNER_WHATSAPP` | `whatsapp:+1XXXXXXXXXX` (your number with country code) |

> **Example for a Canadian number:** `whatsapp:+16135551234`

Click **Save** — Railway will automatically restart your server.

---

## Step 4 — Point Twilio to your server (webhook)

1. In Twilio Console, go to **Messaging → Senders → WhatsApp sandbox**
2. In the **"When a message comes in"** field, enter:
   ```
   https://YOUR-RAILWAY-URL.up.railway.app/api/whatsapp
   ```
   (Replace with your actual Railway URL from Step 2)
3. Make sure the method is set to **HTTP POST**
4. Click **Save**

---

## Step 5 — Connect HomeBase to your server

1. Open **homebase.html** in your browser
2. Log in and go to **Settings**
3. Scroll to **Server Sync & WhatsApp**
4. Enter:
   - **Server URL:** `https://YOUR-RAILWAY-URL.up.railway.app`
   - **API Key:** the `API_KEY` you set in Step 3
5. Click **Save & Test** — you should see "✅ Connected!"

Your HomeBase data is now syncing to the server. Every time you make a change
in the app, it automatically pushes to the server so WhatsApp can see it.

---

## Step 6 — Test it!

Send any of these messages to the Twilio sandbox number on WhatsApp:

| Message | What happens |
|---|---|
| `summary` | Full overview of your homes |
| `bills` | List of bills due |
| `tasks` | List of maintenance tasks due |
| `paid 1` | Marks bill #1 as paid |
| `done 1` | Marks task #1 as done |
| `add task Change HVAC Filter at Main House` | Adds a new task |
| `add bill Electric at Cottage` | Adds a new bill |
| `help` | Shows all commands |

---

## Daily Reminders

The server automatically sends you a WhatsApp message at **9am every day**
if any bills or tasks need your attention:

- 🔴 Overdue bills or tasks
- 🟠 Bills due in the next 3 days
- 🟡 Maintenance tasks due in the next 7 days

If everything is fine, you won't receive a message (no spam!).

---

## Troubleshooting

**"Could not reach server" when connecting in the app**
→ Check that your Railway deployment is running (green status in Railway dashboard)
→ Make sure you copied the URL correctly (no trailing slash)

**WhatsApp messages aren't getting a reply**
→ Check the Twilio webhook URL is correct (Step 4)
→ In Railway, click on your service → **Logs** to see incoming requests and errors

**Reminders aren't arriving**
→ Make sure `OWNER_WHATSAPP` includes the country code: `whatsapp:+16135551234`
→ Check you've joined the Twilio sandbox (Step 1, point 6)

---

## Going to production (optional, later)

The Twilio sandbox is for testing — it requires everyone to "join" it first.
When you're ready to use a real WhatsApp number, you can apply for a
**WhatsApp Business number** through Twilio (costs ~$5/month).

---

*Built with HomeBase + Twilio + Railway*
