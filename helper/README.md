# The village helper (everyone's brains)

Marshall (your Deputy) and the ten townspeople think with **Claude Opus 5.5 through Claude Code, signed in with your Claude Pro subscription**. Townspeople also use Opus 5.5 as their advisor when something is hard. Workers (the horses) think with **Claude Sonnet 5.5** the same way, on your subscription.

- There is no API key and no pay-per-use.
- Every message uses a little of your Pro allowance. That allowance is shared with claude.ai and has a 5-hour limit and a weekly limit. One order to Marshall costs at least two runs: Marshall's, plus one for each townsperson he hands work to (at most 3 at a time). Work handed to a worker adds at least two more (the worker's, plus the townsperson's check), and two more for each send-back. The terminal shows which model each run used.
- If you hit a limit, everyone goes quiet until it resets. Nothing is charged.

The helper is a small program that runs **on your computer, only while you start it**. The village page sends your messages to it, it asks Claude Code to answer as Marshall or the townsperson you're talking to, and it sends the reply back. Everyone can only talk: all of Claude Code's tools are switched off.

## One-time setup

1. **Install Node.js** (the "LTS" version) from https://nodejs.org.
2. **Install Claude Code and sign in with your Claude Pro account.** Follow https://code.claude.com/docs/en/quickstart, then run `claude` once in a terminal and sign in with your Claude account. Don't sign in with an API key.
3. **Keep usage credits turned off** in your Claude settings (claude.ai → Settings → Usage). That's the pay-per-use part. With credits off, nothing is ever charged per use.
4. **Check everything is ready.** Open a terminal in the `ai-village` folder and run:

```bash
node helper/marshall-helper.js --check
```

It should print your Node.js version, your Claude Code version, the model (`claude-opus-5-5`) and the ten townspeople it found.

## Getting updates

Updates come from GitHub. Open a terminal in the `ai-village` folder and run:

```bash
git pull
```

If you installed the login helper, it restarts itself with the new code. Otherwise restart the helper (Ctrl+C, then start it again). Your notes files and Marshall's memory (`helper/marshall-home/`) are never touched by an update.

## Every time you play

On a Mac, the easiest way: double-click **`mac/Install Village Helper.command`** once. From then on the helper starts by itself, quietly in the background, every time you log in, and you open **http://127.0.0.1:7777** in your browser to play (bookmark it). It uses no Claude allowance while idle. What everyone is doing is written to `~/Library/Logs/ai-village-helper.log`. After a `git pull`, it restarts itself to use new helper code as soon as nobody is in the middle of a task. If you move or rename the village folder, double-click the Install file again. To remove it, double-click **`mac/Uninstall Village Helper.command`**.

