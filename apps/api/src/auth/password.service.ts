import { Inject, Injectable } from '@nestjs/common';
import { hash, verify } from '@node-rs/argon2';
import { APP_CONFIG, type AppConfig } from '@collab-docs/shared/nest';

/** argon2id hashing; the algorithm is the library default and every parameter is encoded in the hash itself. */
@Injectable()
export class PasswordService {
  private dummyHash?: Promise<string>;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  hash(password: string): Promise<string> {
    return hash(password, {
      memoryCost: this.config.ARGON2_MEMORY_KIB,
      timeCost: this.config.ARGON2_TIME_COST,
      parallelism: this.config.ARGON2_PARALLELISM,
    });
  }

  async verify(passwordHash: string, password: string): Promise<boolean> {
    try {
      return await verify(passwordHash, password);
    } catch {
      return false; // malformed hash
    }
  }

  /** Spends the same time as a real check, so unknown emails are not distinguishable by latency. */
  async verifyAgainstDummy(password: string): Promise<false> {
    this.dummyHash ??= this.hash('dummy-password-for-timing');
    await this.verify(await this.dummyHash, password);
    return false;
  }
}
