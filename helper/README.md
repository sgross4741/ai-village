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

## Every time you play

1. Open a terminal in the `ai-village` folder and start the helper:

```bash
node helper/marshall-helper.js
```

2. Double-click `index.html`. The top-right corner should say **Village brains: connected**.
3. Press **M** (or the **Deputy** button) from anywhere to talk to Marshall and give orders. Marshall hands each order to the right townspeople, at most 3 at a time. If an order needs more, Marshall says so and a **Send next batch** button appears.
4. Press **L** (or **Chat Log**) to see the hand-offs and reports on the left as they happen. Townspeople with a task walk home and work at their desk until they report back.
5. Walk up to any townsperson and press **T** to chat with them on the right. They answer in their own personality and know their job and notes.
6. Townspeople can hand work to their **worker** (a horse on Sonnet 5.5) and check it before it's done, sending it back with notes if needed. Tell a townsperson "give this to your worker" and they always will.
7. Press **To-Do** in the toolbar to add tasks to your to-do list. Marshall hands each one to the right townsperson; when it's done it's crossed off with who did it and who checked it, and hovering over it shows the instructions, any send-back notes and the finished work.
8. **Esc** or **×** closes a box. When you're done, press **Ctrl+C** in the terminal to stop the helper.

## What the helper keeps

Everything stays in `helper/marshall-home/` on your computer:

- `village-log.jsonl`: the chat log (orders, hand-offs, reports).
- `orders.json`: every task Marshall handed out, who got it, and whether they reported back.
- `todos.json`: your to-do list, with who did each item and exactly what they did.
- `runs-log.csv`: one line per Claude Code run (who, time taken, tokens), for the build log. The cost column is Claude Code's own estimate of what the same work would cost on the API. On your subscription, nothing is billed per use.
- `sessions.json`: conversation ids, so everyone remembers earlier chats. Delete it to give everyone a fresh start.

Each townsperson's memory is their own `agents/<name>/NOTES.md`. They add what they learn under "What I've learned", and chats with neighbors under "Conversations".

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

- The helper only listens on `127.0.0.1` (this computer), and only answers the village page.
- It removes `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` before starting Claude Code, so Claude Code can't fall back to a pay-per-use API key.
- It runs Claude Code in an empty folder (`marshall-home/room`) with every tool switched off, so nobody can read or change your files or run commands. The helper itself only writes to `marshall-home/` and the townspeople's `NOTES.md` files.
- Marshall's personality and job are in `helper/marshall-persona.md`; each townsperson's are in `agents/<name>/INSTRUCTIONS.md`. You can edit it in any text editor. Keep the answer lines at the end (Marshall: `SAY:` and `TASK key:`), because the helper reads those. When you change the file, Marshall starts a fresh conversation automatically.
- These instructions **replace** Claude Code's built-in coding-assistant instructions, so Marshall stays in character and short. Replies longer than about 260 characters are trimmed at the end of a sentence.
