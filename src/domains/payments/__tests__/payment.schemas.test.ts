import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import { Keypair } from '@stellar/stellar-sdk';
import {
  BuildPaymentTransactionSchema,
  CreateTipSchema,
  MemoSchema,
  SubmitPaymentTransactionSchema,
  TipHistoryQuerySchema,
  buildPaymentTransactionJsonSchema,
  createTipJsonSchema,
} from '../payment.schemas';
import { MEMO_MAX_LENGTH } from '../../../lib/stellar/validation';
import { validateRequest } from '../../../middleware/validation';
import { AppError } from '../../../utils/errors';

const validPublicKey = Keypair.random().publicKey();

/** A valid transaction build body, with an optional memo. */
const buildBody = (memo?: string) => ({
  senderPublicKey: validPublicKey,
  creatorPublicKey: validPublicKey,
  amount: '10',
  ...(memo === undefined ? {} : { memo }),
});

describe('CreateTipSchema', () => {
  it('accepts a valid tip and applies defaults', () => {
    const result = CreateTipSchema.parse({ creatorId: 'creator-1', amount: 25 });
    expect(result.currency).toBe('USD');
    expect(result.amount).toBe(25);
  });

  it('sanitizes the message', () => {
    const result = CreateTipSchema.parse({
      creatorId: 'creator-1',
      amount: 5,
      message: '  <script>hi</script>  ',
    });
    expect(result.message).toBe('hi');
  });

  it('rejects invalid amounts', () => {
    expect(CreateTipSchema.safeParse({ creatorId: 'c', amount: 0 }).success).toBe(false);
    expect(CreateTipSchema.safeParse({ creatorId: 'c', amount: -1 }).success).toBe(false);
    expect(CreateTipSchema.safeParse({ creatorId: 'c', amount: 2_000_000 }).success).toBe(false);
  });

  it('rejects an over-long message', () => {
    const result = CreateTipSchema.safeParse({
      creatorId: 'c',
      amount: 5,
      message: 'a'.repeat(501),
    });
    expect(result.success).toBe(false);
  });

  it('rejects a missing creatorId', () => {
    expect(CreateTipSchema.safeParse({ amount: 5 }).success).toBe(false);
  });
});

describe('BuildPaymentTransactionSchema', () => {
  it('accepts valid Stellar inputs', () => {
    const result = BuildPaymentTransactionSchema.safeParse({
      senderPublicKey: validPublicKey,
      creatorPublicKey: validPublicKey,
      amount: '10.5',
      assetCode: 'USDC',
    });
    expect(result.success).toBe(true);
  });

  it('rejects invalid public keys using StrKey validation', () => {
    const result = BuildPaymentTransactionSchema.safeParse({
      senderPublicKey: 'GINVALID',
      creatorPublicKey: validPublicKey,
      amount: '10',
    });
    expect(result.success).toBe(false);
  });

  it('rejects malformed or excessive amounts', () => {
    expect(
      BuildPaymentTransactionSchema.safeParse({
        senderPublicKey: validPublicKey,
        creatorPublicKey: validPublicKey,
        amount: 'abc',
      }).success
    ).toBe(false);

    expect(
      BuildPaymentTransactionSchema.safeParse({
        senderPublicKey: validPublicKey,
        creatorPublicKey: validPublicKey,
        amount: '999999999',
      }).success
    ).toBe(false);
  });

  it('rejects invalid asset codes', () => {
    expect(
      BuildPaymentTransactionSchema.safeParse({
        senderPublicKey: validPublicKey,
        creatorPublicKey: validPublicKey,
        amount: '10',
        assetCode: 'NOT A CODE',
      }).success
    ).toBe(false);
  });
});

