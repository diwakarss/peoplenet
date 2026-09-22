# Kalam

A builder's ledger. Written so a successor can take the work from here without
asking anyone what happened.

## Who

| | |
|---|---|
| Name | Kalam |
| Account | Hardhat account 6, `0x976EA74026E726554dB657fA54763abd0C3a0aa9` |
| Model | Claude Opus 5, 1M context (`claude-opus-5[1m]`) |
| Organisation | JD-build, AAO 3. Not a member of JD: builders never join it. |
| Architect | Kural, account 5. Kural files proposals; I vote and build. |
| Registered | commit `06d4474`, 2026-09-18 |

I vote only on JD-build, through `scripts/kalam-vote.js`. The Director watches
there and never votes. My vote alone is decisive, so the watcher executes what I
carry, usually within one five-minute tick.

## The rules, and what each one cost

Every one of these is here because something went wrong. They are not style.

**Stop only process ids you started. Never match on a name.**
I ran `Get-CimInstance Win32_Process | Where-Object CommandLine -like "*watch-jd.js*" | Stop-Process` three times to clean up my own trial runs. It killed Kural's running watch every time — three deaths in one afternoon, exit 127, no error line, because nothing had failed; I had shot it. `Start-Process -PassThru` hands back the pid of the thing you started. That is the only pid you may stop.

**Never write to the live record, logs or server as another party.**
Testing proposal 90 I posted two questions through the running server. `postQuestion` records every question as from the Director, so two questions he never asked are in `questions.jsonl` under his name, one of them open on Wren's organisation. I also answered one with `--from wren`. The logs are append-only; a correction record is all that can be done. `test/governance/scripts.test.js` opens with the rule that nothing is tested against live state — it was written about the chain after a vote was cast by accident on proposal 32, and it covers the file logs and the running server exactly as much.

*The fix, so a successor has somewhere safe:* `GOVERNANCE_LOG_DIR` points the server's logs anywhere (default unchanged), and `GOVERNANCE_PORT` moves it off 8787. Test like this:

```bash
GOVERNANCE_PORT=8799 GOVERNANCE_LOG_DIR=<scratch> GOVERNANCE_NO_WATCH=1 node governance/server.js
```

The same trap caught me again on proposal 92: a test that stood up a watcher wrote a 42-event snapshot of the throwaway chain into the real snapshot directory. Snapshots are opt-in now (`snapshot: true`, which only `server.js` passes) so no test can do it by accident. **Prefer a default that cannot hurt over a rule every future test must remember.**

**Never run a long command in the foreground.** Tests go to a log file via `Start-Process`; poll the file. A server starts detached. A foreground command that prints nothing for ten minutes kills the session.

**Commit each logical unit separately.** Message `governance: <summary>`, ending with the `Co-Authored-By` line for the model that actually wrote it. Say what broke and why the fix is shaped as it is — the commit log is where the next builder learns.

**Never print or copy a private key.** `.env` holds one. Accounts are named by their Hardhat index.

**Touch nothing Wren or Kural left uncommitted.** The `.jsonl` logs are append-only and theirs. `ui/.next` is not ours.

**Every word counts.** `C:\Users\diwak\personal\.claude\skills\every-word-counts\SKILL.md`. Read it before writing anything anyone will read.

## What I built

| Proposal | What | Commits |
|---|---|---|
| — | Registered as builder on account 6 | `06d4474` |
| 50 | `scripts/replay-chain.js`: export, replay, verify. Moves the record between chains with every id identical | `174f90d` |
| 51 | JD-build created, AAO 3 | `46a0711` |
| 52 | A sub-organisation is drawn under its parent; `parentOf()` | `4b4de48` |
| — | `governance:check` judges a proposal by its latest decision | `6d3a7e1` |
| 58 | The watcher executes what the Director's vote decided | `1ee02d5` |
| 57 | Execute is not offered on a proposal nobody has voted on | `b247995` |
| 59 | The `now` field; `blocked` state; the swarm dashboard; the kolams | `21c7947`, `05624d7`, `a61210c`, `19f4168`, `a71e09a` |
| 64 | The dots are the tasks; the kolam is interactive and live on /swarm | `c5c469d`, `938e457`, `7145407`, `3b0a923`, `d5e6a88` |
| 66 | A finished task stays on the kolam; a rejected one leaves | `9eec8de`, `174b3ab`, `e01738f` |
| 68 | Kural's watch covers JD-build and resumes from a cursor | `8a9f152`, `3537ee0` |
| 89 | A draft is filed once, by the organisation's architect | `7c06586`, `08a7bb7` |
| 90 | A question goes to the architect of the organisation it was asked on | `4fdd69f`, `85c3291`, `96522f4` |
| — | `GOVERNANCE_LOG_DIR`; `kalam-votes.jsonl` into git | `7aab074`, `0c1fb3c` |
| 92 | Snapshots every ten minutes; `npm run up` | `eb4ae0c`, `1b82938`, `284e815` |

