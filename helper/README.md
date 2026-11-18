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

## Work Hours: when you're online

**Work Hours** (first button in the toolbar) is your "I'm online" switch.

- **On:** townspeople work at their desks and workers in their yards (anyone making something works at a General Store workbench). The first time you turn it on each day, Marshall runs a **morning huddle**: every townsperson says what they need from you and what should happen next, and Marshall merges it (about 11 Claude runs). Turning it on again later that day just resumes, with no new huddle.
- **Colleagues keep talking while seated:** every few minutes two townspeople who haven't talked today exchange notes desk to desk (a speech bubble shows over both). They take notes, and may raise a question or propose a to-do. At most 10 conversations a day (change it with the `VILLAGE_HALLWAY_LIMIT` setting); work from to-dos and orders isn't limited by this.
- **Off:** everyone wanders town, and **no Claude runs happen by themselves**. Townspeople who meet only swap simple notes. Questions and proposals wait for you.
- **Questions** (toolbar, or press **Q**): what the town needs to know from you. Answer once and **everyone** knows: your answers are kept as **town facts** (`helper/marshall-home/town-facts.md`) that every townsperson and worker reads. Skip what doesn't matter.
- **Proposed to-dos** appear on your to-do list as *Proposed*, with **Approve** (Marshall hands it out like any to-do) and **Decline**. Nothing happens without your Approve.
- Marshall passes on what one townsperson needs from another (it goes in their notes under "Open items").
- Work Hours stays as you left it if you reload the page.

## What the town knows, and asking you

- **Town facts:** your answers to their questions (`helper/marshall-home/town-facts.md`). Every townsperson, worker and Marshall reads them.
- **Approved work:** once you **Approve** something in the General Store, everyone sees it listed, and the townspeople it concerns (and their workers) get its text. For example, an approved offer sheet goes to Prospecting, Sales, Marketing, Product, Finance, Legal and Client Success. Work you haven't approved isn't shared.
- **Always up to date:** every message to an agent includes their current notes, the town facts and approved work (not a copy from when their conversation started).
- **No repeat questions:** before a question reaches you, it's compared with ones you've already answered; if it's the same thing in other words, it's dropped and the agent is pointed to your answer. Questions that say they're checking a conflict ("To confirm: …") still come through.
- **Working together:** Marshall can give work in order ("Ezra, after Rufus"): the second person starts only when the first is done and checked, and receives their finished work. Any townsperson can also hand a colleague something with a PASS line; it lands in that colleague's notes under "From colleagues".
- **Questions any time:** when a townsperson needs something only you can tell them, during a task, a chat or a talk with a colleague, it goes on your **Questions** list.
- **Waiting on you:** if a task can't be done properly without your answers, it shows **Waiting on you** on your to-do list (with an "Answer their questions" button) instead of being done with blanks. When every question for it is answered or skipped, it **starts again by itself** with your answers (at most twice; after that they do their best).

## Tools (your tool matrix, Phase 1)

| Who | Can use |
|---|---|
| Marshall (Chief of Staff) | Your Google Calendar, read-only, primary calendar only |
| Clem (Prospecting) | Web search (no page-opening, so he can know the town facts and approved work) |
| Augustus (Sales), Hattie (Client Success) | The Village Library; your calendar, read-only |
| Jo (Delivery), Rufus (Marketing) | The Village Library (Rufus also: Gmail drafts with your button) |
| Ezra (Product) | Web search; the Village Library |
| Winona (Partnerships) | Web search; your calendar, read-only |
| Beatrice (Legal) | Web search; opening official government pages only (.gov); the Village Library |
| Silas (Operations) | A summary of the village's logs (runs today, recent activity, to-dos) |
| Mortimer (Finance), all workers | Nothing yet |

The tool gate checks every call: only those tools, only the primary calendar, no one else's free time, Legal only on .gov pages, and nobody who reads private information (the library or your calendar) can open web pages. Phase 2 and 3 (draft buttons for more people, Drive create, Gmail read, Higgsfield images, a daily brief) come later.

**The Village Library** is the `library/` folder in the village (the **Village Library** button in the General Store opens it in Finder). Put your offers, prices, brand voice, templates and an "about my business" there as `.md`, `.txt` or `.csv` files. It stays on your computer.

## Town meetings

During a meeting, a chat box opens on the left with everyone's picture and name. It starts on **Everyone**: talk to the whole room at once (one Claude run; the people with something useful to say answer, and Marshall can hand out work). Click one person to talk to just them. Drag the box's corner to resize it; **A+** / **A−** make the pictures and names bigger or smaller. Close it with ×, and reopen it with **Meeting Chat** in the toolbar.

## Notices

Anything Marshall needs you for shows on the **Notices** button (or press **N**): a candidate waiting, finished work to send or save to Gmail, a batch waiting for your go-ahead, a to-do nobody fits, someone asking for help, or a problem. Click one to go to it (a candidate: you walk to the town hall). New ones pop up briefly at the bottom of the screen.

On a Mac, the helper also shows them as **Mac notifications**, even when the village isn't open. Turn them off or on with the switch at the top of the Notices list.

## The General Store (the Workshop): websites, documents and spreadsheets

The General Store stands east of House 6, on the main street where it leads out of town. When a task asks for something real to be made, whoever makes it walks to a free workbench in the store and works there; their townsperson checks it like any other work. Agents still have no tools: they write the files in their answer and the helper saves them in the `workshop/` folder, accepting only simple web and text files (.html .css .js .svg .md .txt .csv .json) with plain names.

- **What gets made:** a website is `index.html`; a document, report, one-pager or **PDF** is a print-ready `document.html` (press **Save as PDF**); a spreadsheet is a `.csv` file (opens in Excel, Numbers or Google Sheets).
- **Design:** for websites and documents, the makers follow Anthropic's free **frontend-design** Skill (in `agents/skills/`).
- **Everything made is in the store:** press **G** from anywhere (again to close). Search, filter by kind, pick one, and **Preview**, **Save as PDF**, **Download** a file or **Download all** (.zip), **Publish** (websites) or **Show in Finder**. Notices about finished work open it there too.
- **Ready for approval:** everything finished lands here first (the store opens on it whenever something is waiting, and Notices puts it at the top). **Approve** it, or **Request changes** and write what should change: the maker (and their worker) revise it and the new version comes back here, as version 2, 3… Websites can be published only once approved, and a new version of a website publishes to the same address.
- Previews open in a sealed-off tab, so a previewed page can't press any village buttons.
- **Publish (websites only):** confirm, and the helper puts the site on your free GitHub Pages website at `https://<your-github-name>.github.io/<site-name>/` (public; a minute or two to appear). Press Publish again later to update it.
- The `workshop/` folder stays on your computer (it isn't saved to the village's GitHub repository).

**Set up publishing once:** double-click `mac/Set Up Website Publishing.command`. It installs GitHub's `gh` tool if needed (asking first), signs you in to GitHub in your browser, and creates one public repository for your websites, `<your-github-name>.github.io`, asking first.

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
- `notices.json` and `settings.json`: Marshall's notices, whether Mac notifications are on, and where websites are published.
- `workshop.json` and `pages-repo/`: what's in the workshop, and the copy of your website repository the Publish button uses.
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
