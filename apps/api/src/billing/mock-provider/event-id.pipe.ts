import { Injectable, type PipeTransform } from '@nestjs/common';
import { BILLING_EVENT_ID_PATTERN } from '@collab-docs/shared';
import { AppException } from '@collab-docs/nest';

/** An event id of the wrong shape gets the same 404 as one that was never issued. */
@Injectable()
export class EventIdPipe implements PipeTransform<string, string> {
  transform(id: string): string {
    if (!BILLING_EVENT_ID_PATTERN.test(id)) throw new AppException('NOT_FOUND', 'Event not found');
    return id;
  }
}
