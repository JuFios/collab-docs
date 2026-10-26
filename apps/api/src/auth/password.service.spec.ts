import type { AppConfig } from '@collab-docs/nest';
import { PasswordService } from './password.service';

const config = { ARGON2_MEMORY_KIB: 1024, ARGON2_TIME_COST: 1, ARGON2_PARALLELISM: 1 } as AppConfig;

describe('PasswordService', () => {
  const service = new PasswordService(config);

  it('hashes with argon2id using the configured parameters and a random salt', async () => {
    const a = await service.hash('correct-horse-battery');
    const b = await service.hash('correct-horse-battery');
    expect(a).toMatch(/^\$argon2id\$v=19\$m=1024,t=1,p=1\$/);
    expect(a).not.toBe(b);
    expect(a).not.toContain('correct-horse');
  });

  it('verifies the right password only', async () => {
    const hash = await service.hash('correct-horse-battery');
    await expect(service.verify(hash, 'correct-horse-battery')).resolves.toBe(true);
    await expect(service.verify(hash, 'wrong-horse-battery')).resolves.toBe(false);
  });

  it('treats a malformed hash as a mismatch and the dummy check as failure', async () => {
    await expect(service.verify('not-a-hash', 'x')).resolves.toBe(false);
    await expect(service.verifyAgainstDummy('x')).resolves.toBe(false);
  });
});
