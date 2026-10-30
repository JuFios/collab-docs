import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { getLoggerToken } from '@collab-docs/nest';
import { MailQueueService } from '../mail/mail-queue.service';
import { PrismaService } from '../prisma/prisma.service';
import { EmailVerificationService } from './email-verification.service';
import { hashToken } from './refresh-token.service';

const TOKEN = 'A'.repeat(43);
const USER_ID = '0198a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b';

async function setup(options: { updated: number; confirmedAt?: Date | null }) {
  const prisma = {
    emailVerification: {
      findUnique: jest.fn().mockResolvedValue({
        userId: USER_ID,
        tokenHash: hashToken(TOKEN),
        expiresAt: new Date(Date.now() + 3600_000),
        user: { email: 'ada@example.com' },
      }),
    },
    user: {
      updateMany: jest.fn().mockResolvedValue({ count: options.updated }),
      findUnique: jest.fn().mockResolvedValue({ emailVerifiedAt: options.confirmedAt ?? null }),
    },
  };
  const logger = { info: jest.fn() };
  const moduleRef = await Test.createTestingModule({
    providers: [
      EmailVerificationService,
      { provide: PrismaService, useValue: prisma },
      { provide: MailQueueService, useValue: {} },
      { provide: ConfigService, useValue: { get: () => 'http://localhost:3000' } },
      { provide: getLoggerToken(EmailVerificationService.name), useValue: logger },
    ],
  }).compile();
  return { prisma, logger, service: moduleRef.get(EmailVerificationService) };
}

describe('EmailVerificationService.verify', () => {
  it('confirms the address the link was sent to, and only while the account still has it', async () => {
    const { service, prisma, logger } = await setup({ updated: 1 });
    await service.verify(TOKEN);
    // an account released to a new registration between the lookup and the update has another address
    expect(prisma.user.updateMany).toHaveBeenCalledWith({
      where: { id: USER_ID, email: 'ada@example.com', emailVerifiedAt: null },
      data: { emailVerifiedAt: expect.any(Date) },
    });
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'auth.email_verified', userId: USER_ID }),
      'auth.email_verified',
    );
  });

  it('refuses the link when the account lost the address meanwhile', async () => {
    const { service } = await setup({ updated: 0, confirmedAt: null });
    await expect(service.verify(TOKEN)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('accepts the link again once the address is confirmed', async () => {
    const { service, logger } = await setup({ updated: 0, confirmedAt: new Date() });
    await expect(service.verify(TOKEN)).resolves.toBeUndefined();
    expect(logger.info).not.toHaveBeenCalled();
  });
});
