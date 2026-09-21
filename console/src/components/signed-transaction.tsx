"use client";

import { CopyButton } from "@/components/copy-button";
import { ghostButton } from "@/lib/ui";

export interface SignedTx {
  tx_hex: string;
  txid: string;
  asset_id: string;
  /** The on-chain description minted under: needed to name the asset later. */
  description: string;
}

/**
 * A signed transaction the visitor can land without this instance.
 * On the ZSA testnet there is no miner and the mint pays no fee, so a node's
 * mempool refuses it (ZIP 317): it has to be placed in a block, which any
 * instance's relay does.
 */
export function SignedTransaction({ tx, relayFailed }: { tx: SignedTx; relayFailed: boolean }) {
  const file = `cachet-${tx.txid.slice(0, 8)}.hex`;
  const command =
    `curl -s -X POST https://ANY-CACHET-INSTANCE/api/v1/relay -H 'content-type: application/json' ` +
    `-d '{"tx_hex":"'"$(cat ${file})"'"}'`;

  const download = () => {
    const url = URL.createObjectURL(new Blob([tx.tx_hex], { type: "text/plain" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = file;
    link.click();
    // Revoked late: Safari cancels the download if the URL dies at once.
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };

  return (
    <div
      data-testid="signed-transaction"
      className="mt-4 rounded-[3px] border border-accent/40 p-4 text-sm leading-relaxed"
    >
      <p className="text-base font-medium text-neutral-100">
        {relayFailed
          ? "The relay did not take it, but your transaction is signed."
          : "Signed, not relayed."}
      </p>
      <p className="mt-1.5 text-neutral-300">
        These bytes are the whole mint: proven and signed on this page, valid on their own, and tied
        to no instance. Land them soon: a transaction targets a block height and expires if it is
        not mined in time.
      </p>

      <p className="font-data mt-3 break-all text-[13px] text-neutral-400">
        txid <span className="text-neutral-100">{tx.txid}</span>
      </p>
      <p className="font-data mt-1 break-all text-[13px] text-neutral-400">
        asset <span className="text-neutral-100">{tx.asset_id}</span>
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-2.5">
        <button type="button" className={ghostButton} onClick={download}>
          Download signed transaction
        </button>
        <CopyButton value={tx.tx_hex} label="Copy hex" />
        <span className="font-data text-[13px] text-neutral-500">
          {(tx.tx_hex.length / 2).toLocaleString("en-US")} bytes
        </span>
      </div>

      <p className="mt-4 text-neutral-300">
        Any Cachet instance&apos;s relay takes it, no account and no key involved:
      </p>
      <div className="mt-1.5 flex items-start gap-2">
        <pre className="font-data min-w-0 flex-1 overflow-x-auto rounded-[2px] border border-line bg-ground p-3 text-[13px] text-neutral-300">
          {command}
        </pre>
        <CopyButton value={command} />
      </div>
      <p className="mt-2 text-[13px] text-neutral-500">
        Why not a node directly: this testnet has no miner and the transaction pays no fee, so a
        node&apos;s mempool refuses it. It has to be placed in a block (getblocktemplate, then
        submitblock), which is what a relay does and what any tool that assembles a block can do.
      </p>

      <p className="mt-4 text-neutral-300">
        Once it is mined, a registry learns the asset from the chain but not its name. Give it this
        exact description from the asset page (anyone can, it is checked against the chain):
      </p>
      <div className="mt-1.5 flex items-start gap-2">
        <span className="font-data min-w-0 flex-1 break-all text-[13px] text-neutral-400">
          {tx.description}
        </span>
        <CopyButton value={tx.description} />
      </div>
    </div>
  );
}
