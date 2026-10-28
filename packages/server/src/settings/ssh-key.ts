import { createHash, createPrivateKey, generateKeyPairSync, randomBytes } from "node:crypto";

/**
 * OpenSSH private keys for GitHub. The private half goes into the credential store and is never
 * sent back to a client; only the public key line and its SHA256 fingerprint are shown.
 */

const BEGIN = "-----BEGIN OPENSSH PRIVATE KEY-----";
const END = "-----END OPENSSH PRIVATE KEY-----";
const MAGIC = Buffer.from("openssh-key-v1\0", "binary");
const MAX_PRIVATE_KEY_LENGTH = 16_384;

export class SshKeyError extends Error {}

export type SshPublicKey = {
  /** e.g. `ssh-ed25519` */
  readonly type: string;
  /** `<type> <base64>[ <comment>]`, ready to paste into GitHub → SSH keys. */
  readonly publicKey: string;
  /** `SHA256:…`, as `ssh-keygen -lf` prints it. */
  readonly fingerprint: string;
  readonly comment?: string;
};

class Reader {
  #buffer: Buffer;
  #offset = 0;
  constructor(buffer: Buffer) {
    this.#buffer = buffer;
  }
  uint32(): number {
    if (this.#offset + 4 > this.#buffer.length) throw new SshKeyError("truncated private key");
    const value = this.#buffer.readUInt32BE(this.#offset);
    this.#offset += 4;
    return value;
  }
  bytes(): Buffer {
    const length = this.uint32();
    if (this.#offset + length > this.#buffer.length) throw new SshKeyError("truncated private key");
    const value = this.#buffer.subarray(this.#offset, this.#offset + length);
    this.#offset += length;
    return value;
  }
  text(): string {
    return this.bytes().toString("utf8");
  }
}

function sshString(value: Buffer | string): Buffer {
  const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : value;
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  return Buffer.concat([length, bytes]);
}

function fingerprint(blob: Buffer): string {
  return `SHA256:${createHash("sha256").update(blob).digest("base64").replace(/=+$/, "")}`;
}

/** Normalize pasted text and read the public half. Rejects passphrase-protected and non-OpenSSH keys. */
export function parseOpenSshPrivateKey(raw: string): { pem: string; info: SshPublicKey } {
  const text = raw.replace(/\r\n?/g, "\n").trim();
  if (text.length > MAX_PRIVATE_KEY_LENGTH) throw new SshKeyError("private key is too long");
  if (/^ssh-|^ecdsa-|^sk-/.test(text)) {
    throw new SshKeyError("that's a public key; paste the private key (the file without .pub)");
  }
  if (!text.startsWith(BEGIN) || !text.endsWith(END)) {
    throw new SshKeyError(
      "expected an OpenSSH private key (-----BEGIN OPENSSH PRIVATE KEY-----); create one with ssh-keygen -t ed25519",
    );
  }
  const body = text.slice(BEGIN.length, -END.length).replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]+=*$/.test(body)) throw new SshKeyError("private key is not valid base64");
  const decoded = Buffer.from(body, "base64");
  if (!decoded.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new SshKeyError("not an OpenSSH private key");
  }
  const reader = new Reader(decoded.subarray(MAGIC.length));
  const cipher = reader.text();
  reader.text(); // kdf name
  reader.bytes(); // kdf options
  if (cipher !== "none") {
    throw new SshKeyError(
      "passphrase-protected keys aren't supported; use a dedicated key without a passphrase",
    );
  }
  if (reader.uint32() !== 1) throw new SshKeyError("expected exactly one key in the file");
  const blob = reader.bytes();
  const type = new Reader(blob).text();
  const privateSection = new Reader(reader.bytes());
  const check1 = privateSection.uint32();
  const check2 = privateSection.uint32();
  if (check1 !== check2) throw new SshKeyError("private key is corrupt");
  if (privateSection.text() !== type) throw new SshKeyError("private key is corrupt");
  // The comment follows type-specific fields; ed25519 is the common case.
  let comment: string | undefined;
  if (type === "ssh-ed25519") {
    privateSection.bytes();
    privateSection.bytes();
    comment = privateSection.text() || undefined;
  }
  const line = `${type} ${blob.toString("base64")}`;
  return {
    pem: `${text}\n`,
    info: {
      type,
      publicKey: comment ? `${line} ${comment}` : line,
      fingerprint: fingerprint(blob),
      ...(comment ? { comment } : {}),
    },
  };
}

function wrap(base64: string): string {
  return base64.match(/.{1,70}/g)?.join("\n") ?? base64;
}

/** A fresh, unencrypted ed25519 key in OpenSSH format, generated in-process. */
export function generateEd25519Key(comment: string): { pem: string; info: SshPublicKey } {
  const { privateKey } = generateKeyPairSync("ed25519");
  const jwk = createPrivateKey(privateKey.export({ format: "pem", type: "pkcs8" })).export({
    format: "jwk",
  });
  if (!jwk.d || !jwk.x) throw new SshKeyError("could not generate a key");
  const seed = Buffer.from(jwk.d, "base64url");
  const pub = Buffer.from(jwk.x, "base64url");
  const blob = Buffer.concat([sshString("ssh-ed25519"), sshString(pub)]);
  const check = randomBytes(4);
  let section = Buffer.concat([
    check,
    check,
    sshString("ssh-ed25519"),
    sshString(pub),
    sshString(Buffer.concat([seed, pub])),
    sshString(comment),
  ]);
  const pad = (8 - (section.length % 8)) % 8;
  section = Buffer.concat([section, Buffer.from(Array.from({ length: pad }, (_, i) => i + 1))]);
  const nkeys = Buffer.alloc(4);
  nkeys.writeUInt32BE(1);
  const file = Buffer.concat([
    MAGIC,
    sshString("none"),
    sshString("none"),
    sshString(""),
    nkeys,
    sshString(blob),
    sshString(section),
  ]);
  return parseOpenSshPrivateKey(`${BEGIN}\n${wrap(file.toString("base64"))}\n${END}\n`);
}
