import { Global, Module } from '@nestjs/common';

import { JsonLoggerService } from './json-logger.service';

@Global()
@Module({
  providers: [JsonLoggerService],
  exports: [JsonLoggerService],
})
export class LoggingModule {}
