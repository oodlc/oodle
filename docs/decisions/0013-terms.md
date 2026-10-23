# 0013. Terms: one meaning per word

- **Status:** Proposed
- **Date:** 2026-10-23
- **Deciders:** Jean-Philippe LeBlanc (maintainer)
- **Builds on:** [0010. The inventory](0010-capabilities-and-the-inventory.md)

## Context

Statements in the catalog are read by people and acted on by agents. The ambiguity between them sits in the nouns. "Order" can mean a cart being paid for, a paid cart, or a shipment. "Customer" can mean a person or the company with the account. An agent that guesses differently from the team writes code that passes every outcome and still does the wrong thing, because the outcome's statement meant something else. Nothing in the catalog says what a word means.

Detecting nouns in free text needs language models or part-of-speech tagging, and Oodle does neither. But the words that matter most are already in the catalog: the resources the routes act on (`/orders/:id` is about orders) and the actors.

## Decision

1. **A `terms` section**: each term's `id` is the word (singular, lowercase), its `statement` says what it means here, and `aka` lists other words people use for the same thing. Terms take `status: proposed` like the rest of the inventory, and never block.
2. **The vocabulary comes from the system.** The words worth defining are the resources its routes and capability surfaces act on, and its actors' ids, minus plumbing such as `health` or `api`. Oodle matches them in statements by singular form, so "orders" in an intent is "order".
3. **Lint is opt-in.** Once a catalog defines at least one term, each word from the vocabulary that a statement uses and no term (or `aka`) defines is a warning, once per word. A word defined twice, by two terms or a term's `aka`, is an error: one word, one meaning. Catalogs with no terms see nothing new.
4. **The interview asks.** `oodle interview` asks what each undefined word means and which other words people use, after the capabilities, and writes the answers to `oodlc/terms.yaml`. The MCP `answer` tool records a term as a proposal. An agent should never define a word from the dictionary: the point is what this team means.
5. **Terms reach agents.** The drafter's prompt lists them, and `oodle explain` prints the glossary and the words still undefined.

## Options considered

### A. Detect every noun in every statement

- Good: catches words no route names, like "receipt" or "refund".
- Bad: needs a tagger or a model; noisy; Oodle would call a model to lint.

### B. Lint on by default

- Good: every team is asked.
- Bad: every existing catalog gains warnings on upgrade, for words it never chose to define.

### C. Vocabulary from routes and actors; opt-in lint; the interview always asks (chosen)

- Good: grounded in what the system is built around, quiet until a team starts, and the interview brings it up anyway.
- Bad: misses words that name no route. People can add those as terms by hand, and then they count.

## Consequences

- `spec/catalog.schema.json` gains `terms`.
- The interview asks about words before the remaining open questions.

## Revisit if

- Teams want words beyond the vocabulary checked (for example, every term they defined by hand is also flagged where a synonym is used instead).
- Terms need relations ("a refund belongs to an order"), which would make them a small domain model rather than a glossary.
