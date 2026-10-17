# Security Policy

## Scope and honest status

Cachet targets the Zcash ZSA **testnet and regtest** environments. It is not
audited, it depends on alpha protocol libraries, and it must not be used with
mainnet keys or value-bearing assets. Security reports are welcome all the
same — building the reporting habit before mainnet is the point.

There is no mainnet to retarget to yet, and reaching one is more than a
configuration change. Since NU6.3 (Ironwood, July 2026) mainnet's Orchard
pool is sealed: funds can only leave it, so OrchardZSA, which extends
Orchard, has no mainnet pool to deploy into as specified. ZSA has to be
carried over to the Ironwood pool (or a successor), in a transaction
format that can hold it (mainnet's v6, ZIP 229, cannot). A mainnet Cachet
means rebuilding against that ported stack and re-reviewing what this
policy covers against it.

## Threat model: the web-wallet caveat

The mint studio's guarantee is "your keys never leave the page" — and
the honest limit of that guarantee is the page itself. **A compromised
console could serve malicious page code; seeds typed into a compromised
page are at risk.** This is the structural cost of every web wallet, and
we state it rather than hide it.

Mitigations in place: the console is open source (MIT), the wasm engine
is built by the same single script CI runs (a served asset can be diffed
against a rebuild), a strict Content-Security-Policy limits what a page
can do, and the public instance holds nothing that helps an attacker
mint as anyone else (asset ids derive from user keys it never sees).
The engine a mint executes (the worker and the three wasm builds) is
committed to the repository, listed with its hashes in
`console/public/engine-manifest.json`, and `python scripts/verify-site.py`
checks that a live site serves exactly those bytes. It does not cover the
console's own JavaScript, which the Next.js build does not yet produce
reproducibly: the engine is where keys are derived and transactions are
signed, the application is where the seed is typed. Planned hardening:
signed releases and a reproducible application bundle. The strongest
mitigation is already available: run your own instance. Short of that,
the mint page can hand over the signed transaction instead of relaying
it, and any instance's relay (or any tool that assembles a block for the
node) can land it — this instance is a convenience, not a chokepoint.

## Running your own instance safely

If you self-host Cachet, the defaults are chosen to fail safe, but three
things are on you:

- **Writable instances have no built-in authentication.** With
  `CACHET_READ_ONLY` unset, the API exposes wallet-signing endpoints
  (mint, transfer, burn) to anyone who can reach the port. The server
  therefore **binds `127.0.0.1` by default** — it will not accept network
  connections until you set `CACHET_BIND` (e.g. `0.0.0.0`), and it logs a
  warning if you bind a writable instance to a non-loopback address. A
  writable instance reachable from the network **must** sit behind an
  authenticating reverse proxy. The public deployment avoids the question
  entirely: `CACHET_READ_ONLY=1` plus a throwaway seed.
- **Client-IP headers are trusted only behind a proxy.** The rate
  limiter and the per-client write-path throttles (uploads and relays are
  budgeted per client, relays capped in flight, all answering 429) key on
  the real peer address by default; set `CACHET_TRUST_PROXY=1` **only**
  when a reverse proxy you control sits in front and rewrites
  `X-Forwarded-For` / `X-Real-IP` (the
  shipped Caddyfile does). Setting it while directly exposed lets an
  attacker spoof the header and bypass every limit. The throttles never
  hold the address itself: their key is a salted hash whose salt is drawn
  at process start and never written down (PRIVACY.md P2).
