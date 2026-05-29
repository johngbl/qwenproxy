import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { getNextAccount } from '../core/account-manager.ts';

test('Account Rotation: Round-Robin rotation cycle', async () => {
  const ACCOUNTS_FILE = path.resolve('accounts.json');
  let originalContent: string | null = null;
  if (fs.existsSync(ACCOUNTS_FILE)) {
    originalContent = fs.readFileSync(ACCOUNTS_FILE, 'utf-8');
  }

  try {
    const mockAccounts = [
      { id: 'acc1', email: 'account1@test.com', password: 'password1' },
      { id: 'acc2', email: 'account2@test.com', password: 'password2' },
      { id: 'acc3', email: 'account3@test.com', password: 'password3' },
    ];
    fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(mockAccounts, null, 2));

    // Force current index restart or just verify consecutive selections
    const first = getNextAccount();
    const second = getNextAccount();
    const third = getNextAccount();
    const fourth = getNextAccount();

    assert.ok(first);
    assert.ok(second);
    assert.ok(third);
    assert.ok(fourth);

    // Verify it cycles in order
    assert.strictEqual(first.email, 'account1@test.com');
    assert.strictEqual(second.email, 'account2@test.com');
    assert.strictEqual(third.email, 'account3@test.com');
    assert.strictEqual(fourth.email, 'account1@test.com'); // should rotate back to the start

  } finally {
    if (originalContent !== null) {
      fs.writeFileSync(ACCOUNTS_FILE, originalContent);
    } else if (fs.existsSync(ACCOUNTS_FILE)) {
      fs.unlinkSync(ACCOUNTS_FILE);
    }
  }
});
