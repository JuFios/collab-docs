import { ApiProperty } from '@nestjs/swagger';
import type { CollabTicket } from '@collab-docs/shared';

export class CollabTicketResponse implements CollabTicket {
  @ApiProperty({
    description:
      'Short-lived (60 s) token for one WebSocket connection; fetch a new one per attempt.',
  })
  ticket!: string;

  @ApiProperty({
    description:
      'Base URL for y-websocket; the provider appends `/<documentId>?ticket=<ticket>`. ' +
      'Closes: 4401 ticket invalid (fetch a new one), 4403 no access, 4404 not found, 4410 deleted, 4429 rate limited.',
    example: 'ws://localhost:4001/ws',
  })
  wsUrl!: string;
}
