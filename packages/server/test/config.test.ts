import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const base = {
  DATABASE_URL: 'postgres://x@localhost/x',
  BETTER_AUTH_SECRET: 's'.repeat(40),
  CREDENTIALS_KEY: Buffer.alloc(32, 1).toString('base64'),
  ALLOWED_EMAIL_DOMAINS: 'example.com',
};

describe('config', () => {
  it('approval mode needs ADMIN_EMAILS; the sign-up domain has no built-in default', () => {
    expect(() => loadConfig({ ...base })).toThrow(/ADMIN_EMAILS/);
    expect(() => loadConfig({ ...base, ADMIN_EMAILS: 'boss@example.com', ALLOWED_EMAIL_DOMAINS: '' })).toThrow(/ALLOWED_EMAIL_DOMAINS/);
    const c = loadConfig({ ...base, ADMIN_EMAILS: 'Boss@ExAmple.com', ALLOWED_EMAIL_DOMAINS: 'Example.com, example.org' });
    expect(c.allowedEmailDomains).toEqual(['example.com', 'example.org']);
    expect(c.mailFrom).toBe('euta cloud <no-reply@localhost>');
    expect(loadConfig({ ...base, ADMIN_EMAILS: 'a@example.com', ALLOWED_EMAIL_DOMAINS: 'example.com', BASE_URL: 'https://euta.example.com/' }).mailFrom).toBe('euta cloud <no-reply@euta.example.com>');
    expect(c.adminEmails).toEqual(['boss@example.com']);
    expect(c.smtpUrl).toBeNull();
    expect(loadConfig({ ...base, SMTP_URL: 'smtp://mail:25' }).smtpUrl).toBe('smtp://mail:25');
  });

  it('rejects weak secrets and wrong key sizes', () => {
    expect(() => loadConfig({ ...base, SMTP_URL: 'smtp://m', BETTER_AUTH_SECRET: 'short' })).toThrow(/32/);
    expect(() => loadConfig({ ...base, SMTP_URL: 'smtp://m', CREDENTIALS_KEY: Buffer.alloc(16).toString('base64') })).toThrow(/32 bytes/);
    expect(() => loadConfig({ SMTP_URL: 'smtp://m', ALLOWED_EMAIL_DOMAINS: 'example.com', BETTER_AUTH_SECRET: base.BETTER_AUTH_SECRET, CREDENTIALS_KEY: base.CREDENTIALS_KEY })).toThrow(/DATABASE_URL/);
  });

  it('Microsoft login: all three settings or none, company tenant only', () => {
    const on = { ...base, ADMIN_EMAILS: 'a@example.com' };
    expect(loadConfig(on).microsoft).toBeNull();
    const ms = { MICROSOFT_TENANT_ID: '11111111-2222-3333-4444-555555555555', MICROSOFT_CLIENT_ID: 'client', MICROSOFT_CLIENT_SECRET: 'secret' };
    expect(loadConfig({ ...on, ...ms }).microsoft).toEqual({ tenantId: ms.MICROSOFT_TENANT_ID, clientId: 'client', clientSecret: 'secret' });
    expect(() => loadConfig({ ...on, ...ms, MICROSOFT_CLIENT_SECRET: '' })).toThrow(/together/);
    expect(() => loadConfig({ ...on, MICROSOFT_CLIENT_ID: 'client' })).toThrow(/together/);
    for (const alias of ['common', 'Organizations', 'consumers']) {
      expect(() => loadConfig({ ...on, ...ms, MICROSOFT_TENANT_ID: alias })).toThrow(/company tenant/);
    }
  });
});
