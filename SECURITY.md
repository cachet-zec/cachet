# Security Policy

## Scope and honest status

Cachet targets the Zcash ZSA **testnet and regtest** environments. It is not
audited, it depends on alpha protocol libraries, and it must not be used with
mainnet keys or value-bearing assets. Security reports are welcome all the
same — building the reporting habit before mainnet is the point.

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
Planned hardening: signed releases and subresource integrity for the
engine assets. The strongest mitigation is already available: run your
own instance, or submit signed transactions to the public node directly
— this instance is a convenience, not a chokepoint.

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
  limiter and the per-client write-path throttles (60 uploads a minute,
  10 relays a minute, 8 relays in flight, all answering 429) key on the
  real peer address by
  default; set `CACHET_TRUST_PROXY=1` **only** when a reverse proxy you
  control sits in front and rewrites `X-Forwarded-For` / `X-Real-IP` (the
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
  it can never alter or spend anything. Generate it randomly (`openssl rand -hex 32`) and
  treat it like a password. Tokens shorter than 32 characters are
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

## Known accepted advisories

The protocol stack is pinned to QEDIT's git revisions (ADR-000/001); some
transitive versions are dictated by those pins and cannot be bumped on our
side. Currently tracked:

- **`halo2_gadgets 0.4.0` — circuit soundness (critical).** A missing
  copy constraint in variable-base scalar multiplication leaves the base
  under-constrained, which breaks soundness of the Orchard Action circuit:
  a malicious prover could produce a valid-looking proof for a statement
  that is not true. Fixed in `0.5.0`.

  The bump was built and tested, and the result is on the
  `chore/bump-qedit-stack` branch: QEDIT's `zsa1` line now carries
  `halo2_gadgets 0.5`, the whole stack resolves, compiles with no API
  break, and every workspace test passes. What fails is the regtest
  gate ADR-000 requires - the node rejects the new proofs with "could
  not validate orchard proof".

  That failure is the real finding. The soundness fix changes the
  circuit, so it changes the verifying key: it is a consensus change,
  not a library update. A client shipping the fixed circuit produces
  proofs the deployed network refuses - and the public testnet node
  still verifies with the old key (it accepts old-circuit proofs
  today). Deploying the fix would break browser minting against the
  network this project exists to run on.

  So the constraint is the deployed testnet, not this repository. The
  branch merges the day QEDIT redeploys on the fixed circuit; until
  then every network participant, including every other ZSA tool,
  necessarily proves against the old one.

  Why it is nevertheless accepted here, stated so you can disagree with
  the reasoning rather than trust it: soundness protects whoever _relies_
  on a proof, and that is consensus, not this software. Cachet produces
  proofs and never validates anyone else's. The only network it runs
  against is a test network whose assets carry no value, so forging one
  buys nothing. The defect is in the shared Zcash proving stack at these
  versions, not in anything Cachet does with it.

  Dependabot reports this against several manifests. One of them,
  `crates/verify-engine`, does not build the circuit at all — it takes
  `orchard` without the `circuit` feature, purely for asset-id derivation.
  The alert there is a manifest-level match, not an exposure.

  This is a release blocker for any mainnet story, and it is listed as
  such in the roadmap: Cachet retargets to mainnet by configuration only
  once the ZSA branches sit on a fixed stack.

- **`postcss` (4 advisories, source-map path traversal and stringify
  XSS).** `next` pins `postcss 8.4.31` exactly as a direct dependency, so
  the fixed 8.5.x line was unreachable through normal resolution. Resolved
  with a pnpm `overrides` entry rather than left accepted: the bump is
  semver-compatible, and the console build plus the end-to-end suite were
  re-run against it. Remove the override once `next` ships a bumped pin.

The first entry is reviewed at every QEDIT rev bump. If you believe it is
exploitable in this codebase despite the scope above, please report it.

## Out of scope

- Vulnerabilities in the QED-it protocol forks, Zebra, or the ZSA testnet
  infrastructure — report those upstream (we will gladly relay).
- Denial of service against your own local regtest.
