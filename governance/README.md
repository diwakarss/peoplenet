# The governance page

Every organisation on the local chain, every proposal on them, who voted and
why, the questions the Director asks and the answers Wren gives, the whole tree
and a search over all of it. Static HTML, ethers v6 from a CDN, no framework, no
build step.

Spec: `LEARNING-MODEL-ARCHITECTURE.md` section 24 (WP17d-UI) and section 27.

Three sections, one click apart:

| | |
|---|---|
| **1. Governance** | The organisations, their members, the message stream, and the proposals with everything the Director can do to one. |
| **2. Structure** | PeopleNet down to the bottommost record, each node with its plain-English line. Branches open in place. |
| **3. Search** | Every organisation, proposal, vote reason, question, answer and agent message. Results open the card. |

One click (27.6a): every function and every piece of information is at most one
click away. A fold is one click. There are no folds inside folds, no modals, and
nothing that needs two.

## Running it

You need two things up: the chain, and the page.

**On a fresh clone, first:** `git config core.hooksPath .githooks`. Git does not
carry hook configuration in a repository, so a clone has the hooks on disk and
none of them installed. The pre-commit hook is the one that refuses a raw
control character in a source file, after two edits made through a shell heredoc
lost the backslashes in a regex and left literal backspace bytes behind — the
regex still parsed, still ran, and quietly matched nothing, and the vote guard it
broke let a real vote reach the chain. `npm run governance:check` runs the same
check, so it is not lost on a clone where nobody ran that line, but the hook is
what catches it before the commit rather than after.

```bash
npm run node                    # terminal 1 -- Hardhat node on 127.0.0.1:8545 (chain id 31337)
npm run deploy:local            # once, if the diamond is not deployed yet
npm run governance:members      # once, puts the three roles on AAO 0
npx hardhat run scripts/create-widget-builder-aao.js --network localhost   # once, the sub-AAO
npm run governance              # terminal 2 -- http://127.0.0.1:8787
```

Then open <http://127.0.0.1:8787>. The page redraws on every new block, so a vote
cast from a script shows up without a reload.

Two more commands worth knowing:

```bash
npm run governance:check        # render the data layer in the terminal and assert it
npx hardhat test test/governance/tiebreak.test.js
```

### Two commands that must not be run in the foreground

An agent session is killed by a watchdog if a single command goes ten minutes
without printing anything. Exactly two commands here do that, and both have a
form that does not.

**The server never returns.** `npm run governance` serves until it is stopped,
so start it detached and leave it:

```bash
# stop whatever is already on 8787, then start the server in its own process
powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id \$_.OwningProcess -Force }"
powershell -NoProfile -Command "Start-Process node -ArgumentList 'governance/server.js' -WindowStyle Hidden"

# then check it came up, which returns immediately
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8787/
```

**The full test run is long.** `npx hardhat test` takes tens of seconds to
minutes and prints nothing useful until the end, so send it to a file in the
background and poll that file with short commands:

```bash
npx hardhat test > /tmp/hardhat-test.log 2>&1 &
tail -5 /tmp/hardhat-test.log        # repeat; short, returns at once
grep -E "passing|failing" /tmp/hardhat-test.log
```

## The question channel

The fastest path between the Director's doubt and Wren's answer.

On any proposal card there is one input and one button. The Director asks; the
page posts it to `POST /questions`; the server appends it to
`governance/questions.jsonl` within milliseconds. Wren watches that file and
answers:

```bash
node scripts/wren-answer.js --list       # the open questions
node scripts/wren-answer.js q-abc123 "Internal only; nothing the operator sees moves." \
     --details "citations.py builds the key from mtime; the helper builds it from (path, size, mtime_ns)." \
     --ref "spec 27.1" --send
```

It rehearses without `--send`, like every other write script here, and the
rehearsal prints the answer it would file. Until proposal 103 this one sent the
moment it was run: Kural nearly answered the Director on the live record
reaching for a `--dry-run` it did not have, and `answers.jsonl` is append-only,
so a line written by mistake stays written.

The page polls every two seconds, so the only latency the Director feels is
Wren's own reading time. The answer appears under the question, with `--details`
behind one fold.

**After an answer** the Director gets the two moves 27.2 names:

- **Close as tie** — `executeProposal`, offered only on a level tally, which a
  level tally rejects. It is the deliberate way to say no.
