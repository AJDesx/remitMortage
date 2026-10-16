# Contract Event Schema Compatibility

The indexer decodes Soroban contract events positionally, so renaming, removing
or reordering an event field can silently break ingestion. Golden fixtures pin
what each contract emits.

## What is pinned

`contracts/event-schemas/<contract>.json` records, for every event the contract
publishes (`env.events().publish(topics, data)`), the topic name, the extra topic
arguments, and the data fields in order. Fixtures are generated from the Rust
source by `contracts/event-schemas/schema.cjs`; `#[cfg(test)]` modules and test
files are ignored. Each fixture also carries a `schemaVersion` and a `changes`
log.

## What fails

`backend/src/__tests__/eventSchemaCompatibility.test.ts` (and
`node contracts/event-schemas/schema.cjs check`) fail when:

- an event is removed or renamed,
- a topic argument or data field is renamed, removed or reordered (**breaking**),
- an event or shape exists in source but not in the fixture (fixture out of date),
- `schemaVersion` has no matching entry at the end of `changes`.

The same suite builds every fixture event as real XDR (`ScVal`s), runs it through
the indexer's `decodeEvent`, and checks the topic, ledger and contract id survive.

## Making an intentional change

1. Change the contract.
2. Additive change (new event/shape): `node contracts/event-schemas/schema.cjs update`
3. Breaking change: update the indexer parser first or together, then
   `node contracts/event-schemas/schema.cjs update --breaking "why this is safe"`.
   This bumps `schemaVersion` and appends the reason to `changes`. Without
   `--breaking` the command refuses.
4. Commit the contract, the fixture, and any indexer change together.

Field names come from the expression in `publish(...)` (`.clone()` and path
prefixes are ignored): renaming the local variable passed as an event field is
treated as a rename on purpose, since that is how field intent is spelled in Rust.

## Known gap

`decodeEvent` reads `borrower`/`amount` from either a scalar value or a map with
`borrower`/`amount` keys. The contracts publish tuple data (for example
`deposit` → `(borrower, amount, deposited)`), so tuple payloads decode with
`amount = null` and the indexer skips them. The suite asserts every event decodes
without error; making the parser read tuple layouts per contract is a separate
change.
