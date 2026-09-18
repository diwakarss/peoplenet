# The reports a trigger can count

A proposal may carry a trigger, and one of the five rules the watcher
understands is `count:`:

```json
{ "trigger": { "text": "when twenty or more answers have gone stale",
               "rule":  "count:stale-names.json:20" } }
```

The file named there is read **from this directory and nowhere else**. The
watcher resolves the path against this directory and refuses anything that
escapes it, so a rule cannot be written that reads `../../.env`.

This directory has to exist before a `count:` trigger can ever fire, which is
why it is tracked with this file in it. An empty directory is not something git
can carry.

## What a report looks like

Whatever the thing writing it already writes. The watcher reads a count out of
four shapes, because the report belongs to whoever produces it and not to the
watcher:

| The file contains | The count is |
|---|---|
| `42` | the number itself |
| `{"count": 42}` | the `count` field |
| `[ ..., ..., ... ]` | the length of the array |
| one JSON object per line | the number of lines that parse |

Anything else is reported as "cannot read a count out of `<file>`" and the
trigger does not fire. A rule that can never fire says so on every pass rather
than sitting quiet, because a trigger nobody can see failing is worse than no
trigger.

## Writing one

Nothing here writes these files. They come from outside the governance page —
the widget's own runs, a nightly job, a script somebody runs by hand — and land
here under whatever name the `count:` rule refers to. Keep the name stable: it
is quoted inside a proposal that is already on the chain and cannot be edited.

`governance/fixtures/reports/` holds two tiny examples that the checks read, so
the count rule is tested without ever touching a real report.
