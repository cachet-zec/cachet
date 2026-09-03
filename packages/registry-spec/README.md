# Cachet registry — metadata format (v1)

How Cachet binds rich off-chain metadata to a ZSA asset. The chain stores
only a 512-byte description (as a hash inside the asset id derivation);
everything else lives in a **content-addressed bundle** whose hash is
sealed into that description — so integrity is verifiable by anyone,
forever, and no registry has to be trusted for more than availability.

## On-chain description envelope

Committed at issuance, immutable, participates in the asset id:

```json
{ "v": 1, "name": "Zcon Ticket 2027", "sha256": "<hex sha-256 of the bundle bytes>" }
```

- `name`: display name, ≤ 120 bytes.
- `sha256`: hash of the metadata bundle's exact stored bytes.
- Descriptions that don't parse as this envelope are treated as free text.

## Metadata bundle

A JSON document stored content-addressed (key = SHA-256 of its bytes):

```json
{
  "v": 1,
  "name": "Zcon Ticket 2027",
  "description": "Admits one, shielded.",
  "image_data_uri": "data:image/png;base64,…",
  "external_url": "https://example.com"
}
```

- `name`: ≤ 120 bytes. `description`: optional, ≤ 4096 bytes.
- `image_data_uri`: optional; png/jpeg/webp/gif only (SVG excluded — it can
  script), ≤ ~400 KB. Served by the registry at
  `GET /api/v1/metadata/{sha256}/image` so consoles never fetch
  third-party origins (PRIVACY.md P5).
- Bundle bytes are byte-exact: `GET /api/v1/metadata/{sha256}` returns what
  was stored; re-hash to verify.
- A producer MAY resize or re-encode an image before sealing (the Cachet
  console does, above ~280 KB). It must do so **before** hashing: the
  commitment covers the bytes that will be served, so what a verifier
  re-hashes is what the issuer sealed.

## Retention: uploading is not publishing

A registry keeps a bundle only while a **resolved asset description**
references it. Cachet sweeps unreferenced bundles after a 30-minute grace
window, so an upload that never reaches the chain is not storage — it is
a staging slot.

The sequence that survives is: upload the bundle → mint the asset with
the returned chain description → resolve that description against the
asset. Miss the last step and the bundle is dropped within the hour;
re-uploading the identical bytes always restores the identical hash, so
recovery is possible for whoever still holds them.

Implementations MAY choose a different window, and SHOULD state it. What
they must not do is retain unreferenced uploads indefinitely: that is how
a content-addressed registry becomes free hosting.

## Verification rule

For any asset: parse its chain description → if a v1 envelope, fetch the
bundle by `sha256` from any registry → re-hash the bytes → compare. Match
⇒ the metadata (name, image, links) is exactly what the issuer sealed at
issuance. No match or no bundle ⇒ display the asset as unnamed; never
trust unverified metadata.

## Why no creator signature on the bundle

Some metadata conventions sign manifests with the issuance key because
their metadata can be revised after issuance. Cachet's envelope needs no
separate signature: the bundle hash
is inside the chain description, the chain description hash is inside the
asset id, and the asset id derivation is authenticated by the issuance
bundle's own ZIP 227 signature. The chain's signature already covers
every byte of the metadata, transitively. A second signature would only
add value for _mutable_ metadata — which this format deliberately does
not support.

## Listing: ordering is not moderation

`GET /api/v1/assets` returns every asset the registry knows, newest first.
Two optional parameters narrow what a client receives, and neither is a
moderation decision — the unfiltered listing is always the default and
always available:

```
GET /api/v1/assets?limit=5&resolved=true
```

`limit` keeps the newest N. `resolved=true` keeps only assets whose
description is known, so their name is attested rather than an id — what a
client wants when it intends to display names. On a chain where most
assets are script-minted with no description at all, the difference
between the two views is large; a client that means to show everything
should simply omit the parameter.

Clients doing their own search, or mirroring, want neither: ask for the
whole listing.

## Permissionless description resolution

The chain stores only the description **hash**; the plaintext is known to
whoever the issuer gave it to. Anyone can teach a Cachet registry the
description of any on-chain asset:

```
POST /api/v1/assets/{asset_id}/description   { "description": "…" }
```

