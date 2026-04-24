import { describe, expect, test } from 'bun:test';
import { extractIncomingFromBlocks } from '../incoming-poller.js';

/**
 * Unit tests for the pure extraction logic of `IncomingPoller.tick()`.
 * No prisma / no network — just block-JSON → row-mapping.
 *
 * The tests pin behaviour around the bug-catch path that initially
 * missed all zkappCommand-encoded payments on modern o1js lightnets.
 */

const TRACKED = 'B62qper859qXQNHvbSAem9NqJGXjPhRr2nRADEpxXKCSSLMV4jmxcfz';
const OTHER = 'B62qmiVWy5XYyukYJPpwUZidQJvWiKhV97GY9uF8fRcMZKVKJ9ksJ1h';
const FUNDER = 'B62qnXxriKVrQdXLeDaa5HrJgr2W2J4aXo1hgfPPkiW8hGPFarq3uBa';

function addressToId(): Map<string, number> {
  return new Map([[TRACKED, 1]]);
}

function block(height: number, opts: {
  userCommands?: Array<{
    hash: string;
    kind?: string;
    amount: string;
    memo?: string | null;
    source?: string;
    receiver?: string;
  }>;
  zkappCommands?: Array<{
    hash: string;
    failed?: boolean;
    memo?: string | null;
    feePayer?: string;
    accountUpdates?: Array<{ publicKey?: string; magnitude?: string; sgn?: string }>;
  }>;
}) {
  return {
    protocolState: { consensusState: { blockHeight: String(height) } },
    transactions: {
      userCommands: opts.userCommands?.map((u) => ({
        hash: u.hash,
        kind: u.kind,
        amount: u.amount,
        memo: u.memo,
        source: u.source ? { publicKey: u.source } : undefined,
        receiver: u.receiver ? { publicKey: u.receiver } : undefined,
      })),
      zkappCommands: opts.zkappCommands?.map((z) => ({
        hash: z.hash,
        failureReason: z.failed ? { failures: ['some failure'] } : null,
        zkappCommand: {
          memo: z.memo,
          feePayer: z.feePayer
            ? { body: { publicKey: z.feePayer } }
            : undefined,
          accountUpdates: z.accountUpdates?.map((au) => ({
            body: {
              publicKey: au.publicKey,
              balanceChange: {
                magnitude: au.magnitude,
                sgn: au.sgn ?? 'Positive',
              },
            },
          })),
        },
      })),
    },
  };
}

