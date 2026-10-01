export type EmailTransportKind = "smtp" | "listmonk" | "console";

/** The subset of the environment that decides how mail leaves this server.
 *  Declared as its own shape so the selection can be unit-tested without a
 *  process env, a socket or a database. */
export interface EmailTransportEnv {
  EMAIL_TRANSPORT: string;
  SMTP_HOST: string;
  SMTP_PORT?: string;
  SMTP_SECURE?: string;
  SMTP_USER?: string;
  SMTP_PASSWORD?: string;
  EMAIL_FROM: string;
  LISTMONK_URL: string;
  LISTMONK_API_USER: string;
  LISTMONK_API_TOKEN: string;
  LISTMONK_TX_TEMPLATE_ID: string;
  LISTMONK_FROM_EMAIL: string;
  LISTMONK_FROM: string;
}

/** No provider discovery or fallback. Errors name settings, never secrets. */
export function selectEmailTransport(
  source: EmailTransportEnv,
): EmailTransportKind {
  const selected = source.EMAIL_TRANSPORT.trim();
  if (!selected) {
    const configured = [
      source.SMTP_HOST,
      source.SMTP_USER,
      source.SMTP_PASSWORD,
      source.EMAIL_FROM,
      source.LISTMONK_URL,
      source.LISTMONK_API_USER,
      source.LISTMONK_API_TOKEN,
      source.LISTMONK_TX_TEMPLATE_ID,
      source.LISTMONK_FROM,
      source.LISTMONK_FROM_EMAIL,
    ].some((value) => value?.trim());
    if (configured)
      throw new Error(
        "Mail settings exist: set EMAIL_TRANSPORT explicitly to smtp, listmonk or none before starting the server",
      );
    return "console";
  }
  if (selected === "none") return "console";
  const requireSettings = (keys: (keyof EmailTransportEnv)[]) => {
    const missing = keys.filter((key) => !source[key]?.trim());
    if (missing.length)
      throw new Error(
        `EMAIL_TRANSPORT=${selected} requires ${missing.join(", ")}`,
      );
  };
  if (selected === "smtp") {
    requireSettings(["SMTP_HOST", "EMAIL_FROM"]);
    if (Boolean(source.SMTP_USER?.trim()) !== Boolean(source.SMTP_PASSWORD)) {
      throw new Error(
        "EMAIL_TRANSPORT=smtp requires both SMTP_USER and SMTP_PASSWORD, or neither for an unauthenticated relay",
      );
    }
    if (
      source.SMTP_PORT &&
      (!/^\d+$/.test(source.SMTP_PORT) ||
        Number(source.SMTP_PORT) < 1 ||
        Number(source.SMTP_PORT) > 65535)
    ) {
      throw new Error("SMTP_PORT must be an integer from 1 to 65535");
    }
    if (
      source.SMTP_SECURE &&
      !["true", "false"].includes(source.SMTP_SECURE.trim().toLowerCase())
    ) {
      throw new Error("SMTP_SECURE must be true or false when set");
    }
    return "smtp";
  }
  if (selected === "listmonk") {
    requireSettings([
      "LISTMONK_URL",
      "LISTMONK_API_USER",
      "LISTMONK_API_TOKEN",
      "LISTMONK_TX_TEMPLATE_ID",
    ]);
    if (!(source.LISTMONK_FROM || source.LISTMONK_FROM_EMAIL).trim()) {
      throw new Error(
        "EMAIL_TRANSPORT=listmonk requires LISTMONK_FROM or LISTMONK_FROM_EMAIL",
      );
    }
    try {
      const url = new URL(source.LISTMONK_URL);
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        throw new Error();
    } catch {
      throw new Error(
        "LISTMONK_URL must be an HTTP(S) URL without embedded credentials, query or fragment",
      );
    }
    if (
      !/^[1-9]\d*$/.test(source.LISTMONK_TX_TEMPLATE_ID) ||
      !Number.isSafeInteger(Number(source.LISTMONK_TX_TEMPLATE_ID))
    ) {
      throw new Error("LISTMONK_TX_TEMPLATE_ID must be a positive integer");
    }
    return "listmonk";
  }
  throw new Error("EMAIL_TRANSPORT must be smtp, listmonk or none");
}

/** Sender identities belong to their provider; never borrow another's. */
export function resolveFromAddress(source: EmailTransportEnv): string {
  if (source.EMAIL_TRANSPORT.trim() === "smtp") return source.EMAIL_FROM.trim();
  if (source.EMAIL_TRANSPORT.trim() === "listmonk")
    return (source.LISTMONK_FROM || source.LISTMONK_FROM_EMAIL).trim();
  return "";
}
