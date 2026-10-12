import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';

const {
    canInviteRole,
    canManageMember,
    inviteRpcHttpError,
    siteUrl,
    tokenHash,
    validEmail
} = await import('../api/team.js');

test('role matrix limits invitations to allowed roles', () => {
    assert.equal(canInviteRole('owner', 'manager'), true);
    assert.equal(canInviteRole('owner', 'logist'), true);
    assert.equal(canInviteRole('manager', 'manager'), false);
    assert.equal(canInviteRole('manager', 'logist'), true);
    assert.equal(canInviteRole('logist', 'logist'), false);
    assert.equal(canInviteRole('owner', 'admin'), false);
});

test('manager can manage logist only, owner can manage every org role', () => {
    for (const role of ['owner', 'manager', 'logist']) {
        assert.equal(canManageMember('owner', role), true);
    }
    assert.equal(canManageMember('manager', 'logist'), true);
    assert.equal(canManageMember('manager', 'manager'), false);
    assert.equal(canManageMember('manager', 'owner'), false);
    assert.equal(canManageMember('logist', 'logist'), false);
});

test('email validation rejects malformed invite addresses', () => {
    assert.equal(validEmail('logist@example.com'), true);
    assert.equal(validEmail('  owner+fleet@example.com  '), true);
    assert.equal(validEmail('missing-at.example.com'), false);
    assert.equal(validEmail('name@example'), false);
    assert.equal(validEmail(''), false);
});

test('invite tokens are stored as deterministic hashes, not plaintext', () => {
    const token = 'a'.repeat(43);
    const hash = tokenHash(token);
    assert.equal(hash.length, 64);
    assert.notEqual(hash, token);
    assert.equal(hash, tokenHash(token));
    assert.notEqual(hash, tokenHash(token + 'x'));
});

test('SITE_URL is reduced to a safe origin with production fallback', () => {
    const previous = process.env.SITE_URL;
    process.env.SITE_URL = 'https://preview.example.com/path?ignored=1';
    assert.equal(siteUrl(), 'https://preview.example.com');
    process.env.SITE_URL = 'not a url';
    assert.equal(siteUrl(), 'https://trip-control.com');
    if (previous === undefined) delete process.env.SITE_URL;
    else process.env.SITE_URL = previous;
});

test('database invite errors map to stable HTTP status and API codes', () => {
    const cases = [
        ['INVITE_NOT_ACTIVE', 404],
        ['INVITE_EXPIRED', 410],
        ['INVITE_EMAIL_MISMATCH', 403],
        ['INVITE_ORG_BLOCKED', 403],
        ['ACCOUNT_ALREADY_IN_ORG', 409],
        ['MEMBER_LIMIT', 409]
    ];
    for (const [code, status] of cases) {
        const error = inviteRpcHttpError(`database error: ${code}`);
        assert.equal(error.code, code);
        assert.equal(error.status, status);
    }
    assert.equal(inviteRpcHttpError('unrelated database failure'), null);
});
