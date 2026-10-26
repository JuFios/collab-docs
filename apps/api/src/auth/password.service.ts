import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { hash, verify } from '@node-rs/argon2';
import { type AppConfig } from '@collab-docs/nest';

/** argon2id hashing; the algorithm is the library default and every parameter is encoded in the hash itself. */
@Injectable()
export class PasswordService {
  private dummyHash?: Promise<string>;

  constructor(private readonly config: ConfigService<AppConfig, true>) {}

  hash(password: string): Promise<string> {
    return hash(password, {
      memoryCost: this.config.get('ARGON2_MEMORY_KIB', { infer: true }),
      timeCost: this.config.get('ARGON2_TIME_COST', { infer: true }),
      parallelism: this.config.get('ARGON2_PARALLELISM', { infer: true }),
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