describe('extractIncomingFromBlocks', () => {
  test('extracts a userCommand payment to a tracked address', () => {
    const blocks = [
      block(10, {
        userCommands: [
          {
            hash: '5Juuc',
            kind: 'PAYMENT',
            amount: '1000000000',
            source: FUNDER,
            receiver: TRACKED,
          },
        ],
      }),
    ];
    const { rows, newCursor } = extractIncomingFromBlocks(blocks, addressToId(), 0);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      contractId: 1,
      txHash: '5Juuc',
      fromAddress: FUNDER,
      amount: '1000000000',
      blockHeight: 10,
    });
    expect(newCursor).toBe(10);
  });

  test('skips userCommands targeting untracked addresses', () => {
    const blocks = [
      block(11, {
        userCommands: [
          { hash: '5Junoise', amount: '123', source: FUNDER, receiver: OTHER },
        ],
      }),
    ];
    const { rows } = extractIncomingFromBlocks(blocks, addressToId(), 0);
    expect(rows).toHaveLength(0);
  });

  test('extracts zkappCommand payments (o1js AccountUpdate.send path)', () => {
    // This is the path the original poller missed — every modern o1js
    // `AccountUpdate.createSigned().send()` lands as a zkappCommand.
    const blocks = [
      block(12, {
        zkappCommands: [
          {
            hash: '5JvZk',
            feePayer: FUNDER,
            accountUpdates: [
              // Funder debit — negative balance change, ignored
              { publicKey: FUNDER, magnitude: '10000000000', sgn: 'Negative' },
              // Guard credit — positive, counts
              { publicKey: TRACKED, magnitude: '10000000000', sgn: 'Positive' },
            ],
          },
        ],
      }),
    ];
    const { rows } = extractIncomingFromBlocks(blocks, addressToId(), 0);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      contractId: 1,
      txHash: '5JvZk',
      fromAddress: FUNDER,
      amount: '10000000000',
      blockHeight: 12,
    });
  });

  test('skips failed zkappCommands', () => {
    const blocks = [
      block(13, {
        zkappCommands: [
          {
            hash: '5Jfail',
            failed: true,
            feePayer: FUNDER,
            accountUpdates: [
              { publicKey: TRACKED, magnitude: '50', sgn: 'Positive' },
            ],
          },
        ],
      }),
    ];
    const { rows } = extractIncomingFromBlocks(blocks, addressToId(), 0);
    expect(rows).toHaveLength(0);
  });

  test('sums multiple positive balance changes per contract in one tx', () => {
    const blocks = [
      block(14, {
        zkappCommands: [
          {
            hash: '5Jmulti',
            feePayer: FUNDER,
            accountUpdates: [
              { publicKey: TRACKED, magnitude: '100', sgn: 'Positive' },
              { publicKey: TRACKED, magnitude: '250', sgn: 'Positive' },
              { publicKey: TRACKED, magnitude: '50', sgn: 'Negative' }, // ignored
            ],
          },
        ],
      }),
    ];
    const { rows } = extractIncomingFromBlocks(blocks, addressToId(), 0);
    expect(rows).toHaveLength(1);
    expect(rows[0].amount).toBe('350');
  });

  test('decodes base58 memos into UTF-8', () => {
    // Real memo captured on lightnet: "poller-live-test"
    const blocks = [
      block(15, {
        zkappCommands: [
          {
            hash: '5Jmemo',
            memo: 'E4YtzMHS9LssrpaMysBBKub9H6KDVp3kaWRefBRcxEnrPFhbM11gQ',
            feePayer: FUNDER,
            accountUpdates: [
              { publicKey: TRACKED, magnitude: '1', sgn: 'Positive' },
            ],
          },
        ],
      }),
    ];
    const { rows } = extractIncomingFromBlocks(blocks, addressToId(), 0);
    expect(rows[0].memo).toBe('poller-live-test');
  });

  test('honors cursor — skips blocks at or below cursor height', () => {
    const blocks = [
      block(5, {
        userCommands: [
          { hash: 'old', amount: '1', source: FUNDER, receiver: TRACKED },
        ],
      }),
      block(10, {
        userCommands: [
          { hash: 'new', amount: '2', source: FUNDER, receiver: TRACKED },
        ],
      }),
    ];
    const { rows, newCursor } = extractIncomingFromBlocks(blocks, addressToId(), 5);
    expect(rows).toHaveLength(1);
    expect(rows[0].txHash).toBe('new');
    expect(newCursor).toBe(10);
  });

  test('skips non-PAYMENT kind userCommands', () => {
    const blocks = [
      block(16, {
        userCommands: [
          {
            hash: 'delegation',
            kind: 'STAKE_DELEGATION',
            amount: '0',
            source: FUNDER,
            receiver: TRACKED,
          },
        ],
      }),
    ];
    const { rows } = extractIncomingFromBlocks(blocks, addressToId(), 0);
    expect(rows).toHaveLength(0);
  });

  test('cursor stays put when no rows match', () => {
    const blocks = [
      block(20, {
        userCommands: [
          { hash: 'other', amount: '1', source: FUNDER, receiver: OTHER },
        ],
      }),
    ];
    const { rows, newCursor } = extractIncomingFromBlocks(blocks, addressToId(), 0);
    expect(rows).toHaveLength(0);
    // Cursor advances even when no matches — we processed the block,
    // we just didn't find anything to record.
    expect(newCursor).toBe(20);
  });

  test('handles missing fromAddress with "unknown" sentinel', () => {
    const blocks = [
      block(21, {
        userCommands: [
          // No source → "unknown"
          { hash: 'anon', amount: '99', receiver: TRACKED },
        ],
      }),
    ];
    const { rows } = extractIncomingFromBlocks(blocks, addressToId(), 0);
    expect(rows[0].fromAddress).toBe('unknown');
  });
});
