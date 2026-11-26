import { describe, expect, it } from 'vitest';
import {
  buildSwitchCommand,
  mapCockpitAccounts,
  parseAccountListOutput,
  resolveAccountSwitcherConfig,
} from '../src/agent/account-switcher';
import { buildAccountCard } from '../src/card/command-cards';

describe('account-switcher', () => {
  it('parses plain text account lists with active marker', () => {
    const accounts = parseAccountListOutput([
      '* work@example.com',
      '  personal@example.com',
      'backup (active)',
    ].join('\n'));
    expect(accounts).toEqual([
      { id: 'work@example.com', label: 'work@example.com', active: true },
      { id: 'personal@example.com', label: 'personal@example.com', active: false },
      { id: 'backup', label: 'backup', active: true },
    ]);
  });

  it('parses JSON account lists', () => {
    const accounts = parseAccountListOutput(
      JSON.stringify([
        { name: 'acc1', label: '主号', active: true },
        { name: 'acc2', label: '备用号', active: false },
      ]),
    );
    expect(accounts).toEqual([
      { id: 'acc1', label: '主号', active: true },
      { id: 'acc2', label: '备用号', active: false },
    ]);
  });

  it('rejects shell metacharacters in account ids', () => {
    expect(buildSwitchCommand('agy-auth use {account}', 'work@example.com')).toBe('agy-auth use work@example.com');
    expect(() => buildSwitchCommand('agy-auth use {account}', 'foo; rm -rf /')).toThrow(/不允许的字符/);
  });

  it('resolves config from preferences', () => {
    expect(resolveAccountSwitcherConfig({ listCmd: 'agy-auth list', switchCmd: 'agy-auth use {account}' })).toEqual({
      listCmd: 'agy-auth list',
      switchCmd: 'agy-auth use {account}',
    });
  });

  it('renders unconfigured and configured /account cards cleanly', () => {
    const unconfigured = buildAccountCard({
      chatId: 'c1',
      requesterOpenId: 'u1',
      configured: false,
      accounts: [],
      createdAt: Date.now(),
    });
    expect(JSON.stringify(unconfigured)).toContain('accountSwitcher');

    const configured = buildAccountCard({
      chatId: 'c1',
      requesterOpenId: 'u1',
      configured: true,
      accounts: [{ id: 'work', label: 'work', active: true }],
      createdAt: Date.now(),
    });
    expect(JSON.stringify(configured)).toContain('account.pick');
  });

  it('maps Cockpit Tools response.accounts payload and filters disabled entries', () => {
    const mapped = mapCockpitAccounts(
      [
        { id: 'id-1', email: 'a@example.com', is_current: false, disabled: false, subscription_tier: 'PRO' },
        { id: 'id-2', email: 'b@example.com', is_current: false, disabled: true, subscription_tier: 'FREE' },
      ],
      'id-1',
    );
    expect(mapped).toEqual([{ id: 'id-1', label: 'a@example.com [PRO]', active: true }]);
  });
});
