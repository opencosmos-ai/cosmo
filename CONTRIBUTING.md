# Contributing

*You don't need to write prompts to help shape Cosmo. You only need to have talked to it.*

This repository is Cosmo's constitution: the system prompt, the three voices of
the triad, the Xensō module, and the kaizen practice that refines them. It is
licensed [CC BY-SA 4.0](LICENSE), and it is what the Cosmo at
[opencosmos.ai](https://opencosmos.ai/) actually runs on. Every merged change
here changes how Cosmo meets everyone who talks to it.

---

## First, the honest part

**One person decides what goes into the constitution.** Shalom makes the final
call on every change to the prompts. A pull request here is a **proposal**, and
some will be declined for reasons of voice or consistency that aren't visible
from outside. Better to say so now than after your afternoon's work.

**What you get in return:** Cosmo improves by being told where it failed. The
[kaizen log](kaizen/feedback/notes.md) is built out of exactly that. Its most
important entries began as someone saying "that wasn't right," and a report of
drift is treated as evidence, not as a complaint.

**You're always free to fork.** The share-alike licence means you can take all
of this and build something that disagrees with it. The [Use Policy](USE-POLICY.md)
says what the work was for. It asks, and binds nothing.

---

## Three ways in, easiest first

### 1. Tell us when Cosmo got something wrong — no prompt knowledge needed

**This is the most useful thing most people can do.** If Cosmo:

- claimed to see, remember or know something it couldn't,
- sounded like a sermon, a therapist script, or a customer-service bot,
- flattered you, agreed too easily, or pushed where it should have listened,
- or just didn't feel like a companion that cared,

[open a "Cosmo said something off" issue](https://github.com/opencosmos-ai/cosmo/issues/new?template=cosmo-said-something-off.md).
Paste the exchange (see *Privacy*, below) and say what felt wrong. You don't need
to know why, or have a fix. Running down the cause is our job.

### 2. Share a conversation that went right

The kaizen practice also collects **exemplars**: conversations where a voice was
at its best, used as few-shot examples to steer the rest. The current set leans
contemplative, and practical or challenging conversations are especially wanted.
[Open an "A conversation that went right" issue](https://github.com/opencosmos-ai/cosmo/issues/new?template=a-conversation-that-went-right.md).

### 3. Propose a change to the constitution

If you have a specific edit to a prompt in mind, open an issue first, then a
pull request. A good proposal carries three things:

1. **The conversation it fixes.** A prompt change without a failing exchange
   behind it is a guess.
2. **The smallest edit that fixes it.** These documents are read in full on
   every turn, so every sentence costs something.
3. **What it could break.** A line that tightens one behaviour often loosens
   another. Say which voice, which surface, and which kind of conversation
   you'd watch.

---

## Privacy

Conversations with Cosmo are often personal. **Before pasting one into a
public issue, remove anything that identifies you or anyone else,** and only
share what's yours to share. A paraphrase of the exchange is fine. What matters
is the shape of the failure, not the details of your life.

## Licence

By contributing you agree that your contribution is licensed under
[CC BY-SA 4.0](LICENSE), the same terms as the rest of this repository.

---

## Where else to go

- **An error in a Library text or quote** → [knowledge](https://github.com/opencosmos-ai/knowledge/issues)
- **Something broken on the site** → [opencosmos](https://github.com/opencosmos-ai/opencosmos/issues)
- **How the pieces fit** → the [organization profile](https://github.com/opencosmos-ai)
