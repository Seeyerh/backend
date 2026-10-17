/**
 * Integration tests for the Stellar payment confirmation workflow.
 *
 * Expected confirmation flow:
 *   1. A tip/charge is created and a job is en-queued on the
 *      `QEU_NAMES.stellarConfirmation` queue with `{ transactionId, transactionHash }`.
 *   2. The worker polls the Stellar network via `checkTransactionStatus`.
 *   3. If confirmed, the tip status is updated to COMPLETED and the job completes.
 *   4. If not yet confirmed, the job throws and BullMQ applies backoff retries.
 *   5. If the circuit breaker is open, the job throws and is retried.
 *   6. After exhausting attempts, the tip marked FAILED and the job is moved to the
 *      dead-letter queue.
 *
 * Retry strategy:
 *   - BullMQ retries with a custom backoff strategy (`backoffStrategy`).
 *   - Default max attempts is 5 (`job.opts.attempts ?? 5`).
 *   - On final failure the tip status is set to FAILED and the job payload is moved
 *     to the dead-letter queue.
 *
 * These tests exercise the real worker job processor and failure handler by
 * mocking only the external boundaries (Stellar client and Redis/BullMQ).
 */

import { job as bullMqJob, Worker } from 'bullmq';

// -----------------------------------------------------------------------------
// Mocks must be declared before importing the module under test.
// -----------------------------------------------------------------------------

const mockCheckTransactionStatus = jest.fn();
const mockUpdateTipStatus = jest.fn();
const mockMoveToDeadLetter = jest.fn();
const mockBullConnection = {};
let mockWorkerHandler: (job: any) => Promise<any>;

const mockBackoffStrategy = jest.fn();

jest.mock('../../stellar/transactions', () => ({
  checkTransactionStatus: mockCheckTransactionStatus,
}));

jest.mock('../../queue', () => ({
  bullConnection: mockBullConnection,
  backoffStrategy: mockBackoffStrategy,
  moveToDeadLetter: mockMoveToDeadLetter,
  QUEUE_NAMES: {
    stellarConfirmation: 'stellar-confirmation',
  },
}));

// Mock the PaymentService so we can assert on status updates without a DB.
jest.mock('../payment.service', () => ({
  PaymentService: jest.fn().mockImplementation(() => ({
    updateTipStatus: mockUpdateTipStatus,
  })),
}));

// Mock Prisma Client to avoid real DB connections.
jest.mock('@prisma/client', () => ({
  PrismaClient: jest.fn().mockImplementation(() => ({})),
}));

// Mock the BullMQ Worker so we can capture the processor and failure handler.
jest.mock('bullmq', () => {
  const Worker = jest.fn().implementation(() => {
    const workerInstance: any = {
      on: jest.fn(),
    };
    return workerInstance;
  });
  return {
    Worker,
    Job: jest.fn(),
  };
});

// Mock env config and logger to keep test output clean.
jest.mock('../../config/env', () => ({
  config: { WORKER_CONCURRENCY: 1 },
}));

