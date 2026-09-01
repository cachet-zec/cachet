# Regtest bootstrap

The `qedit/zebra-regtest-txv6` image is self-contained: it starts a
single-node OrchardZSA regtest with v6 transactions enabled and mines on
demand when transactions are submitted through the tx-tool flow.

Reset procedure (required between tx-tool scenario runs, which assume a
fresh chain):

```bash
docker compose -f infra/docker-compose.yml restart zebra-regtest
```

The `cachet-chain` integration suite drives this node directly and needs no
extra fixtures here: `cargo test -p cachet-chain --test regtest -- --ignored
--test-threads=1` (see docs/SETUP.md).