describe('MemoSchema (#180)', () => {
  it('leaves the memo optional', () => {
    const result = BuildPaymentTransactionSchema.safeParse(buildBody());
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.memo).toBeUndefined();
    }
  });

  it('accepts a memo of exactly 28 bytes', () => {
    const memo = 'a'.repeat(MEMO_MAX_LENGTH);
    const result = BuildPaymentTransactionSchema.safeParse(buildBody(memo));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.memo).toBe(memo);
    }
  });

  it('rejects a memo of 29 bytes with a field error naming the byte limit', () => {
    const result = BuildPaymentTransactionSchema.safeParse(
      buildBody('a'.repeat(MEMO_MAX_LENGTH + 1))
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((entry) => entry.path.join('.') === 'memo');
      expect(issue?.message).toContain(`${MEMO_MAX_LENGTH} UTF-8 bytes`);
    }
  });

  it('counts UTF-8 bytes, not characters', () => {
    // 15 two byte characters fit in 28 characters but need 30 bytes.
    const twoByteChars = 'é'.repeat(15);
    expect(twoByteChars.length).toBeLessThanOrEqual(MEMO_MAX_LENGTH);
    expect(MemoSchema.safeParse(twoByteChars).success).toBe(false);

    // Seven four byte characters are exactly 28 bytes; eight are not.
    expect(MemoSchema.safeParse('\u{1F600}'.repeat(7)).success).toBe(true);
    expect(MemoSchema.safeParse('\u{1F600}'.repeat(8)).success).toBe(false);
  });

  it('rejects an empty memo', () => {
    expect(MemoSchema.safeParse('').success).toBe(false);
    expect(MemoSchema.safeParse('   ').success).toBe(false);
  });

  it('answers 400 with a field error before the route handler runs', async () => {
    const app = Fastify({ logger: false });
    const handler = vi.fn(async () => ({ built: true }));

    app.setErrorHandler((error, _request, reply) => {
      if (error instanceof AppError) {
        reply
          .code(error.statusCode)
          .send({ code: error.code, message: error.message, details: error.details });
        return;
      }
      reply.code(500).send({ message: error.message });
    });
    app.post(
      '/build',
      { preHandler: [validateRequest({ body: BuildPaymentTransactionSchema })] },
      handler
    );
    await app.ready();

    try {
      const res = await app.inject({
        method: 'POST',
        url: '/build',
        payload: buildBody('a'.repeat(MEMO_MAX_LENGTH + 1)),
      });

      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.code).toBe('VALIDATION_ERROR');
      expect(body.details.fields['body.memo']).toContain(`${MEMO_MAX_LENGTH} UTF-8 bytes`);
      expect(handler).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});

describe('SubmitPaymentTransactionSchema', () => {
  it('requires an envelope', () => {
    expect(SubmitPaymentTransactionSchema.safeParse({}).success).toBe(false);
    expect(SubmitPaymentTransactionSchema.safeParse({ transactionEnvelope: 'AAAA...' }).success).toBe(
      true
    );
  });
});

describe('TipHistoryQuerySchema', () => {
  it('coerces numeric query values', () => {
    const result = TipHistoryQuerySchema.parse({ page: '2', pageSize: '25', first: '5' });
    expect(result.page).toBe(2);
    expect(result.pageSize).toBe(25);
    expect(result.first).toBe(5);
  });

  it('rejects out-of-range pagination', () => {
    expect(TipHistoryQuerySchema.safeParse({ pageSize: '1000' }).success).toBe(false);
    expect(TipHistoryQuerySchema.safeParse({ page: '0' }).success).toBe(false);
  });

  it('normalizes sort order and validates allowed sort fields', () => {
    expect(TipHistoryQuerySchema.parse({ sortOrder: 'DESC' }).sortOrder).toBe('desc');
    expect(TipHistoryQuerySchema.safeParse({ sortBy: 'password' }).success).toBe(false);
    expect(TipHistoryQuerySchema.safeParse({ sortBy: 'createdAt,amount' }).success).toBe(true);
  });

  it('validates the status filter', () => {
    expect(TipHistoryQuerySchema.safeParse({ status: 'completed' }).success).toBe(true);
    expect(TipHistoryQuerySchema.safeParse({ status: 'bogus' }).success).toBe(false);
  });
});

describe('derived OpenAPI schemas', () => {
  it('derives a JSON schema for the tip body', () => {
    const schema = createTipJsonSchema as {
      type: string;
      required: string[];
      properties: Record<string, unknown>;
    };
    expect(schema.type).toBe('object');
    expect(schema.properties).toHaveProperty('amount');
    expect(schema.properties).toHaveProperty('currency');
    expect(schema.required).toEqual(expect.arrayContaining(['creatorId', 'amount']));
    // currency has a default and must not be required
    expect(schema.required).not.toContain('currency');
  });

  it('derives a JSON schema for the transaction build body', () => {
    const schema = buildPaymentTransactionJsonSchema as { properties: Record<string, unknown> };
    expect(schema.properties).toHaveProperty('senderPublicKey');
    expect(schema.properties).toHaveProperty('creatorPublicKey');
  });

  it('documents the memo byte limit on the transaction build body', () => {
    const schema = buildPaymentTransactionJsonSchema as {
      required?: string[];
      properties: Record<string, { type?: string; description?: string }>;
    };
    expect(schema.properties.memo.type).toBe('string');
    expect(schema.properties.memo.description).toContain(`${MEMO_MAX_LENGTH} bytes`);
    expect(schema.required ?? []).not.toContain('memo');
  });
});