- **Ask for a new proposal** — files a `request-new-proposal` message, shown as
  such, for the proposer to answer with a revised proposal that links the old one.

**To watch a question land the instant it arrives**, watch the file, or the
endpoint:

```bash
# the file, one JSON object per line, appended the moment the Director clicks Ask
tail -f governance/questions.jsonl

# or the endpoint the page reads, re-read from disk on every request
curl -s http://127.0.0.1:8787/questions.json
```

## Filing a proposal

Three ways in, one format and one validator behind all of them:

```bash
node scripts/propose.js --file proposal.json --dry-run        # validate only
node scripts/propose.js --title "..." --summary "..." --why "..."
node scripts/submit-widget-proposals.js --dry-run             # a whole batch
```

and the **File a new proposal** fold on the page, which signs with account 0.
See "The proposal format" below.

## Images on a draft

The fold takes one picture beside the words (proposal 54). Paste a screenshot
with Ctrl-V anywhere in the open fold, drop a file on it, or tab to
**Paste, drop or choose an image** and pick one. PNG or JPEG, up to 5 MB, one
at a time — a second paste replaces the first. A draft sent without one works
exactly as it always did; the image is optional and there is still only one
field to fill in.

**What is kept, and where.** The image is written to `governance/inbox/`,
named after the id the server generated for the draft. The file name the
browser sent is dropped and never stored. The draft's line in `drafts.jsonl`
gains a pointer, not a picture:

```json
"image": { "path": "inbox/draft-abc123.png", "sha256": "…", "bytes": 48213, "type": "image/png" }
```

What kind of file it is, is decided by its first bytes, not by what the browser
called it. The 5 MB limit is enforced again on the server, on the decoded
length.

**For how long.** Two things end it. `scripts/wren-file-draft.js` deletes the
file as it files the proposal, and writes `image_deleted` with the hash into
the filed record — the hash is the only part of a screenshot that should
outlive the proposal it explained. And the server sweeps the inbox at start and
then hourly, removing anything over 24 hours old, with one line in the log
saying how many. A rehearsal (`--dry-run`) deletes nothing; it says what the
real run would take.

`governance/inbox/` is in `.gitignore`.

**What it is for.** The image is a note to the one architect who has to turn
the Director's sentence into a title, a why and the technical detail. It is not
part of the record. The record is the words.

**The rule that matters.** A screenshot is usually a ticket, so it may carry a
customer's name, an email address or a credential. It stays on this machine: no
route serves it, nothing commits it, and it never goes on the chain. And the
architect completing the draft **must not transcribe names, emails or secrets
out of the image into the proposal's text** — the proposal is public, permanent
and unamendable, and the picture exists so that it does not have to be.

## A builder and its context

Proposal 96. A builder is one long session with a fixed memory. When it fills,
the builder stalls or starts forgetting mid-item with work uncommitted. Four
parts, and none of them is a reminder to be careful.

**The budget.** Every status a builder posts carries `ctx`, how full it is, a
whole number 0 to 100. `/swarm` shows it beside the three words and as a ring
on the kolam: amber from 60, red from 75. At amber the builder finishes the
item in hand and hands over; it never starts an item above 70.

**The ledger.** One file per agent, `governance/ledger/<agent>.md`, appended at
every stop and never edited — a correction is a later section.

```bash
node scripts/ledger.js --agent kalam \
  --item "proposal 99, reminders" \
  --decided "A reminder fires on a proposal that reminder itself closed." \
  --tried "Asking triggerHasFired from the watcher; it silences real triggers." \
  --open "94 and 98 now point at 61 and 62, which are still waiting." \
  --commit b1a6fc5 --send
```

Item, decided, open and commit are required. Tried is not: a stop where nothing
was abandoned is an ordinary stop. Open is required because a hand-over loses
what was never written down, and a builder that cannot state what is open has
not stopped cleanly.

**The hand-over.** Rotation is ordinary, so it has a command.

```bash
node scripts/handover.js --agent kalam --item "proposals 99 and 96" \
     --open "the reminders on 61 and 62 have not fired" --commit b1a6fc5 --send
```

It refuses until the ledger exists and carries a section, writes one decision
to the stream — *"Kalam hands over at generation 3"* — and prints the id the
successor must acknowledge in its first message. *"I read the ledger"* is a
claim; *"I acknowledge decision-abc123"* is a claim about a record that either
exists or does not. The generation number lives on the role in `read.js`, not
in a message that scrolls away.

