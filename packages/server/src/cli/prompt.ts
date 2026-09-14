/**
 * Reading a password for the admin CLI without echoing it.
 *
 * Two sources, chosen by whether stdin is a terminal:
 *
 *   - A TTY (`docker compose exec server ...`, which allocates one by default):
 *     raw mode, nothing written back per keystroke, asked twice so a typo does
 *     not become the only password an account has.
 *   - Anything else (`docker compose exec -T ... < file`, a pipe in a script):
 *     the first line of stdin, asked once. There is nobody to confirm with.
 *
 * `--password` on the command line skips both and lands in shell history; the
 * prompt is the default for that reason.
 */
import { CliError } from "./errors.js";

export type SecretInput = NodeJS.ReadableStream & {
  isTTY?: boolean;
  setRawMode?: (mode: boolean) => unknown;
};

export type SecretOutput = { write: (chunk: string) => unknown };

const CTRL_C = "\u0003";
const CTRL_D = "\u0004";
const BACKSPACE = "\u007f";
const CTRL_H = "\b";

/**
 * Apply one chunk of raw keyboard input to the buffer. Split out so the key
 * handling — Enter ends, Backspace edits, Ctrl+C aborts, other control
 * characters are dropped — is testable without a terminal.
 */
export function applyKeys(
  buffer: string,
  chunk: string,
): { buffer: string; done: boolean; aborted: boolean } {
  let next = buffer;
  for (const char of chunk) {
    if (char === CTRL_C) return { buffer: next, done: false, aborted: true };
    if (char === "\r" || char === "\n" || char === CTRL_D) {
      return { buffer: next, done: true, aborted: false };
    }
    if (char === BACKSPACE || char === CTRL_H) {
      next = [...next].slice(0, -1).join("");
      continue;
    }
    if (char < " ") continue;
    next += char;
  }
  return { buffer: next, done: false, aborted: false };
}

function readHidden(
  question: string,
  input: SecretInput,
  output: SecretOutput,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    output.write(question);
    input.setRawMode?.(true);
    input.setEncoding?.("utf8");

    const finish = (): void => {
      input.removeListener("data", onData);
      input.setRawMode?.(false);
      input.pause();
      output.write("\n");
    };

    const onData = (data: string | Buffer): void => {
      const result = applyKeys(buffer, typeof data === "string" ? data : data.toString("utf8"));
      buffer = result.buffer;
      if (result.aborted) {
        finish();
        reject(new CliError("aborted"));
      } else if (result.done) {
        finish();
        resolve(buffer);
      }
    };

    input.on("data", onData);
    input.resume();
  });
}

/** The first line of a non-interactive stdin, without its line ending. */
export async function readFirstLine(input: NodeJS.ReadableStream): Promise<string> {
  let text = "";
  for await (const chunk of input) {
    text += typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString("utf8");
    const newline = text.indexOf("\n");
    if (newline !== -1) return text.slice(0, newline).replace(/\r$/, "");
  }
  return text.replace(/\r$/, "");
}

/**
 * Ask for a new password. Rejects with a `CliError` on a mismatch, an empty
 * answer or Ctrl+C. Length rules are NOT checked here: better-auth enforces
 * its own minimum and maximum when the password is set, and a second copy of
 * those numbers could only disagree with it.
 */
export async function promptNewPassword(
  io: { input: SecretInput; output: SecretOutput },
  label = "Password",
): Promise<string> {
  if (!io.input.isTTY) {
    const line = await readFirstLine(io.input);
    if (!line) {
      throw new CliError(
        "no password given: pass --password, run in a terminal, or pipe the password on stdin",
      );
    }
    return line;
  }

  const first = await readHidden(`${label}: `, io.input, io.output);
  if (!first) throw new CliError("the password cannot be empty");
  const second = await readHidden(`Repeat ${label.toLowerCase()}: `, io.input, io.output);
  if (first !== second) throw new CliError("the two passwords do not match");
  return first;
}
