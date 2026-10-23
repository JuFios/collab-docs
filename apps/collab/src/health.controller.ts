import { Controller, Get } from '@nestjs/common';

@Controller()
export class HealthController {
  @Get('health')
  health(): { status: 'ok' } {
    return { status: 'ok' };
  }

  // Placeholder: dependency checks (database, redis) arrive with the API platform work.
  @Get('ready')
  ready(): { status: 'ok' } {
    return { status: 'ok' };
  }
}