**The context pack.** What one item needs, and no more.

```bash
node scripts/context-pack.js 99
```

The proposal, everything said on it, the files it names, who else touches the
symbols it names, and the rules attached to the capabilities it will use. The
callers come from gbrain's code index when that index is built for this
repository and from a grep of the repository when it is not, and the pack says
which — a pack that quietly changed its source would be a pack whose gaps
nobody could see.

Every rule in the pack is an incident, and every one names where to read it.

## Reminders

Proposal 99. A reminder is not a proposal: the Director never files one and
never votes on one. He writes a waiting note with a time in it — *wait a week*,
*remind me Thursday* — and the organisation's architect sets it:

```bash
node scripts/remind.js set 61 --due 2026-09-28T03:30:00Z \
     --text "The Mac and the four chat exports." --send
node scripts/remind.js list
node scripts/remind.js move remind-mu... --due 2026-10-05T03:30:00Z --send
node scripts/remind.js cancel remind-mu... --send
```

It rehearses without `--send`, like every other write script here, and only the
architect named in the organisation's rule set may set, move or cancel one —
the same rule that files a draft (89) and answers a question (90), read out of
`read.js` so all three refuse the same thing for the same reason.

`governance/reminders.jsonl` is append-only. Moving a reminder appends a line;
cancelling one appends a line. The latest line for an id is the reminder, and
the file order decides, not the clock.

When one falls due the watcher does three things: it pushes to the Director's
phone, it posts a line from `watch` under the card, and that line counts as a
fired trigger, so a reminder set on a live proposal brings it back into his
vote list. A reminder on a closed proposal does not fire — unless the proposal
was closed *by that reminder*, which is how proposals 94 and 98 still ring.

### The phone, and the one secret here

```bash
npm run phone            # sets it up and prints the three steps
npm run phone -- --test  # one push, to prove it rings
```