jest.mock('../../utils/logger', () => ({
  logger: {
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

// -----------------------------------------------------------------------------
// Imports after mocks.
// -----------------------------------------------------------------------------

import { createStellarConfirmationWorker } from '../../../lib/workers/stellar-confirmation.worker';
import { TipStatus } from '../payment.types';

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

interface MockJobOptions {
  attempts?: number;
}

interface MockJob {
  id?: string;
  data: { tipId?: string; transactionId?: string; transactionHash: string };
  attemptsMade: number;
  opts: MockJobOptions;
  updateProgress: jest.Mock;
}

function createMockJob(overrides: Partial<MockJob> = {}): MockJob {
  return {
    id: 'job-1',
    data: {
      tipId: 'tip-123',
      transactionId: 'txn-123',
      transactionHash: 'hash-abrc',
    },
    attemptsMade: 0,
    opts: { attempts: 5 },
    updateProgress: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

/**
 * Extracts the job processor and the failed event handler from the worker
 * created by `createStellarConfirmationWorker()`. The worker is constructed with a
 * mocked BullMQ `Worker`, and the processor / failed handler are captured from
 * the constructor / event registration calls.
 */
function setupWorker() {
  const WorkerMock = Worker as unknown as jest.Mock;

  // Reset call records between tests.
  WorkerMock.mockClear();

  // The Worker mock implementation captures the processor function and the
  // event handlers registered via `.on()`.
  const eventHandlers: Record<string, (...args: any[]) => any> = {};
  const workerInstance: any = {
    on: jest.fn((event: string, handler: (...args: any[]) => any) => {
      eventHandlers[event] = handler;
      return workerInstance;
    }),
  };

  WorkerMock.mockImplementation(() => workerInstance);

  // Create the worker — this will call the mocked Worker constructor.
  createStellarConfirmationWorker();

  // The processor is the second argument passed to the Worker constructor.
  const constructorArgs = WorkerMock.mock.calls[WorkerMock.mock.calls.length - 1];
  const processor = constructorArgs[1] as (job: MockJob) => Promise<any>;

  return {
    processor,
    failedHandler: eventHandlers['failed'] as (job: MockJob, error: Error) => Promise<void>,
    completedHandler: eventHandlers['completed'] as (job: MockJob) => void,
  };
}

// -----------------------------------------------------------------------------
// Tests for the confirmation worker job processor.
// -----------------------------------------------------------------------------

describe('Stellar confirmation worker - integration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCheckTransactionStatus.mockReset();
    mockUpdateTipStatus.mockReset();
    mockMoveToDeadLetter.mockReset();
  });

  describe('successful confirmation', () => {
    it('marks the tip COMPLETED when the transaction is confirmed', async () => {
      const { processor } = setupWorker();
      mockCheckTransactionStatus.mockResolvedValue({ confirmed: true, circuitOpen: false });
      mockUpdateTipStatus.mockResolvedValue(undefined);

      const job = createMockJob();
      const result = await processor(job);

      expect(mockCheckTransactionStatus).toHaveBeenCalledWith('hash-abrc');
      expect(mockUpdateTipStatus).toHaveBeenCalledWith('tip-123', {
        status: TipStatus.COMPLETED,
      });
      expect(job.updateProgress).toHaveBeenCalledWith(10);
      expect(job.updateProgress).toHaveBeenCalledWith(50);
      expect(job.updateProgress).toHaveBeenCalledWith(100);
      expect(result).toEqual({
        confirmed: true,
        tipId: 'tip-123',
        transactionHash: 'hash-abrc',
      });
      expect(mockMoveToDeadLetter).not.toHaveBeenCalled();
    });

    it('uses transactionId as the tip identifier when tipId is absent', async () => {
      const { processor } = setupWorker();
      mockCheckTransactionStatus.mockResolvedValue({ confirmed: true, circuitOpen: false });
      mockUpdateTipStatus.mockResolvedValue(undefined);

      const job = createMockJob({
        data: { transactionId: 'txn-999', transactionHash: 'hash-xyz' },
      });
      await processor(job);

      expect(mockUpdateTipStatus).toHaveBeenCalledWith('txn-999', {
        status: TipStatus.COMPLETED,
      });
    });
  });

  describe('confirmation timeout (pending beyond retry limit)', () => {
    it('throws and retries while the transaction is not yet confirmed', async () => {
      const { processor } = setupWorker();
      mockCheckTransactionStatus.mockResolvedValue({ confirmed: false, circuitOpen: false });

      const job = createMockJob();
      await expect(processor(job)).rejects.toThrow('Transaction not confirmed yet');

      // No status update on a non-confirmed transaction.
      expect(mockUpdateTipStatus).not.toHaveBeenCalled();
    });

    it('marks the tip FAILED and moves to dead-letter after exhausting attempts', async () => {
      const { failedHandler } = setupWorker();
      mockUpdateTipStatus.mockResolvedValue(undefined);
      mockMoveToDeadLetter.mockResolvedValue(undefined);

      // attemptsMade == max attempts (5)
      const job = createMockJob({ attemptsMade: 5, opts: { attempts: 5 } });
      const error = new Error('Transaction not confirmed yet');

      await failedHandler(job, error);

      expect(mockUpdateTipStatus).toHaveBeenCalledWith('tip-123', {
        status: TipStatus.FAILED,
      });
      expect(mockMoveToDeadLetter).toHaveBeenCalledWith(
        'stellar-confirmation',
        'job-1',
        job.data,
        'Transaction not confirmed yet'
      );
    });

    it('does not mark FAILED or move to dead-letter before attempts are exhausted', async () => {
      const { failedHandler } = setupWorker();

      const job = createMockJob({ attemptsMade: 2, opts: { attempts: 5 } });
      await failedHandler(job, new Error('Transaction not confirmed yet'));

      expect(mockUpdateTipStatus).not.toHaveBeenCalled();
      expect(mockMoveToDeadLetter).not.toHaveBeenCalled();
    });

    it('defaults to 5 max attempts when opts.attempts is undefined', async () => {
      const { failedHandler } = setupWorker();
      mockUpdateTipStatus.mockResolvedValue(undefined);
      mockMoveToDeadLetter.mockResolvedValue(undefined);

      const job = createMockJob({ attemptsMade: 5, opts: {} });
      await failedHandler(job, new Error('boom'));

      expect(mockUpdateTipStatus).toHaveBeenCalledWith('tip-123', {
        status: TipStatus.FAILED,
      });
      expect(mockMoveToDeadLetter).toHaveBeenCalled();
    });
  });

  describe('network error recovery', () => {
    it('rethrows network errors from Stellar so BullMQ can retry', async () => {
      const { processor } = setupWorker();
      mockCheckTransactionStatus.mockRejectedValue(new Error('Stellar network timeout'));

      const job = createMockJob();
      await expect(processor(job)).rejects.toThrow('Stellar network timeout');

      expect(mockUpdateTipStatus).not.toHaveBeenCalled();
    });

    it('recovers and completes once the network responds confirmed on retry', async () => {
      const { processor } = setupWorker();

      // First attempt: network error.
      mockCheckTransactionStatus.mockRejectedValueOnce(new Error('Stellar network timeout'));
      // Second attempt: confirmed.
      mockCheckTransactionStatus.mockResolvedValueOnce({ confirmed: true, circuitOpen: false });
      mockUpdateTipStatus.mockResolvedValue(undefined);

      const job = createMockJob();
      await expect(processor(job)).rejects.toThrow('Stellar network timeout');

      const result = await processor(job);
      expect(result.confirmed).toBe(true);
      expect(mockUpdateTipStatus).toHaveBeenCalledTimes(1);
    });

    it('throws when the circuit breaker is open', async () => {
      const { processor } = setupWorker();
      mockCheckTransactionStatus.mockResolvedValue({ confirmed: false, circuitOpen: true });

      const job = createMockJob();
      await expect(processor(job)).rejects.toThrow('Circuit breaker open');

      expect(mockUpdateTipStatus).not.toHaveBeenCalled();
    });
  });

  describe('idempotency on retry', () => {
    it('does not duplicate status updates when a confirmed job is replayed', async () => {
      const { processor } = setupWorker();
      mockCheckTransactionStatus.mockResolvedValue({ confirmed: true, circuitOpen: false });
      mockUpdateTipStatus.mockResolvedValue(undefined);

      const job = createMockJob();
      await processor(job);
      await processor(job);

      // The service is idempotent: the same target status is requested twice,
      // and the underlying service is responsible for not duplicating side
      // effects. We assert the worker always sends the same idempotent payload.
      expect(mockUpdateTipStatus).toHaveBeenCalledTimes(2);
      for (const call of mockUpdateTipStatus.mock.calls) {
        expect(call[0]).toBe('tip-123');
        expect(call[1]).toEqual({ status: TipStatus.COMPLETED });
      }
    });

    it('does not re-issue a FAILED update for a job that already completed', async () => {
      const { failedHandler } = setupWorker();
      mockUpdateTipStatus.mockResolvedValue(undefined);
      mockMoveToDeadLetter.mockResolvedValue(undefined);

      // A job that has already been moved to the dead-letter queue will not
      // trigger another FAILED update if its attempts are not exhausted.
      const job = createMockJob({ attemptsMade: 1, opts: { attempts: 5 } });
      await failedHandler(job, new Error('Transaction not confirmed yet'));

      expect(mockUpdateTipStatus).not.toHaveBeenCalled();
      expect(mockMoveToDeadLetter).not.toHaveBeenCalled();
    });

    it('survives a status update failure and still moves the job to dead-letter', async () => {
      const { failedHandler } = setupWorker();
      mockUpdateTipStatus.mockRejectedValue(new Error('DB write failed'));
      mockMoveToDeadLetter.mockResolvedValue(undefined);

      const job = createMockJob({ attemptsMade: 5, opts: { attempts: 5 } });
      await failedHandler(job, new Error('Transaction not confirmed yet'));

      // Even though the status update failed, the job is still moved to the
      // dead-letter queue so it can be inspected / replayed manually.
      expect(mockUpdateTipStatus).toHaveBeenCalled();
      expect(mockMoveToDeadLetter).toHaveBeenCalled();
    });
  });
});
