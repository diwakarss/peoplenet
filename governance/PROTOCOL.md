# The agent message protocol

One message shape for all agent traffic, on files and on chain. Spec section 27.5.

The widget, the builder, Wren and the Director all write the same object. The
governance page renders any message of this shape without knowing who sent it or
why. A validator refuses a message without a subject and a summary, and that is
the whole enforcement: if an agent cannot say in one line what this is and in
plain English what it means, the message is not ready for a person to read — and
a person is who reads this.

## The shape

```json
{
  "id":      "incident-mu552yt0-5c63un",
  "ts":      "2026-09-17T06:31:44.108Z",
  "from":    "widget",
  "to":      "wren",
  "type":    "incident",
  "subject": "Citations went stale for one turn after a KBA edit",
  "summary": "A KBA article was edited while the widget was answering; the citation cache kept the old body for one turn, so the answer quoted text that no longer existed.",
  "details": "citations.py built its cache key from mtime only; the edit landed inside the same second, so the key did not change.",
  "refs":    ["incident-2026-09-17-03"]
}
```

| Field | Required | What it is |
|---|---|---|
| `id` | filled if absent | Stable and unique. `normalise()` makes one from the message's own content — see [The id](#the-id). |
| `ts` | filled if absent | ISO 8601, when it was written. |
| `from` | **yes** | Who wrote it: `widget`, `builder`, `wren`, `director`. |
| `to` | defaults to `all` | Who it is for, same vocabulary, or `all`. |
| `type` | **yes** | One of the seven below. |
| `subject` | **yes** | One line. What this is about. |
| `summary` | **yes** | Plain English, for a person. Two to four sentences. |
| `details` | no | The technical part. Free form, kept whole, rendered behind one fold. |
| `refs` | no, array | Tickets, commits, incidents, spec entries. URLs render as links. |

`from` and `to` are not restricted to the four known names — a new agent should
not need a code change to speak — but the known ones get proper labels.

## The id

**An id is made from what the message says, not from when it was written.**

```
id = <type> "-" first 14 hex characters of sha256(<the canonical form below>)
```

This was proposal 26 on the widget-builder, and it was carried. Before it,
`protocol.js` numbered a message by its type and the clock and `protocol.py`
numbered the same message by its type and a fingerprint of its content. Both
worked and they disagreed: a message written twice — a retry after a crash, a
script re-run — was two messages on one side and one on the other. The incident
log decides what the builder builds next, so a doubled record counts a rejection
twice and can invent a builder item that never happened. The fingerprint scheme
makes a retry free; the clock scheme cannot.

### What goes into it

Six fields, and only these:

```
from, to, type, subject, summary, details
```

`ts` is deliberately out: a retry gets a new clock and must keep its id. `refs`
are out too — a later correction may add a reference without changing what was
said.

The digest is taken over the fields written the way Python's
`json.dumps(sort_keys=True, ensure_ascii=False)` writes them, **including the
space after each `:` and `,`**, because the digest is over those bytes:

```
{"details": "", "from": "widget", "subject": "S", "summary": "P", "to": "all", "type": "incident"}
```

A field that is absent is `null`, as Python's `dict.get` gives `None`. The type
is prefixed with its whitespace collapsed, or `msg` when there is none. The id
above is `incident-5d629ac9f82cca` in both implementations.

`normalise()` fills the id **last**, after `to` and `details` have their final
values, because it is a fingerprint of them. Both implementations do this in the
same order for the same reason.

> **On the length.** Proposal 26's text says `sha256(content)[:12]`.
> `protocol.py` has always used 14, and the whole purpose of the proposal is
> that the two implementations produce the *same* id — so the code matches the
> widget and this line records the correction. Twelve would have been a
> different scheme wearing the same name.

### When six fields are not the whole identity

The six are what a message *says*, and for the traffic both implementations
write — incidents, statuses, decisions — they are all of it.

Some shapes carry more. A question on the question channel is the Director's
words **about a particular proposal**: "Why?" asked on proposal 3 and "Why?"
asked on proposal 5 are two questions, not one, and hashing only the six would
give them one id that every answer would then point at twice. So a writer may
name further fields that belong to the identity:

```js
P.normalise(message, { idFields: ["proposal", "aaoId"] })   // the question channel
P.normalise(message, { idFields: ["question"] })            // wren-answer.js
```

It is an extension of the scheme, not a second one: the key list is still
sorted and canonicalised the same way, so `protocol.py` handed the same field
list gives the same id.

