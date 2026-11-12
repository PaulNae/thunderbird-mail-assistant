// Choosing the sender identity for a reply: the identity the original mail was addressed to.

export interface IdentityLike {
  id?: string;
  email?: string;
}

/** Extracts the bare, lower-cased address from forms like `Name <a@b>`, `<a@b>` or `a@b`. */
export function extractAddress(value: string): string {
  const angle = /<([^<>]*)>\s*$/.exec(value);
  return (angle ? angle[1]! : value).trim().toLowerCase();
}

/**
 * Picks the identity whose address appears in the recipients (given in the order To, Cc, Bcc;
 * the first recipient that matches wins). Falls back to the default identity, then to undefined
 * (the caller then lets Thunderbird choose).
 */
export function pickIdentity(
  recipients: readonly string[],
  identities: readonly IdentityLike[],
  defaultId?: string,
): string | undefined {
  const byAddress = new Map<string, string>();
  for (const identity of identities) {
    if (!identity.id || !identity.email) continue;
    const address = identity.email.trim().toLowerCase();
    if (address && !byAddress.has(address)) byAddress.set(address, identity.id);
  }
  for (const recipient of recipients) {
    const hit = byAddress.get(extractAddress(recipient));
    if (hit) return hit;
  }
  return defaultId ?? undefined;
}

export interface ReplyContext {
  accountId?: string;
  identityId?: string;
}

/**
 * Looks up the account of a message and the identity a reply should use. Never throws and
 * returns an empty object when the account cannot be determined (e.g. a message opened from a
 * file). Errors are swallowed without logging, as they could carry mail data.
 */
/** Account of a message, or undefined (e.g. opened from a file). Never throws. */
export async function findAccountId(messageId: number): Promise<string | undefined> {
  try {
    return (await messenger.messages.get(messageId)).folder?.accountId;
  } catch {
    return undefined;
  }
}

export async function findReplyContext(messageId: number): Promise<ReplyContext> {
  try {
    const header = await messenger.messages.get(messageId);
    const accountId = header.folder?.accountId;
    if (!accountId) return {};
    try {
      const account = await messenger.accounts.get(accountId);
      const identities = account?.identities ?? [];
      // The default identity is listed first.
      const recipients = [...(header.recipients ?? []), ...(header.ccList ?? []), ...(header.bccList ?? [])];
      return { accountId, identityId: pickIdentity(recipients, identities, identities[0]?.id) };
    } catch {
      return { accountId };
    }
  } catch {
    return {};
  }
}
