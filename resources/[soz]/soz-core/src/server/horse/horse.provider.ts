import { On, OnEvent, Once } from '@core/decorators/event';
import { Inject } from '@core/decorators/injectable';
import { Provider } from '@core/decorators/provider';
import { Rpc } from '@core/decorators/rpc';

import { ItemService } from '@public/server/item/item.service';
import { Notifier } from '@public/server/notifier';
import { PlayerService } from '@public/server/player/player.service';
import { ClientEvent, ServerEvent } from '@public/shared/event';
import { CRAVACHE_ITEM_NAME, HorseState, RiderAppearancePayload } from '@public/shared/horse';
import { RpcServerEvent } from '@public/shared/rpc';

type ServerHorse = {
    ownerCitizenId: string;
    ownerSource: number;
    netId: number;
    state: HorseState;
    rider: RiderAppearancePayload | null;
};

@Provider()
export class HorseProvider {
    @Inject(ItemService)
    private itemService: ItemService;

    @Inject(PlayerService)
    private playerService: PlayerService;

    @Inject(Notifier)
    private notifier: Notifier;

    private horsesByCitizenId = new Map<string, ServerHorse>();
    private horsesBySource = new Map<number, ServerHorse>();

    @Once()
    public onStart(): void {
        this.itemService.setItemUseCallback(CRAVACHE_ITEM_NAME, this.useCravache.bind(this));
    }

    private async useCravache(source: number): Promise<void> {
        const player = this.playerService.getPlayer(source);
        if (!player) return;

        const existing = this.horsesByCitizenId.get(player.citizenid);

        if (existing) {
            // Toggle -> despawn
            TriggerClientEvent(ClientEvent.HORSE_DESPAWN, source);
            return;
        }

        TriggerClientEvent(ClientEvent.HORSE_SPAWN, source);
    }

    @OnEvent(ServerEvent.HORSE_SPAWNED)
    public onHorseSpawned(source: number, netId: number): void {
        const player = this.playerService.getPlayer(source);
        if (!player || !netId) return;

        if (this.horsesByCitizenId.has(player.citizenid)) {
            this.notifier.error(source, 'Vous avez déjà un cheval actif.');
            return;
        }

        const horse: ServerHorse = {
            ownerCitizenId: player.citizenid,
            ownerSource: source,
            netId,
            state: HorseState.Idle,
            rider: null,
        };

        this.horsesByCitizenId.set(player.citizenid, horse);
        this.horsesBySource.set(source, horse);
    }

    @OnEvent(ServerEvent.HORSE_DESPAWNED)
    public onHorseDespawned(source: number): void {
        const player = this.playerService.getPlayer(source);
        if (!player) return;

        const horse = this.horsesByCitizenId.get(player.citizenid);
        if (horse?.netId) {
            TriggerClientEvent(ClientEvent.HORSE_DESPAWN_SYNC, -1, horse.netId);
        }
        this.purge(horse);
    }

    @OnEvent(ServerEvent.HORSE_MOUNT_REQUEST)
    public onMountRequest(source: number, netId: number): void {
        const player = this.playerService.getPlayer(source);
        if (!player) return;

        const horse = this.horsesByCitizenId.get(player.citizenid);
        if (!horse || horse.netId !== netId || horse.ownerSource !== source) {
            return; // not the owner or invalid entity
        }
        if (horse.state !== HorseState.Idle && horse.state !== HorseState.Following) {
            return;
        }

        TriggerClientEvent(ClientEvent.HORSE_SYNC_STATE, source, HorseState.Mounted);
    }

    @OnEvent(ServerEvent.HORSE_MOUNTED)
    public onMounted(
        source: number,
        netId: number,
        payload: { modelHash: number; skin: unknown; outfit: unknown }
    ): void {
        const player = this.playerService.getPlayer(source);
        if (!player) return;

        const horse = this.horsesByCitizenId.get(player.citizenid);
        if (!horse || horse.netId !== netId) return;

        horse.state = HorseState.Mounted;

        const riderPayload: RiderAppearancePayload = {
            horseNetId: netId,
            ownerServerId: source,
            modelHash: payload?.modelHash ?? 0,
            skin: payload?.skin ?? null,
            outfit: payload?.outfit ?? null,
        };
        horse.rider = riderPayload;

        TriggerClientEvent(ClientEvent.HORSE_RIDER_APPEARANCE, -1, riderPayload);
    }

    @OnEvent(ServerEvent.HORSE_DISMOUNTED)
    public onDismounted(source: number, newNetId: number): void {
        const player = this.playerService.getPlayer(source);
        if (!player) return;

        const horse = this.horsesByCitizenId.get(player.citizenid);
        if (!horse) return;

        if (horse.netId && horse.netId !== newNetId) {
            TriggerClientEvent(ClientEvent.HORSE_RIDER_REMOVE, -1, horse.netId);
        }

        horse.netId = newNetId;
        horse.state = HorseState.Idle;
        horse.rider = null;

        TriggerClientEvent(ClientEvent.HORSE_RIDER_REMOVE, -1, newNetId);
        TriggerClientEvent(ClientEvent.HORSE_SYNC_STATE, source, HorseState.Idle);
    }

    @OnEvent(ServerEvent.HORSE_DIED)
    public onHorseDied(source: number, netId: number): void {
        const player = this.playerService.getPlayer(source);
        if (!player) return;

        const horse = this.horsesByCitizenId.get(player.citizenid);
        if (!horse) return;

        if (netId) {
            TriggerClientEvent(ClientEvent.HORSE_DESPAWN_SYNC, -1, netId);
        }
        this.purge(horse);

        this.notifier.notify(source, 'Votre cheval est mort.', 'error');
    }

    @OnEvent(ServerEvent.HORSE_ENTITY_LOST)
    public onEntityLost(source: number, netId: number): void {
        const player = this.playerService.getPlayer(source);
        if (!player) return;

        const horse = this.horsesByCitizenId.get(player.citizenid);
        if (!horse || (netId && horse.netId !== netId)) return;

        if (horse.netId) {
            TriggerClientEvent(ClientEvent.HORSE_DESPAWN_SYNC, -1, horse.netId);
        }
        this.purge(horse);
    }

    @On('playerDropped')
    public onPlayerDropped(source: number): void {
        const horse = this.horsesBySource.get(source);
        if (!horse) return;

        if (horse.netId) {
            const entity = NetworkGetEntityFromNetworkId(horse.netId);
            if (entity && DoesEntityExist(entity)) {
                DeleteEntity(entity);
            }
            TriggerClientEvent(ClientEvent.HORSE_DESPAWN_SYNC, -1, horse.netId);
        }

        this.purge(horse);
    }

    private purge(horse: ServerHorse | undefined): void {
        if (!horse) return;
        this.horsesByCitizenId.delete(horse.ownerCitizenId);
        this.horsesBySource.delete(horse.ownerSource);
    }

    @Rpc(RpcServerEvent.HORSE_GET_STATE)
    public async getHorseState(source: number): Promise<HorseState> {
        const player = this.playerService.getPlayer(source);
        if (!player) return HorseState.Despawned;

        return this.horsesByCitizenId.get(player.citizenid)?.state ?? HorseState.Despawned;
    }
}