The registry recomputes the ZIP 227 personalized BLAKE2b-256
(`ZSA-AssetDescCRH`) and accepts the submission **only if it matches the
on-chain commitment** — so resolution needs no account, no signature and
no trust: a matching preimage is definitionally correct, and the registry
cannot be lied to. This endpoint stays open on read-only deployments.

## Operator moderation: availability, not truth

Bundles and description texts are distributed by a registry instance, so
its operator carries responsibility for what it serves. The moderation
model follows one rule: **a registry can withhold, it can never lie.**

```
cachet-server moderate list
cachet-server moderate hide-bundle <sha256> [reason]
cachet-server moderate unhide-bundle <sha256>
cachet-server moderate hide-description <asset_id> [reason]
cachet-server moderate unhide-description <asset_id>
cachet-server moderate hide-issuer <issuance_key> [reason]
cachet-server moderate unhide-issuer <issuance_key>
```

Hiding a bundle makes its endpoints answer `410 Gone` with problem type
`hidden-by-operator`; hiding a description makes the asset render as
unresolved. Every entry records a reason and a timestamp, and is
reversible. Nothing on chain changes: the asset, its supply and its
commitment are untouched, and any other registry can keep serving the
identical, self-verifying content. Moderation is a per-operator judgment,
exercised at the server (database access) or through an optional
token-gated HTTP admin surface, which answers 404 unless the operator
sets `CACHET_ADMIN_TOKEN`.

## Names carry their provenance

The API labels every display name with its provenance (`name_source`:
`envelope` or `free_text`) so clients can render trust states honestly.
A description that is not a Cachet envelope is an issuer-chosen label:
displayed, but never as a verified name, per the anti-phishing display
rule ZIP 227 asks wallets to adopt.

## Signed registry snapshots (v1)

`GET /api/v1/snapshot` exports everything the registry knows, sealed
under the operator's Ed25519 key so a mirror can serve the file offline
and any client can verify it came from the operator without trusting the
mirror:

```json
{
  "payload": "<base64 of the canonical payload JSON>",
  "sha256": "<hex sha-256 of the decoded payload bytes>",
  "signature": "<hex ed25519 signature>",
  "public_key": "<hex ed25519 public key>",
  "tip_height": 123,
  "asset_count": 42
}
```

The payload (`version`, `network`, `tip_height`, `assets[]` sorted by
asset id, each with `asset_id`, `issuer`, `total_supply`, `finalized`,
`description`) is deterministic: no timestamps, stable ordering — the
same chain state always produces byte-identical payloads, so snapshots
from independent mirrors can be compared byte for byte.

Verification, from the wire fields alone:

1. base64-decode `payload`; check `sha256(payload bytes)` equals `sha256`;
2. verify `signature` over `"cachet-snapshot-v1" || sha256-bytes` with
   `public_key` (Ed25519).

The operator's public key is published out of band (site, forum post);
`cachet-server --generate-snapshot-key` creates a keypair. Moderation
carries through honestly: withheld descriptions are absent from the
snapshot exactly as they are from the live API — a snapshot can
withhold, it can never lie, and the chain facts stay complete.

## Mirroring: verify a registry instead of believing it

Everything above exists so that a third party can hold a registry to
account without cooperating with it. `scripts/mirror.py` does exactly
that, in one command and with no dependencies:

```bash
python scripts/mirror.py                              # mirrors cachetzec.com
python scripts/mirror.py --api https://your.instance --out ./mirror
```

It downloads the signed snapshot, re-derives its digest locally, verifies
the Ed25519 signature when the `cryptography` package is available, then
fetches every bundle the snapshot's envelopes reference and re-hashes
each one against the commitment carried in the asset id. Bytes that do
not match are refused and the run exits non-zero; a `410` is recorded as
operator moderation, which is a different fact from a bundle being
missing. Re-running is idempotent and resumable — already-held bundles
are re-hashed, not re-downloaded.

The result is a directory that any instance can serve:

```
mirror/snapshot.json          the signed envelope, as served
mirror/payload.json           the decoded, deterministic payload
mirror/bundles/<sha256>.json  verified bundle bytes, named by their hash
```

Two consequences worth stating plainly. A mirror needs no permission and
no trust: the operator cannot hand it altered content, because altered
content fails its hash. And a mirror must be taken _while the source is
up_ — the chain commits to bundle hashes, never to bundle bytes, so
content nobody mirrored disappears with the last instance that held it.