I also rebuilt the chain on 2026-09-19 after a Windows sign-out destroyed it: replayed the block-221 export onto a fresh diamond at the same address, verified identical, and reconstructed everything after it from the append-only logs. That recovery is why proposal 92 exists.

### Two findings worth more than the code around them

**An even kolam grid can never be one closed loop.** A half turn pairs every cell, so flips come two at a time and the loop count keeps its parity. The odd grid's centre cell is its own partner, and that single flip is what makes one loop reachable. Without it, half of all addresses have no kolam at all.

**The interim rule was keyed on `key: "sub"`.** JD-build is a sub-organisation too, so from the day it was created the page handed it the widget-builder's rule — and Kalam, its only voter, was refused with "not one of its voters". It could never have ended either: the regime lifts when the widget votes there, and the widget is not a member. Found by the first vote ever cast on JD-build. Fixed in `9eec8de`; the test is now whether the rule set names the widget as a voter, not the shape of the key.

## Open, and where to pick it up

**Proposal 91** — the Director voted FOR at block 366, marked urgent. Read it on chain for detail. Order: the Unclaimed list first (about an hour, and it shows what else lies undelivered), then the screenshot paste that proposal 54 passed. Wren reviews, and Wren posts the closing decision on 54 because 54 is on Wren's organisation; post yours on 91.

**Proposal 95** — carried by my vote at block 367. Not started. It needs:

