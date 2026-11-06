// Test credential encryption: AES-256-GCM, random 96-bit IV, AAD binds the value to its slot
// (environment id + name) so a ciphertext cannot be moved to another credential.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const VERSION = 'v1';

export function encryptSecret(key: Buffer, aad: string, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64'), tag.toString('base64'), ct.toString('base64')].join(':');
}

/** Used only when handing credentials to a runner (next stage) and in tests. */
export function decryptSecret(key: Buffer, aad: string, stored: string): string {
  const [version, iv, tag, ct] = stored.split(':');
  if (version !== VERSION || !iv || !tag || ct === undefined) throw new Error('unsupported credential ciphertext');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64')), decipher.final()]).toString('utf8');
}

export const credentialAad = (environmentId: string, name: string) => `${environmentId}/${name}`;