**The rule:** any message type that more than one implementation writes uses the
six alone. Otherwise both sides have to agree on the extras too, and an
agreement nobody wrote down is not one.

### Where it is checked

`governance/check.js` holds six ids computed by the widget's `protocol.py` —
including non-ASCII and the characters JSON has to escape — and asserts
`protocol.js` reproduces every one. If either side's field set, canonical form
or digest length drifts, that check goes red before anything is written under
the wrong number. It also asserts the digest against Node's own `crypto`,
because `protocol.js` carries its own SHA-256: it loads in the browser too,
where the platform's is asynchronous and an id cannot wait for it.

### The records written before this

They keep their clock-based ids. The logs are append-only — nothing rewrites a
line — so the two schemes sit side by side in the files, and both are opaque
strings to everything that reads them. What still holds of every record, old or
new, is that no two messages answer to the same name.

`P.newId(prefix)` remains for the few things that are **not** messages and have
no content to fingerprint — a draft awaiting Wren, a filing record. A message's
id comes from the content, never from there.

## The seven types

| `type` | Who sends it | What it means |
|---|---|---|
| `incident` | widget | Something went wrong and here is what was seen. |
| `status` | builder | Work in progress. Nothing is needed from anyone. |
| `proposal` | any | A change being asked for. On chain this is a 27.1 proposal document. |
| `question` | director | A question about a proposal, through the page. |
| `answer` | wren | An answer to one, through `scripts/wren-answer.js`. |
| `decision` | any | An outcome: executed, rejected, or picked up by the builder. |
| `request-new-proposal` | director | This proposal is not it; file a revised one that links it. |

Anything else is refused by name, so a typo does not become a silent new type.

## Where the messages live

| File | Written by | Read by |
|---|---|---|
| `governance/questions.jsonl` | the page, `POST /questions` | the page, `wren-answer.js --list` |
| `governance/answers.jsonl` | `scripts/wren-answer.js` | the page |
| `governance/messages.jsonl` | any agent, `POST /messages` | the page's message stream |
| `~/.gbrain-widget-incidents.jsonl` | the widget | Wren and the builder |
| the on-chain proposals | the filing scripts and the page | everyone |

All of them are JSON Lines: one message per line, append-only. Nothing edits or
deletes a line, so the file is the record and git can hold it. A message that
needs correcting is superseded by a later one, not rewritten.

## Validating

```js
const P = require("./governance/protocol.js");

P.validate(message);      // -> { ok, errors: [...] }   never throws
P.assertValid(message);   // throws with the reasons
P.normalise(partial);     // fills id, ts, to, details, refs; touches nothing else
P.parseJsonl(text);       // -> { records, skipped }    skips blank and broken lines
P.toJsonl(record);        // one line, newline-terminated

P.messageId(message);     // the id, from the content -- see "The id" above
P.canonicalForId(message);// the exact bytes the digest is taken over
P.sha256Hex(text);        // the digest, in plain JS so the browser has one too
```

`protocol.js` loads in Node (`require`) and in the browser (a `<script>` tag,
then `window.GovernanceProtocol`). The governance server validates every `POST`
with it and answers `400` with the list of reasons, so a rejected message always
says why.

The widget mirrors this file as `protocol.py`. The two must agree on the seven
type names, on the four required fields, and — since proposal 26 — on how a
message is numbered. On nothing else.

## The endpoints

```
GET  /questions.json     the Director's questions
GET  /answers.json       Wren's answers
GET  /messages.json      agent traffic
GET  /wren-votes.json    Wren's votes, each with its reason and its refs
GET  /builder-votes.json the builder's, in the same shape
POST /questions          { proposal, aaoId, text, type? }  -> a question message
POST /messages           a full protocol message
```

Every log is re-read from disk on each request and served `no-store`: the
scripts append while the page is open, and a cached copy would quietly show the
operator a stale thread. The page polls the three message logs every two
seconds, so the latency between Wren answering and the Director reading it is
Wren's own reading time.

`POST /questions` takes the short form and builds the full message: it carries
both the 27.2 question fields (`proposal`, `from`, `text`, `at`) and the 27.5
envelope, so the same file reads as a thread and as agent traffic.

## What this protocol is not

It is not a transport. There is no delivery guarantee, no acknowledgement and no
ordering beyond the timestamp each writer puts on. It is a shape, so that four
agents and one person can read each other without four parsers.