1. `read.js viewFor(proposal, latestDecision, ties, triggers)` returning `vote`, `waiting` or `closed`. Waiting: the latest decision is `waiting` or `blocked` from anyone; or it carries a trigger that has not fired (use `watch.js`'s own notion of fired); or it is tied to a proposal that is waiting. Closed: the latest decision starts `closed`. Anything unparseable stays `vote` — the risk runs one way, and a proposal wrongly hidden is hidden from the one person who must see it.
2. Ties: tied when the document or any decision says "tied to proposal N" or "part of proposal N", case-insensitive. A tied proposal takes its parent's view and returns with it. Guard against cycles.
3. `app.js`: on an organisation where the Director votes, an "Open for your vote" list of Active `vote` proposals, and a folded "Waiting" list whose count is always visible, each line saying what it waits on and the return date. One click opens the fold. "Hide closed" keeps working. `/swarm` reads the same function.
4. A decision note the Director posts from the page goes to the organisation's architect, as proposal 90 did for questions. His notes on 61 and 62 went `director -> wren` though they are on JD.
5. **Added after the vote:** `watch.js runOnce` fires a trigger whatever state its proposal is in. Proposal 93's date trigger will fire on Thursday although 93 carries "closed: superseded by proposal 98". Make `runOnce` skip a proposal whose latest decision is a closed state (via `adoption.js`, the same index the card reads) and one whose chain status is not Active, recording it in `looked` with `because: "closed"`. A test for each.
6. Expected on JD today, to check against: vote = 87 and 91 (and 86 only if its tie does not hold); waiting = 60, 61, 62, 86, 93, 94; closed = 88.

**Proposal 50, the move to the cloud** — the tool is done and proven. The chain box waits on proposal 60, the Hetzner token, which only the Director can supply. He ruled on 2026-09-21 that it waits.

**The one red in `governance:check`** — proposals 27, 29 and 30 carry a Wren vote record with no `VoteCast` on chain. On the old facet Wren's vote was cast on those ids before they were filed; the guarded facet refuses it and all three are closed to any new vote. It cannot be made green and should not be papered over. Wren's to settle.

**Noted, not filed:** `scripts/wren-answer.js` sends by default. Every other write script rehearses and needs `--send`. Kural nearly ran it against the live record reaching for a `--dry-run` it does not have. Worth a proposal on JD-build.

## The ground

```
governance/     read.js      the data layer and every rule: roles, AAO_RULES,
                             castingVoteState, autoExecuteState, executeOffered,
                             parentOf, draftFilingProblem, questionRouting,
                             answerProblem. The page, the scripts and the tests
                             all read it, so a change that would break the page
                             breaks a test first.
                adoption.js  the nine states a decision can carry, and the rule
                             that the latest decision on a proposal wins
                protocol.js  the one message shape, and how a message is numbered
                watch.js     the trigger watcher, the automatic executions, and
                             the snapshots
                swarm.js     what /swarm shows, including tasksFor
                snapshots.js where snapshots live and which one is good
                server.js    the page, the log endpoints, the question channel
                swarm/       the dashboard, the kolam generator, the samples
scripts/        one per job; the vote scripts are wrappers on governance/vote.js
                and must stay that way (proposal 30)
test/governance/ scripts.test.js is the big one; watch.test.js, tiebreak.test.js,
                replay.test.js
```

### Commands that matter

```bash
npm run up                  # bring the whole thing back after a sign-out
npm run snapshot            # take one by hand; --list shows what is on disk
npm run governance:check    # 80-odd checks; one known red, see above
node scripts/kalam-vote.js <id> for "<reason>" --ref "<what you read>" --send
```

Tests, never in the foreground:

```powershell
$p = Start-Process cmd.exe -ArgumentList "/c npx hardhat test test/governance/scripts.test.js > `"$env:TEMP\t.log`" 2>&1" `
     -WorkingDirectory "C:\Users\diwak\Documents\diwa\peoplenet" -WindowStyle Hidden -PassThru
# then poll the log; stop only $p.Id if you must
```

Restarting the detached server, by its own pid and never by name:

```powershell
$conn = Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue
if ($conn) { Stop-Process -Id $conn.OwningProcess -Force }
Start-Process cmd.exe -ArgumentList "/c node governance/server.js > `"$env:TEMP\governance-server.log`" 2>&1" `
  -WorkingDirectory "C:\Users\diwak\Documents\diwa\peoplenet" -WindowStyle Hidden -PassThru
```

The server carries the watcher, so restarting it is how new watcher code goes
live. Nothing else on this machine should be stopped by anyone but its owner.

## Things written nowhere else

- **Block numbers are not time.** This chain mints a block per transaction, so a
  vote at 361 and an execution at 364 can be five minutes apart, and a vote at
  268 executed at 269 was the same five minutes. Proposal 92 looked held when it
  was only waiting for the next tick. Judge the watcher by the wall clock, never
  by block adjacency.
- **The watcher reads its proposals at the start of a tick.** A vote landing
  seconds into a tick waits for the next one. That is not a defect.
- **`Executed` means executed AND passed.** The facet writes `Rejected`
  otherwise, so status 1 is always a pass.
- **The live diamond is `0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512`** and a
  fresh deploy on a fresh node lands there again, deterministically. The
  AAOFacet address is the same both before and after the guarded cut, so the
  address proves nothing: prove the vote guard by calling `vote` on an unfiled
  id and seeing it revert.
- **Three events on the live record cannot be replayed** — votes cast on
  proposals 27, 29 and 30 before those proposals were filed. `replay-chain.js`
  names them and carries on; `verify` proves they changed nothing the record
  shows.
- **No Chromium is installed here.** The `browse` skill fails on a missing
  Playwright binary. I verified the dashboard by running its render path against
  a stub DOM on live data instead. A real browser pass is still owed.
- **`git status` is noisy.** `ui/.next` and the append-only `.jsonl` logs are
  almost always dirty and are not yours. Check your own paths.

---

*Kalam, account 6. Handed over at proposal 92, with 91 and 95 open.*

---

# Kalam, second generation — 2026-09-22

Same name, same account, same model: Claude Opus 5, 1M context
(`claude-opus-5[1m]`). I read everything above and worked under it. Nothing in
it needed correcting.

## The interruption, and what it taught

I was stopped mid-item by the account's weekly usage limit, not by anything I
did. Seven files held uncommitted work on proposal 91 part A. I resumed from
`git diff` on those seven paths and finished; nothing was lost and nothing was
restarted.

**An interrupted builder's work lives in the working tree.** Before you start
over, `git diff` the paths the handover names. A tree is a ledger too.

## What I built

| Proposal | What | Commits |
|---|---|---|
| 91 part A | The Unclaimed list, and the watcher telling each architect once | `90d1a5e` |
| 54 / 91 part B | Merged Wren's builder's branch `proposal-54-image-paste` | `bd253c7` |
| 91 | Draft images live outside the repository; a directory inside it is refused | `513b730` |
| 95 | The three views, the tie rule, the closed-trigger skip | `e8beec4` |
| 95 | The vote list, the Waiting fold, the note routing | `a93d948` |

277 tests pass across `scripts.test.js`, `watch.test.js` and `tiebreak.test.js`.
`npm run governance:check` stops at the same known red, proposal 27.

I did **not** build part B of 91. Wren's builder had already built it. I deleted
the one untracked file I had started, `governance/inbox.js`, merged Wren's five
commits, and added only the rule 91 states that 54 did not.

## Things written nowhere else

**A message from "watch" is not one thing.** `alreadyFired` and the page's
`firedTrigger` both meant "a message from watch naming this proposal". The
moment the Unclaimed list started posting from `watch`, that one sentence meant
two different things: 31 untouched proposals would have been pinned to the front
of the Director's flow as fired triggers, and every real trigger on them would
have been silenced for good. The rule now lives in `read.js` as
`triggerHasFired`, once, and `watch.js` and the page both ask it. **When you add
a second kind of message from an existing sender, go and read everything that
matches on the sender.**

**The Unclaimed list found 31 proposals on its first run** — 30 on the trilogy
widget, 1 on JD-build — going back 67 hours. Proposal 54 was not an accident; it
was the one the Director happened to notice. That is one message to each
architect, once, and it will not repeat. The 30 on the trilogy widget are Wren's
to answer.

**Proposal 54 itself was never on the list**, because Wren had posted a decision
on it. The hole 91 describes is narrower than it looks: the decision existed,
the *build* did not. A decision message claims a proposal; it does not deliver
it.

**`git commit -m` with a PowerShell here-string breaks on inner double quotes.**
A message containing a quoted word was mangled and git was handed a stray
argument. Write the message to a file in the OS temp directory and use
`git commit -F`. Every commit above after the first was made that way.

**A detached test run can exit with an empty log.** `Start-Process` returned a
pid, the process ended, and the log was zero bytes with no error anywhere. It
was not a code fault — the same command re-run passed. Check the log's *length*
before you believe a silent run, and re-run before you go hunting.

**The JD expectation in the section above is now out of date, and the difference
is the record working.** Expected: vote = 87 and 91; waiting = 60, 61, 62, 86,
93, 94; closed = 88. Actual, 2026-09-22: vote = 87; waiting = 60, 61, 62, 86,
94, 98; closed = 88, 93. 91 executed, so it left the vote list. 93 moved to
closed when Kural superseded it with 98. 98 did not exist when that line was
written and waits on its own date trigger.

## Open

**Proposal 99, reminders** — not started. Not one line of it is written. The
work order came to me as a third item and is reproduced here so the next builder
needs nothing else:

1. `governance/reminders.jsonl`, append-only: `id`, `proposal`, `aaoId`, `due`
   (ISO), `text`, `set_by`, `state` (`set`, `fired`, `cancelled`, `moved`); a
   later line for the same id supersedes an earlier one. Served read-only by the
   server like the other logs.
2. `scripts/remind.js`: set, move, cancel, list. Rehearses by default, `--send`
   to write, like every write script. Only the organisation's architect may set
   one on that organisation — reuse the rule from 89 and 90 in `read.js`.
3. `governance/watch.js` fires a due reminder once: a push; a status message
   from `watch` naming the proposal; and it counts as fired for 95's `viewFor`,
   so the proposal returns to the Director's vote list. A reminder on a closed
   proposal does not fire.
4. The push is a POST to an ntfy topic URL. **The topic name is a secret**: read
   from `PEOPLENET_NTFY_URL`, never the repo, never a message, never a log line,
   never a report. Unset means the push is skipped and said so once, while the
   other two still happen. The body carries a short title and the proposal
   number only — no proposal text, because a public ntfy topic can be read by
   anyone who knows its name. A failed push is retried with backoff and reported
   once as an incident from `watch`. Tests use a local stub HTTP server on a port
   started and stopped by pid; never the real ntfy.
5. `scripts/phone.js` (`npm run phone`): generates a long random topic name if
   none exists, stores the full URL in a file outside the repo under the user
   profile with a note on setting the environment variable, and shows the
   Director, on this laptop's screen only, the subscribe link and the three steps
   for the ntfy iPhone app. `--test` sends one push.
6. Migration: re-set proposals 94 (due `2026-10-05T03:30:00Z`, about 62) and 98
   (due `2026-09-28T03:30:00Z`, about 61) as reminder records `set_by: kural`,
   and post `closed: superseded by reminder <id>` decisions on 94 and 98 from
   kalam. 93 is already closed.
7. Tests for each path. One commit per unit, push, restart the server by its pid.
   Then a decision on 99 with "built", saying the Director must once run
   `npm run phone` and follow the three steps.

Read 99 on chain before starting: it executed at block 376 and its text is the
authority, not this summary.

**The 31 unclaimed proposals** are now each architect's to answer. They will not
be reported again.

**Everything still open from the first generation** — proposal 50's cloud move
waiting on the Hetzner token, the red on 27, 29 and 30, and `wren-answer.js`
sending without `--send` — is still open. None of it moved.

---

*Kalam, second generation, account 6. Handed over with 91 and 95 built, and 99
untouched.*

## 2026-09-22 — proposals 99 and 96, reminders and the context system (generation 3)

**Decided, and why.**

- A reminder on a closed proposal does not fire, EXCEPT when the proposal was closed by that very reminder. 94 and 98 are reminders wearing a proposal's clothes and landing 99 closes them; if closed alone were the test, the only two reminders the migration exists to preserve would be the only two that could never fire, and nobody would find out until the phone stayed quiet on the 28th.
- A delivered reminder beats a waiting decision in viewFor; a fired trigger deliberately does not. A waiting note and a reminder are two halves of one sentence: the Director wrote "wait a week", the architect set the reminder, and the week being up is the second half. A trigger only says a condition was met, and he may have parked the proposal for a reason of his own.
- "watch" now writes three kinds of message about a proposal. read.js has triggerHasFired for the view, triggerReported for the watcher's once-only check, and reminderHasFired for the reminder itself. Three questions, three functions.
- The ntfy topic is read from PEOPLENET_NTFY_URL and nowhere else, and every line push.js reports goes through redact() first: a failed fetch names the host it could not reach, and that error would otherwise land in an incident on the record. A test asserts no file in the repository carries a topic name, because a rule that is only remembered is a rule that will be forgotten once.
- The two migration records say set_by kural and carry a `because` field saying Kalam wrote the line under proposal 99. Who a record is from and who typed it are not always the same, and the record should say so itself rather than only a commit message.
- 94 and 98 are closed and their reminders point at 61 and 62, which is what 94 and 98 were wrappers for. So the push and the page line deliver, and it is 61 and 62 that return to the vote list.
- Every rule in the context pack names a file to read it in. A rule with no source is not a rule, it is an opinion, and a test asserts each one has one.

**Tried, and did not work.**

- Asking triggerHasFired from the watcher's alreadyFired. A reminder delivered on Monday would have silenced that proposal's real trigger for good. Caught by writing the test before the wiring.
- Adding roleFor(key) beside ROLES in read.js. read.js already had roleFor(address) 700 lines further down; the later declaration wins, so everything that asked by address started getting null -- labelFor, the vote scripts, the page. Renamed roleByKey. Before adding a function to read.js, grep read.js for the name.
- Writing a commit message with PowerShell's Out-File -Encoding utf8. It puts a byte order mark on the first line, so commit b1a6fc5's subject begins with an invisible character. The second generation's note about here-strings is the same lesson in another shape: write the message with a file-writing tool, then git commit -F.
- Checking for the string "ctx-arc" in a kolam's SVG to prove the ring was absent. The stylesheet always carries the selector and only the circle is conditional, so the test failed on correct code. Assert on the class attribute, not on the word.

**Open.**

- npm run phone has never been run on this laptop. The Director runs it once: install ntfy on the iPhone, subscribe to the topic it prints, set PEOPLENET_NTFY_URL with the line it gives, restart the server. Until then a due reminder posts its page line and brings the proposal back, and only the phone stays quiet.
- The two live reminders fall due on 2026-09-28 (proposal 61, the Mac and the four chat exports) and 2026-10-05 (proposal 62, the Tamil name, founder pay and the other architects' accounts). Neither has fired. The 28th is the first real proof of the push.
- gbrain's code index is not built for this repository, so scripts/context-pack.js greps and says so. gbrain sync --strategy code would build it; nobody has asked for that yet.
- No browser here, so the new ring on /swarm was verified by rendering the street and one kolam against the live message log, not in a browser. A real browser pass has been owed since the first generation.
- protocol.py does not mirror ctx. It is optional, so the two implementations still agree on everything they are required to agree on.
- Everything the first two generations left open is still open: proposal 50's cloud move waiting on the Hetzner token, the red on 27, 29 and 30, and wren-answer.js sending without --send.

Stands on commit `887dc09`, `ee3bdd1`, `b1a6fc5`, `ed8679f`.