Or, without the login helper: double-click **`mac/Start Village.command`**. It starts the helper and opens the village. Keep its Terminal window open while you play; close it to stop. (Moving from an older village folder? Double-click **`mac/Copy Old Notes.command`** once to bring everyone's memories across.)

Or by hand:

1. Open a terminal in the `ai-village` folder and start the helper:

```bash
node helper/marshall-helper.js
```

2. Open **http://127.0.0.1:7777** in your browser (bookmark it). The top-right corner should say **Village brains: connected**. Opening `index.html` straight from the folder still shows the town, but the brains won't connect: see Safety.
3. Press **M** (or the **Deputy** button) from anywhere to talk to Marshall and give orders. Marshall hands each order to the right townspeople, at most 3 at a time. If an order needs more, Marshall says so and a **Send next batch** button appears.
4. Press **L** (or **Chat Log**) to see the hand-offs and reports on the left as they happen. Townspeople with a task walk home and work at their desk until they report back.
5. Walk up to any townsperson and press **T** to chat with them on the right. They answer in their own personality and know their job and notes.
6. Townspeople can hand work to their **worker** (a horse on Sonnet 5.5) and check it before it's done, sending it back with notes if needed. Tell a townsperson "give this to your worker" and they always will.
7. Press **To-Do** in the toolbar to add tasks to your to-do list. Marshall hands each one to the right townsperson; when it's done it's crossed off with who did it and who checked it, and hovering over it shows the instructions, any send-back notes and the finished work.
8. **Esc** or **×** closes a box. When you're done, press **Ctrl+C** in the terminal to stop the helper.

## Hiring new workers

Marshall is always looking for ways to make the team better. When a townsperson says they need help (they can flag it when they report on work), or you ask Marshall ("find someone to help Clem"), Marshall finds one candidate: a horse with their own name, personality and strengths. They walk in on the south road and wait at the town hall.

- **Interview them there:** walk up and press **T**, and ask anything. They answer in character (Sonnet 5.5, one Claude run per message).
- **Decide:** press **Hire** or **Not this one** in their chat box (only in the town hall). Nobody is hired without your yes.
- **Hired:** they get their own folder (`agents/<townsperson>/workers/<name>/`, with `INSTRUCTIONS.md` and `NOTES.md`), walk to their townsperson's yard and start working under them. The townsperson picks which worker gets each job; name one ("give this to Copper") to choose yourself.
- **Not hired:** they walk out of town.
- Limits: one candidate at a time; at most 3 workers per townsperson (what a yard fits); a townsperson asks for help at most once a day. Finding a candidate is one Claude run.

## Notices

Anything Marshall needs you for shows on the **Notices** button (or press **N**): a candidate waiting, finished work to send or save to Gmail, a batch waiting for your go-ahead, a to-do nobody fits, someone asking for help, or a problem. Click one to go to it (a candidate: you walk to the town hall). New ones pop up briefly at the bottom of the screen.

On a Mac, the helper also shows them as **Mac notifications**, even when the village isn't open. Turn them off or on with the switch at the top of the Notices list.

## Gmail drafts (Rufus only)

When Rufus finishes an email or letter (himself or through his worker Pepper), a **Save to Gmail drafts** button appears under it in Marshall's chat and on your to-do list. Press it and Rufus saves it as a draft in your Gmail, through the Gmail connector on your Claude account. You then check it in Gmail and press Send yourself.

- Nothing is saved until you press the button: that's your yes, each time.
- Rufus can only **create drafts**. Sending, replying, forwarding, deleting drafts, labels, trash, spam and reading your mail are all blocked.
- Nobody else (Marshall, other townspeople, workers) can touch Gmail.
- Each save uses one Claude run from your Pro allowance.
- If it says it couldn't save, the chat log (L) says why. If Claude Code names the Gmail connector differently on your Mac, the helper can be told its name with the `GMAIL_MCP_SERVER` setting.

## What the helper keeps

Everything stays in `helper/marshall-home/` on your computer:

- `village-log.jsonl`: the chat log (orders, hand-offs, reports).
- `orders.json`: every task Marshall handed out, who got it, and whether they reported back.
- `todos.json`: your to-do list, with who did each item and exactly what they did.
- `hiring.json`: the candidate waiting at the town hall, and everyone interviewed so far.
- `notices.json` and `settings.json`: Marshall's notices, and whether Mac notifications are on.
- `runs-log.csv`: one line per Claude Code run (who, time taken, tokens), for the build log. The cost column is Claude Code's own estimate of what the same work would cost on the API. On your subscription, nothing is billed per use.
- `sessions.json`: conversation ids, so everyone remembers earlier chats. Delete it to give everyone a fresh start.

Each townsperson's memory is their own `agents/<name>/NOTES.md`. These notes files stay on your computer: they aren't saved to GitHub, so updating with `git pull` never touches them. If one is missing, the helper starts a fresh one. They add what they learn under "What I've learned", and chats with neighbors under "Conversations".

Workers (the horses) keep notes too, in `agents/<townsperson>/workers/<worker>/NOTES.md`. They have no brain yet, so chatting with one uses none of your Claude allowance.

## If something goes wrong

- **"Marshall's brain: not running"**: start the helper (step 1 above), then reload the page.
- **"Couldn't start Claude Code"**: Claude Code isn't installed or isn't on your PATH. On Windows, if `claude` was installed some other way, point the helper at the program directly. In PowerShell:

```powershell
$env:MARSHALL_CLAUDE_BIN="C:\full\path\to\claude.exe"; node helper/marshall-helper.js
```

- **Marshall says they couldn't answer because of a limit**: you've reached your Pro usage limit. Wait for it to reset. Don't turn on usage credits, because that makes it pay-per-use.
- **Port 7777 is busy**: the helper is probably already running in another terminal.

## Safety

**Nobody in the village can send, post, buy, book or spend anything, or touch your files.** To check this yourself on your computer (it doesn't contact Claude and uses none of your allowance):

```bash
node helper/marshall-helper.js --check-safety
```

How it's locked down:

- **No tools.** Every Claude Code run starts with no built-in tools at all (no files, commands, web, scheduling or helpers), none of your own Claude Code settings, plugins, hooks or skills, and no connectors (Gmail, Higgsfield and so on).
- **One exception, with your yes:** when you press "Save to Gmail drafts", Rufus's run gets the Gmail connector's create-draft tool and nothing else. Sending, replying, forwarding, deleting and reading mail stay blocked.
- **The tool gate** (`helper/tool-gate.js`) checks every tool call on every run and blocks anything not allowed, whatever any other setting says. If an agent ever tries, you get a notice.
- **Only your subscription.** The helper removes API keys and any other billing route before starting Claude Code. Keep usage credits / extra usage turned off on your Claude account so a limit just means waiting.
- **A daily limit** of 300 Claude runs, so nothing can run away with your allowance. (Change it with the `VILLAGE_DAILY_RUN_LIMIT` setting.)
- **Only the village page can talk to the helper**, and only when the helper serves it at http://127.0.0.1:7777. Websites, other programs' web pages, and pages opened straight from a file are refused, so a website you visit can't give Marshall orders, read your to-do list or press buttons for you.
- **The helper only answers this computer** (`127.0.0.1`) and serves nothing but the village page's own files.


- The helper only listens on `127.0.0.1` (this computer), and only answers the village page.
- It removes `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` before starting Claude Code, so Claude Code can't fall back to a pay-per-use API key.
- It runs Claude Code in an empty folder (`marshall-home/room`) with every tool switched off, so nobody can read or change your files or run commands. The helper itself only writes to `marshall-home/` and the townspeople's `NOTES.md` files.
- Marshall's personality and job are in `helper/marshall-persona.md`; each townsperson's are in `agents/<name>/INSTRUCTIONS.md`. You can edit it in any text editor. Keep the answer lines at the end (Marshall: `SAY:` and `TASK key:`), because the helper reads those. When you change the file, Marshall starts a fresh conversation automatically.
- These instructions **replace** Claude Code's built-in coding-assistant instructions, so Marshall stays in character and short. Replies longer than about 260 characters are trimmed at the end of a sentence.
