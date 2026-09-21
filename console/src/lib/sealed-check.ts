import { apiBaseUrl } from "@/lib/api";

/**
 * Before a seed signs anything: is the description the registry handed
 * back really a seal over what was typed?
 *
 * The registry composes the on-chain description, and an issuance signed
 * over it is permanent. A registry that answered with another name, another
 * bundle, or the description of one of the minter's earlier assets would
 * get a signature for something the minter never wrote. So the bundle is
 * fetched back, hashed here, and compared field by field with the form.
 * Throws with a message fit for the page; resolves when everything matches.
 */
export async function assertSealsWhatWasTyped(
  chainDescription: string,
  typed: { name: string; description: string | undefined; imageDataUri: string | undefined },
): Promise<void> {
  const refuse = (what: string) =>
    new Error(
      `The registry answered with ${what}. Nothing was signed; try again or mint elsewhere.`,
    );

  let envelope: { v?: unknown; name?: unknown; sha256?: unknown };
  try {
    envelope = JSON.parse(chainDescription) as typeof envelope;
  } catch {
    throw refuse("a description that is not a Cachet envelope");
  }
  const sha256 = envelope.sha256;
  if (envelope.v !== 1 || typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256)) {
    throw refuse("a description that is not a Cachet envelope");
  }
  if (envelope.name !== typed.name) throw refuse("a name that is not the one you typed");

  const response = await fetch(`${apiBaseUrl}/api/v1/metadata/${sha256}`, { cache: "no-store" });
  if (!response.ok) throw refuse("a seal it cannot serve back");
  const bytes = await response.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const computed = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  if (computed !== sha256) throw refuse("a bundle that does not hash to its own seal");

  const bundle = JSON.parse(new TextDecoder().decode(bytes)) as {
    name?: unknown;
    description?: unknown;
    image_data_uri?: unknown;
    external_url?: unknown;
  };
  const same =
    bundle.name === typed.name &&
    (bundle.description ?? undefined) === typed.description &&
    (bundle.image_data_uri ?? undefined) === typed.imageDataUri &&
    bundle.external_url === undefined;
  if (!same) throw refuse("sealed content that is not what you typed");
}
