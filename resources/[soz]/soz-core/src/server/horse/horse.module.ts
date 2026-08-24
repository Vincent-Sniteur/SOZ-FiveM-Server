import { Module } from '@core/decorators/module';

import { HorseProvider } from './horse.provider';

@Module({
    providers: [HorseProvider],
})
export class HorseModule {}