- **The admin token is a moderation remote control.** With
  `CACHET_ADMIN_TOKEN` set, anyone holding the token can hide and unhide
  content on your registry, and can purge a bundle's bytes from disk (the
  one irreversible action, meant for content an operator must not retain:
  the moderation entry stays so the bytes are refused if re-uploaded, and
  the daily dumps keep a copy for up to seven days unless you delete them
  too), and can pause and resume minting through the instance (the
  relay and metadata uploads answer 503 while paused; the chain is
  unaffected, and the decision survives a restart). Availability only —
  it can never alter or spend anything. Generate it randomly
  (`openssl rand -hex 32`) and treat it like a password. Tokens shorter
  than 32 characters are
  **refused**: the server logs a warning and leaves the admin surface
  disabled rather than accept a guessable one. Unset, the admin routes
  answer 404 and the surface does not exist — that is also the right
  setting if you moderate over SSH only. The routes sit behind the same
  per-client rate limit as the rest of the API, and the token is
  compared in constant time.
- **Keep secrets to the machine.** `POSTGRES_PASSWORD`,
  `CACHET_SEED_PHRASE`, `CACHET_SNAPSHOT_KEY` and, when configured,
  `CACHET_ADMIN_TOKEN` all live in a gitignored `.env.prod` (the deploy
  script `chmod 600`s it on the server); Postgres
  is never published to the host; the dev stack binds its database and
  regtest RPC to loopback. Use a throwaway seed for any public instance.

## Reporting a vulnerability

- Use GitHub's **private vulnerability reporting** on this repository
  (Security → Report a vulnerability), or
- email `cachet_zec@proton.me` with subject `[cachet-security]`.

Please include reproduction steps and an impact assessment if you can.
You will get an acknowledgement within 72 hours. Please do not open public
issues for suspected vulnerabilities before a fix or a coordinated
disclosure.

## Dependency advisories

The protocol stack is pinned to QEDIT's git revisions (ADR-000/001); some
transitive versions are dictated by those pins and cannot be bumped on our
side. No advisory is accepted today. Resolved ones stay listed with their
reasoning, so it can be checked rather than trusted:

- **`halo2_gadgets 0.4.0` — circuit soundness (critical). Resolved in
  0.6.0.** A missing copy constraint in variable-base scalar
  multiplication left the base under-constrained, which broke soundness
  of the Orchard Action circuit: a malicious prover could produce a
  valid-looking proof for a statement that is not true. Fixed in `0.5.0`.

  The fix changes the circuit, so it changes the verifying key: it was a
  consensus change, not a library update. A client shipping the fixed
  circuit produces proofs that a node on the old circuit refuses, so the
  bump waited on the network, not on this repository (reported upstream
  as QED-it/zebra#164). Until then the advisory was accepted on stated
  grounds: soundness protects whoever _relies_ on a proof, and that is
  consensus, not this software; Cachet produces proofs and never
  validates anyone else's, and the only network it ran against was a test
  network.

  Since 0.6.0 the stack is on QEDIT's `zsa1` line with the fixed circuit
  (`halo2_gadgets 0.5`, orchard 0.14), the three wasm engines are rebuilt
  on it, and CI's regtest node is built from `zsa1` too. The flip side:
  proofs from this build verify only on nodes of that line (Zebra 5.2.0
  or later, `rpc.test-zsa.org` by default). The older node at
  `dev.zebra.zsa-test.net` still verifies with the old circuit and
  rejects them ([docs/DEPLOY.md](docs/DEPLOY.md)).

- **`postcss` (4 advisories, source-map path traversal and stringify
  XSS).** `next` pins `postcss 8.4.31` exactly as a direct dependency, so
  the fixed 8.5.x line was unreachable through normal resolution. Resolved
  with a pnpm `overrides` entry rather than left accepted: the bump is
  semver-compatible, and the console build plus the end-to-end suite were
  re-run against it. Remove the override once `next` ships a bumped pin.

Advisories reached through the QEDIT pins are reviewed at every QEDIT rev
bump. If you believe one is exploitable in this codebase despite the scope
above, please report it.

## Out of scope

- Vulnerabilities in the QEDIT protocol forks, Zebra, or the ZSA testnet
  infrastructure — report those upstream (we will gladly relay).
- Denial of service against your own local regtest.
