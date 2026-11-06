// Every cell of the ARCH role table, plus token min(permission, role) and inactive accounts.
import { describe, expect, it } from 'vitest';
import { allowedActions, decide, effectiveRole, PROJECT_ACTIONS, type ProjectAction, type ProjectRole } from '../src/permissions.js';
import { SENSITIVE_KEY, scriptPathError, tokenCreateSchema, varsSchema } from '../src/validation.js';

/** Expected table, written out independently of ROLE_TABLE (ARCH 권한 + project.update = editor+). */
const EXPECTED: Record<ProjectAction, Record<ProjectRole, boolean>> = {
  'project.view': { owner: true, editor: true, runner: true, viewer: true },
  'run.execute': { owner: true, editor: true, runner: true, viewer: false },
  'schedule.manage': { owner: true, editor: true, runner: false, viewer: false },
  'script.edit': { owner: true, editor: true, runner: false, viewer: false },
  'suite.edit': { owner: true, editor: true, runner: false, viewer: false },
  'environment.edit': { owner: true, editor: true, runner: false, viewer: false },
  'credential.write': { owner: true, editor: true, runner: false, viewer: false },
  'run.upload': { owner: true, editor: true, runner: true, viewer: false },
  'project.update': { owner: true, editor: true, runner: false, viewer: false },
  'member.manage': { owner: true, editor: false, runner: false, viewer: false },
  'project.visibility': { owner: true, editor: false, runner: false, viewer: false },
  'project.transfer': { owner: true, editor: false, runner: false, viewer: false },
  'project.merge': { owner: true, editor: false, runner: false, viewer: false },
  'project.delete': { owner: true, editor: false, runner: false, viewer: false },
  'project.restore': { owner: true, editor: false, runner: false, viewer: false },
  'access.request': { owner: false, editor: true, runner: true, viewer: true },
  'member.leave': { owner: true, editor: true, runner: true, viewer: true },
};
const ROLES: ProjectRole[] = ['owner', 'editor', 'runner', 'viewer'];

describe('role table', () => {
  it('covers exactly the expected actions', () => {
    expect([...PROJECT_ACTIONS].sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  for (const action of Object.keys(EXPECTED) as ProjectAction[]) {
    for (const role of ROLES) {
      it(`${role} ${EXPECTED[action][role] ? 'may' : 'may not'} ${action}`, () => {
        expect(decide({ role, action })).toBe(EXPECTED[action][role]);
        // read_write token = role
        expect(decide({ role, action, tokenPermission: 'read_write' })).toBe(EXPECTED[action][role]);
        // read token = min(read, role): only reads
        expect(decide({ role, action, tokenPermission: 'read' })).toBe(EXPECTED[action][role] && action === 'project.view');
        // inactive accounts are excluded entirely
        expect(decide({ role, action, active: false })).toBe(false);
      });
    }
  }

  it('effective role and allowed actions', () => {
    expect(effectiveRole('owner', 'read')).toBe('viewer');
    expect(effectiveRole('editor', 'read_write')).toBe('editor');
    expect(allowedActions({ role: 'viewer' })).toEqual(['project.view', 'access.request', 'member.leave']);
    expect(allowedActions({ role: 'owner', tokenPermission: 'read' })).toEqual(['project.view']);
    expect(allowedActions({ role: 'editor' })).not.toContain('member.manage');
  });
});

describe('validation rules', () => {
  it('script paths', () => {
    for (const ok of ['login.yaml', 'checkout/pay.yml', 'a/b/c.YAML', '한글/시나리오.yaml']) expect(scriptPathError(ok)).toBeNull();
    for (const bad of ['', '/abs.yaml', '../up.yaml', 'a/../b.yaml', 'a//b.yaml', './x.yaml', '.hidden.yaml', 'a\\b.yaml', 'C:/x.yaml', 'x.json', 'x', 'a\u0000.yaml', `${'a'.repeat(500)}.yaml`]) {
      expect(scriptPathError(bad), bad).not.toBeNull();
    }
  });

  it('credential-like variable keys are rejected (euta-app ADR-016 rule)', () => {
    for (const k of ['API_TOKEN', 'password', 'DB_PASSWD', 'apiKey', 'API_KEY', 'AWS_ACCESS_KEY', 'PRIVATE_KEY', 'SESSION_COOKIE', 'AUTH_HEADER', 'my_secret']) expect(SENSITIVE_KEY.test(k), k).toBe(true);
    expect(varsSchema.safeParse({ API_TOKEN: 'x' }).success).toBe(false);
    expect(varsSchema.safeParse({ 'bad-key': 'x' }).success).toBe(false);
    expect(varsSchema.safeParse({ REGION: 'kr', user_name: 'a' }).success).toBe(true);
  });

  it('token expiry choices', () => {
    expect(tokenCreateSchema.parse({ name: 'a', permission: 'read' }).expiresInDays).toBe(90);
    expect(tokenCreateSchema.safeParse({ name: 'a', permission: 'read', expiresInDays: 45 }).success).toBe(false);
  });
});
