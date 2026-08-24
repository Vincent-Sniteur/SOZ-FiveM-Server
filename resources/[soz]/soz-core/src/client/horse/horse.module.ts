import { Module } from '@core/decorators/module';

import { HorseProvider } from './horse.provider';
import { HorseSyncProvider } from './horse.sync.provider';

@Module({
    providers: [HorseProvider, HorseSyncProvider],
})
export class HorseModule {}

