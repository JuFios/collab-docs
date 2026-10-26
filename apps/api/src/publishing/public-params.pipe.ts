import { Injectable, type PipeTransform } from '@nestjs/common';
import {
  EDIT_TOKEN_PATTERN,
  PUBLIC_SLUG_MAX_LENGTH,
  PUBLIC_SLUG_PATTERN,
} from '@collab-docs/shared';
import { AppException } from '@collab-docs/nest';

/**
 * Path parameters of the anonymous endpoints. A value of the wrong shape gets the same 404 as one that does not
 * exist, so the endpoints do not tell a malformed address from a missing one.
 */
@Injectable()
export class PublicSlugPipe implements PipeTransform<string, string> {
  transform(slug: string): string {
    if (slug.length > PUBLIC_SLUG_MAX_LENGTH || !PUBLIC_SLUG_PATTERN.test(slug)) {
      throw new AppException('NOT_FOUND', 'Page not found');
    }
    return slug;
  }
}

@Injectable()
export class EditTokenPipe implements PipeTransform<string, string> {
  transform(token: string): string {
    if (!EDIT_TOKEN_PATTERN.test(token)) throw new AppException('NOT_FOUND', 'Link not found');
    return token;
  }
}
