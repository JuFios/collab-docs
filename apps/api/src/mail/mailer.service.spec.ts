import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { createTransport } from 'nodemailer';
import { getLoggerToken } from '@collab-docs/nest';
import { MailerService } from './mailer.service';
import { isReleasedAddress, releasedAddress } from './released-address';

jest.mock('nodemailer');

const MESSAGE = { subject: 'Hello', html: '<p>Hello</p>', text: 'Hello' };

async function setup() {
  const sendMail = jest.fn().mockResolvedValue({});
  jest.mocked(createTransport).mockReturnValue({ sendMail, close: jest.fn() } as never);
  const logger = { info: jest.fn() };
  const moduleRef = await Test.createTestingModule({
    providers: [
      MailerService,
      { provide: ConfigService, useValue: { get: () => 'value' } },
      { provide: getLoggerToken(MailerService.name), useValue: logger },
    ],
  }).compile();
  return { sendMail, logger, service: moduleRef.get(MailerService) };
}

describe('MailerService', () => {
  it('hands a message to the transport', async () => {
    const { service, sendMail } = await setup();
    await service.send({ to: 'ada@example.com', ...MESSAGE });
    expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({ to: 'ada@example.com' }));
  });

  it('writes to nobody who gave up their address, and does not fail the job', async () => {
    const { service, sendMail, logger } = await setup();
    await expect(
      service.send({ to: releasedAddress('0198a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b'), ...MESSAGE }),
    ).resolves.toBeUndefined();
    expect(sendMail).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'mail.skipped', reason: 'released_address' }),
      'mail.skipped',
    );
  });
});

describe('released addresses', () => {
  it('belong to a domain that never resolves, whatever the case', () => {
    expect(releasedAddress('abc')).toBe('abc@released.invalid');
    expect(isReleasedAddress('abc@released.invalid')).toBe(true);
    expect(isReleasedAddress('ABC@Released.Invalid')).toBe(true);
  });

  it('are not mistaken for other addresses', () => {
    expect(isReleasedAddress('ada@example.com')).toBe(false);
    expect(isReleasedAddress('ada@released.invalid.example.com')).toBe(false);
    expect(isReleasedAddress('ada@notreleased.invalid')).toBe(false);
  });
});
