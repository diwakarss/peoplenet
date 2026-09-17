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
| `id` | filled if absent | Stable and unique. `normalise()` makes one from the type and the clock. |
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
```

`protocol.js` loads in Node (`require`) and in the browser (a `<script>` tag,
then `window.GovernanceProtocol`). The governance server validates every `POST`
with it and answers `400` with the list of reasons, so a rejected message always
says why.

The widget mirrors this file as `protocol.py`. The two must agree on the seven
type names, on the four required fields, and on nothing else.

## The endpoints

```
GET  /questions.json     the Director's questions
GET  /answers.json       Wren's answers
GET  /messages.json      agent traffic
GET  /wren-votes.json    Wren's votes with the reason for each
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
