import { Inject } from '@core/decorators/injectable';
import { Provider } from '@core/decorators/provider';
import { Tick, TickInterval } from '@core/decorators/tick';

import { HorseAppearanceService } from '@public/client/horse/horse.appearance.service';
import { ClientEvent } from '@public/shared/event';
import { RiderAppearancePayload } from '@public/shared/horse';
import { getDistance, Vector3 } from '@public/shared/polyzone/vector';

type CachedRider = {
    horseNetId: number;
    ownerServerId: number;
    modelHash: number;
    skin: unknown;
    outfit: unknown;
    cloneEntity: number | null;
};

const STREAMING_CHECK_DISTANCE = 150;

@Provider()
export class HorseSyncProvider {
    @Inject(HorseAppearanceService)
    private appearanceService: HorseAppearanceService;

    private riders = new Map<number, CachedRider>();

    @Tick(1000)
    public async streamingLoop(): Promise<void> {
        const playerPed = PlayerPedId();
        const playerPosition = GetEntityCoords(playerPed) as Vector3;

        for (const [netId, rider] of this.riders.entries()) {
            const entity = NetworkGetEntityFromNetworkId(netId);

            // Entity gone or out of streaming range -> cleanup local clone
            if (!entity || !DoesEntityExist(entity)) {
                this.removeClone(rider);
                continue;
            }

            const distance = getDistance(playerPosition, GetEntityCoords(entity) as Vector3);
            if (distance > STREAMING_CHECK_DISTANCE) {
                this.removeClone(rider);
                continue;
            }

            // Entity in range but no clone yet -> create it
            if (!rider.cloneEntity || !DoesEntityExist(rider.cloneEntity)) {
                rider.cloneEntity = await this.appearanceService.createRiderClone({
                    horseNetId: netId,
                    ownerServerId: rider.ownerServerId,
                    modelHash: rider.modelHash,
                    skin: rider.skin,
                    outfit: rider.outfit,
                });
            }
        }
    }

    @OnEvent(ClientEvent.HORSE_RIDER_APPEARANCE)
    public onRiderAppearance(payload: RiderAppearancePayload): void {
        if (!payload || !payload.horseNetId) return;

        // The mounted player does not render their own clone locally.
        if (payload.ownerServerId === GetPlayerServerId(PlayerId())) return;

        this.riders.set(payload.horseNetId, {
            horseNetId: payload.horseNetId,
            ownerServerId: payload.ownerServerId,
            modelHash: payload.modelHash,
            skin: payload.skin,
            outfit: payload.outfit,
            cloneEntity: null,
        });
    }

    @OnEvent(ClientEvent.HORSE_RIDER_REMOVE)
    public onRiderRemove(horseNetId: number): void {
        const rider = this.riders.get(horseNetId);
        if (!rider) return;

        this.removeClone(rider);
        this.riders.delete(horseNetId);
    }

    @OnEvent(ClientEvent.HORSE_DESPAWN_SYNC)
    public onHorseDespawnSync(horseNetId: number): void {
        this.onRiderRemove(horseNetId);
    }

    private removeClone(rider: CachedRider): void {
        if (rider.cloneEntity && DoesEntityExist(rider.cloneEntity)) {
            DeleteEntity(rider.cloneEntity);
        }
        rider.cloneEntity = null;
    }
}