The push goes to an [ntfy](https://ntfy.sh) topic. **The topic name is a
secret**: an ntfy topic has no password, so anyone who knows the name can read
everything posted to it. It is read from `PEOPLENET_NTFY_URL` and from nowhere
else — not this repository, not a message, not a log line, not a test, not a
report. `npm run phone` prints it on this laptop's screen and keeps it in one
file under the user profile, outside the repository.

That is why the push carries a title and a proposal number and nothing more:
someone who guesses the topic learns that proposal 98 came due, not what it
says. `governance/push.js` runs every line it reports through `redact()`,
because a failed fetch names the host it could not reach and that error would
otherwise be copied straight into an incident on the record.

`PEOPLENET_NTFY_URL` unset is not a failure. The push is skipped, said once,
and the other two things still happen.

## The two organisations

| AAO | Topic | Members | What happens there |
|---|---|---|---|
| 0 | `trilogy widget` | Director, Wren, Casting vote | The Director decides what the widget should become. |
| 1 | `widget-builder` | Director, Wren, Builder, Widget | The widget, its builder and Wren work out what to propose. |

The page lists both; one click switches. The sub-AAO's view carries the message
stream, where the agents' incidents, statuses and decisions read as one timeline
alongside the questions and answers. The widget votes there on proposals that
touch its own behaviour.

`scripts/create-widget-builder-aao.js` creates it and joins accounts 0, 1, 3 and
4. It is idempotent.

## The proposal format

Since 27.1 a proposal is a JSON document stored as the on-chain text:

```json
{
  "title":     "One line.",
  "summary":   "Two to four sentences, plain English, written for a person.",
  "why":       "The reason, in plain English.",
  "technical": "The details. Free form, kept whole.",
  "risk":      "One line.",
  "effort":    "One line.",
  "refs":      ["spec 27.1", "https://example.invalid/ticket/1"],
  "from":      "director",
  "filed_at":  "2026-09-17T06:40:43.000Z"
}
```

`title`, `summary` and `why` are required. `scripts/propose.js`,
`scripts/submit-widget-proposals.js` and the page's form all refuse without
them, through the same `validateProposalDoc()` in `read.js` — one rule, not
three.

The page shows the title and the summary first, then the why, then one fold for
the technical, risk and effort, then the refs, with URLs as links.

Proposals filed before 27.1 are free text. They render exactly as they were
written, marked **legacy format**. Nothing has been re-filed.

## The protocol

All agent traffic — incidents, statuses, questions, answers, decisions — is one
message shape, documented in [`PROTOCOL.md`](PROTOCOL.md) and validated by
`protocol.js`, which the server, the scripts and the page all share. A message
without a subject and a summary is refused with the reasons.

## Notifications

The page asks once for permission, from a button in the header, and then tells
the Director about the four things 27.7 names: a new proposal, an answer to a
question they asked, a tally that reached a tie and awaits the casting vote, and
a passed proposal the builder has picked up. Each names the proposal and opens
its card.

### The keys

The page signs by asking the Hardhat node for a signer on one of the node's own
unlocked accounts. It holds no private key, asks for none, and shows none. The
keys involved are Hardhat's published defaults, worth nothing outside a local
chain, and the approach only works against a node that unlocks its accounts --
which is exactly why it cannot follow this page anywhere real. A banner at the
top of the page says so.

Reads are free and happen on their own. Every write is one deliberate click.

## The three roles

All three are Hardhat default accounts, all three are members of AAO 0, and the
contract gives each of them exactly one vote.

| Role | Account | Address | Votes how |
|---|---|---|---|
| **Director** | 0 | `0xf39Fd6e5…92266` | The operator, from the page. Also the deployer and the AAO's creator. |
| **Wren** | 1 | `0x70997970…c79C8` | The architect session, from `scripts/wren-vote.js` only. Never from the page. |
| **Casting vote** | 2 | `0x3C44CdDd…293BC` | The Director's tie-break. The page only offers it on a tie. |

Wren states the reason in the chat first, then casts:

```bash
node scripts/wren-vote.js 3 for "The cache key is the real fix; the rest is a workaround." \
     --ref "commit 1f8076d" --ref "spec 27.1" --send
```

The vote goes on chain and the reason is appended to `governance/wren-votes.jsonl`
with the tally it produced, so the record and the number stay together.

### What a vote was cast against

`--ref` is repeatable, and it is what makes a reason checkable rather than merely
recorded. A commit, another proposal, a spec entry, an incident id, a URL — free
form, exactly as a proposal's own refs are.

This was proposal 29, and the builder asked for it after finding its own vote on
proposal 26 unanchored: the reason said what it thought without saying what it
had read, so nobody could check it against the commit. A reason is the half
another agent can answer; the refs are what they answer it *against*.

Both vote scripts take it, both rehearsals say what the record would point at,
and a vote cast without one prints *"The record would point at nothing. Pass
--ref to say what you read."* — so silence is a choice and not an oversight.

Records written before proposal 29 carry no refs. The logs are append-only, so
they stay that way, and the card says *no references recorded* rather than
leaving a blank that could be read as "nothing to read".

### One vote script

All three agents vote through `governance/vote.js`, which is told which account
it is:

| Script | Account | Log | Default organisation |
|---|---|---|---|
| `scripts/wren-vote.js` | 1 | `wren-votes.jsonl` | AAO 0 |
| `scripts/builder-vote.js` | 3 | `builder-votes.jsonl` | AAO 1 |
| `scripts/widget-vote.js` | 4 | `widget-votes.jsonl` | AAO 1 |

Each of those files is about twenty lines that say who it is, and nothing else.
Everything a vote actually does — the argument parsing, the `--ref` flag, the
dry-run **default**, the account check, the membership check, the standing check
against the rule in force, the unfiled-id guard, the drift check, the
casting-vote condition, the record with the tally it produced — lives once.

This was proposal 30, filed by the builder about code it had just written:
`builder-vote.js` was `wren-vote.js` with two names changed, so the guard against
voting on an unfiled id had to be written twice and `--dry-run` had to be
remembered twice. A check that lives in two places is one edit away from living
in one and a half.

`widget-vote.js` is what the proposal bought: the widget had a vote under 27.4
and no way to cast one, which is also why AAO 1 needed an interim rule at all.
Its first vote through that script is what ends the interim rule.

Where a voter genuinely differs — Wren is the casting vote on the widget-builder
and the others are not — the difference is read out of `read.js`'s rule set, not
written into the script, so the page and the scripts refuse the same things for
the same reasons.

### The voters' reasons on the page

Every proposal card carries Wren's line under the tally: **Wren voted FOR** or
**AGAINST**, with the reason quoted, then what it was cast against, or *Wren has
not voted* when there is no record. The tally is the chain's; the reason is
Wren's argument for it, and the Director is meant to weigh the second, not just
count the first.

The builder's line sits under it, in the same shape, on the organisations where
the builder votes, and the widget's under that. The builder's reasons were being
written to `builder-votes.jsonl`, which nothing served and nothing showed;
`GET /builder-votes.json` and `GET /widget-votes.json` serve them now and **one**
function on the page renders all three, so they cannot drift apart.

A voter's line appears only where that voter actually votes, and only once it
has: an empty *"Builder has not voted"* on every card of an organisation the
builder is not on would be noise, not information.

The page gets it from `GET /wren-votes.json`, which `server.js` re-reads off
`wren-votes.jsonl` on **every** request &mdash; `wren-vote.js` appends to that
file while the page is open, and a cached copy would quietly show the operator a
stale argument. The endpoint is read-only; nothing served here ever writes the log.

The log is append-only, so a second record for the same proposal is a correction
and the latest one is shown (by the record's `at`, falling back to file order). If
a record's direction disagrees with the `VoteCast` event on chain, the card says
so and tells you to trust the chain.

Opened over `file://`, or with the server down, the page loses the reasons and
keeps everything else.

### Hiding what is finished

**Hide closed**, above the proposal list, drops everything that is not Active. The
count then reads `(3 of 12)` so you can see what is hidden. The preference is
remembered per browser in `localStorage` and affects nothing but this list.

## The widget-builder's two rules

AAO 1 has two rule sets, and which one is in force is not a setting anybody can
change. It is read off the chain, by `effectiveRules()` in `read.js`, from one
fact: **has account 4, the widget, ever cast a vote on this organisation?**

| | The interim rule (now) | The standing rule (once the widget votes) |
|---|---|---|
| Who votes | Builder and Wren | Builder and Widget |
| Wren | an ordinary voter | breaks a level tally, and nothing else |
| The widget | may vote at any time; nothing waits for it | one of the two voters |
| The Director | watches | watches |
| A level tally | no tie-breaker; the proposal is pinned | Wren breaks it |
| A lone vote carries after | 1 hour | 24 hours |

The interim rule exists because the widget's add-on does not: account 4 has never
cast anything, so nothing on AAO 1 could ever reach "both have voted", and three
proposals sat there with no exit. It ends the moment the widget votes once. There
is no flag to unset, and nobody has to remember — which is the point.

The regime in force is printed as a sentence on the AAO's header on the page, and
`wren-vote.js` prints it before it checks anything.

### The window runs from the first vote

Both rules carry a window: a decisive tally with one voter missing carries once
the window has passed. That window is measured **from the first vote**, never
from the filing.

Measuring it from the filing is what closed proposals 26, 29 and 30 on
2026-09-17 within six minutes of the builder voting on them: they had been filed
days earlier, so the window had "already passed" before anybody voted, and the
first vote executed them on the spot. The window exists to give the other voters
and the Director time to react to a vote, so it starts when there is a vote to
react to.

A vote whose block timestamp cannot be read starts no window at all, and the
watcher says so rather than guessing. A missed pass costs five minutes; an early
execution closes a proposal nobody can reopen.

`test/governance/watch.test.js` pins all of this on the in-process network, under
both rules.

## The tie rule

`AAOFacet` is one member, one vote, and `executeProposal` passes a proposal only
on `forVotes > againstVotes`. A 1&ndash;1 tie therefore **rejects**. There is no
tie-break in the contract, and WP17d deliberately did not add one.

So the tie-break lives in membership instead: a third member, account 2, that
exists for nothing else. The page enables its two buttons only when all of this
is true:

1. the proposal is still Active,
2. both ordinary members (Director and Wren) have voted,
3. their votes are level (`forVotes == againstVotes`),
4. the casting account has not already voted.

Nothing on chain enforces that. The chain just sees a third member with one vote,
like everyone else -- it cannot vote twice, and it cannot turn a 2&ndash;0 into a
2&ndash;2. The rule is the page's, it lives in one function,
`castingVoteState()` in `governance/read.js`, and `test/governance/tiebreak.test.js`
pins down both halves: what the chain does (the same 1&ndash;1 tie rejects on
execute, and passes once the casting vote is cast) and what the rule does (it
refuses to offer the casting vote when there is no tie).

`Execute` is a separate, later click. It calls `executeProposal` from the Director
and then shows the outcome the chain reported in its `ProposalExecuted` event --
not a prediction, the event. Once executed a proposal is closed for good.

## The files

| File | What it is |
|---|---|
| `read.js` | The data layer. `require()`-able from Node, `<script>`-able in the browser. Owns the ABI, the role labels, the reads, and `castingVoteState()`. |
| `app.js` | The page. Renders, wires the buttons, refreshes on every block. |
| `index.html`, `style.css` | One column, proposal cards, tally bars, status chips. |
| `server.js` | A loopback static server for this directory, plus the log endpoints. `npm run governance`. |
| `protocol.js` | The one message shape (27.5) and its validator, shared by the server, the scripts and the page. |
| `PROTOCOL.md` | What that shape is, who sends what, and where each log lives. |
| `questions.jsonl` | The Director's questions, appended by `POST /questions`. |
| `answers.jsonl` | Wren's answers, appended by `scripts/wren-answer.js`. |
| `messages.jsonl` | Agent traffic, appended by `POST /messages`. |
| `drafts.jsonl` | The Director's one-field drafts, appended by `POST /drafts`, and the record of what each became. A draft that carried an image holds a pointer to it and its hash, never the picture. |
| `inbox/` | Images pasted onto a draft. Untracked, never served, swept after 24 hours, deleted as the draft is filed. See "Images on a draft". |
| `check.js` | Runs `read.js` against the live node **and** the served endpoint, prints what the page would show, asserts the AAO, the three members, the proposal floor, and Wren's twelve records. |
| `vote.js` | One vote script, told which account it is. `wren-vote.js`, `builder-vote.js` and `widget-vote.js` are wrappers on it. |
| `wren-votes.jsonl` | Wren's votes with their stated reasons and what each was cast against, one JSON object per line. |
| `builder-votes.jsonl` | The builder's, in the same shape, served at `/builder-votes.json` and rendered by the same function. |
| `widget-votes.jsonl` | The widget's. It does not exist until the widget's first vote; the endpoint answers `[]` until then. |
| `watch.js` | The trigger watcher, the due reminders, and the automatic execution of what the rules say is decided. Runs with the server. |
| `reminders.js` | What a reminder is: the shape, the four states, the rule that a later line supersedes an earlier one, and when one falls due. |
| `reminders.jsonl` | The reminders, appended by `scripts/remind.js` and by the watcher when one fires. Served read-only at `/reminders.json`; nothing a browser can click writes one. |
| `push.js` | The only way a message reaches the Director's phone, and the reason the topic can stay a secret. Reads `PEOPLENET_NTFY_URL` and nothing else. |
| `ledger.js` | What a builder's ledger section holds, and what a hand-over record says. |
| `ledger/` | One markdown file per agent, appended at every stop. The memory that outlives the session. |
| `context-pack.js` | What goes in a context pack: the files a proposal names, the symbols it names, and the rules attached to each capability it will use. |
| `reports/` | Where a `count:` trigger reads from, and the only place it may read from. Tracked, with a README, because git cannot carry an empty directory and a `count:` rule cannot fire without it. |

`read.js` is the join: the page, `check.js`, and the Hardhat test all read through
the same functions, so a change that would break the page breaks a test first.

## Notes

- `check.js` asserts **at least** seven proposals, the seven WP17d builder
  suggestions AAO 0 was seeded with. Proposals only ever get added, and other
  sessions file more as the work goes on, so a floor is the honest assertion.
  Set `GOVERNANCE_EXPECTED_PROPOSALS=12` to demand an exact count instead.
- `AAOFacet.joinAAO` is open: the creator approves nobody, each account joins for
  itself. `scripts/setup-governance-members.js` is idempotent for that reason.
- The AAO struct has no `createdAt`, so the page takes it from the block that
  carried the `AAOCreated` event.
- The facet has no `proposalCount` getter, so the proposal list comes from
  `ProposalSubmitted` events and the tallies come from `getProposal` -- the page
  always shows the chain, not the event history.
- `check.js` also asserts `/wren-votes.json` returns twelve records, so
  `npm run governance` must be up when you run it. Override with
  `GOVERNANCE_EXPECTED_WREN_VOTES`; point it elsewhere with `GOVERNANCE_URL`.
- `GOVERNANCE_PORT` and `GOVERNANCE_HOST` override the server's defaults.
