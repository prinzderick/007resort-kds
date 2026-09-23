import { describe, expect, it } from 'vitest';
import {
  eventIdOf,
  parseLogin,
  parseStation,
  parseSystemInfo,
  parseTicket,
  parseTicketPayload,
} from './dto';

const wire = {
  id: 't1',
  number: 'K-042',
  stationId: 's1',
  orderNumber: 'RST1-000123',
  tableLabel: 'T12',
  status: 'NEW',
  items: [
    {
      orderLineId: 'l1',
      name: 'Jollof Rice & Chicken',
      quantity: 2,
      notes: 'no pepper',
      status: 'NEW',
    },
  ],
  createdAt: '2026-09-23T10:15:30.123456Z',
  acceptedAt: null,
  readyAt: null,
  waiterName: 'Amaka O.',
  rowVersion: 7,
};

describe('parseTicket', () => {
  it('maps the contract PrepTicket to the view model', () => {
    expect(parseTicket(wire)).toEqual({
      id: 't1',
      number: 'K-042',
      stationCode: 's1',
      status: 'NEW',
      createdAtUtc: '2026-09-23T10:15:30.123456Z',
      version: 7,
      items: [{ name: 'Jollof Rice & Chicken', quantity: 2, notes: 'no pepper' }],
      tableLabel: 'T12',
      orderNumber: 'RST1-000123',
      serverName: 'Amaka O.',
    });
  });

  it('drops tickets it cannot understand instead of guessing', () => {
    expect(parseTicket({ ...wire, status: 'WEIRD' })).toBeNull();
    expect(parseTicket({ ...wire, rowVersion: undefined })).toBeNull();
    expect(parseTicket({ ...wire, createdAt: 'nope' })).toBeNull();
    expect(parseTicket('x')).toBeNull();
  });

  it('unwraps the realtime envelope and bare payloads', () => {
    const envelope = {
      eventId: 'e1',
      occurredAt: 'x',
      data: { ticket: wire, previousStatus: 'NEW' },
    };
    expect(parseTicketPayload(envelope)?.id).toBe('t1');
    expect(parseTicketPayload({ ticket: wire })?.id).toBe('t1');
    expect(parseTicketPayload(wire)?.id).toBe('t1');
    expect(eventIdOf(envelope)).toBe('e1');
    expect(eventIdOf(wire)).toBeNull();
  });

  it('reads item modifiers when provided', () => {
    const t = parseTicket({
      ...wire,
      items: [{ name: 'Burger', quantity: 1, modifiers: ['no onions', { name: 'extra cheese' }] }],
    });
    expect(t?.items[0]?.modifiers).toEqual(['no onions', 'extra cheese']);
  });
});

describe('other DTOs', () => {
  it('parses stations, skipping inactive ones', () => {
    expect(
      parseStation({ id: 's1', name: 'Kitchen Pass', kind: 'KITCHEN', active: true }),
    ).toMatchObject({ id: 's1', name: 'Kitchen Pass' });
    expect(parseStation({ id: 's1', name: 'x', active: false })).toBeNull();
  });

  it('parses login results (permissions optional)', () => {
    expect(
      parseLogin({
        accessToken: 'a',
        refreshToken: 'r',
        expiresInSeconds: 900,
        staff: { displayName: 'Ada', permissions: ['x'] },
      }),
    ).toMatchObject({
      staffName: 'Ada',
      permissions: ['x'],
      expiresInSeconds: 900,
    });
    expect(parseLogin({ accessToken: 'a' })?.permissions).toBeNull();
    expect(parseLogin({})).toBeNull();
  });

  it('parses system info incl. the realtime block', () => {
    const info = parseSystemInfo({
      serverTime: '2026-09-23T10:00:00Z',
      minClientVersion: { kds: '0.2.0' },
      realtime: { scheme: 'wss', host: 'h', port: 443, appKey: 'k' },
    });
    expect(info.realtime).toEqual({ scheme: 'wss', host: 'h', port: 443, appKey: 'k' });
    expect(info.minKdsVersion).toBe('0.2.0');
    expect(info.serverTimeMs).toBe(Date.parse('2026-09-23T10:00:00Z'));
    expect(parseSystemInfo({}).realtime).toBeNull();
  });
});
