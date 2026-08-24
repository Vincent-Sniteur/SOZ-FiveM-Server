import { OnEvent, Once, OnceStep } from '@core/decorators/event';
import { Inject } from '@core/decorators/injectable';
import { Provider } from '@core/decorators/provider';
import { Tick, TickInterval } from '@core/decorators/tick';

import { Notifier } from '@public/client/notifier';
import { PlayerService } from '@public/client/player/player.service';
import { HorseAppearanceService } from '@public/client/horse/horse.appearance.service';
import { ResourceLoader } from '@public/client/repository/resource.loader';
import { TargetFactory } from '@public/client/target/target.factory';
import { emitRpc } from '@core/rpc';
import { wait } from '@core/utils';
import { ClientEvent, ServerEvent } from '@public/shared/event';
import {
    HORSE_MODEL,
    HorseFollowDeltaTrigger,
    HorseFollowDistance,
    HorseInteractDistance,
    HorseMaxFollowDistance,
    HorseMountKeyDistance,
    HorseSpawnDistance,
    HorseState,
} from '@public/shared/horse';
import { Control } from '@public/shared/input';
import { getDistance, Vector3 } from '@public/shared/polyzone/vector';
import { RpcServerEvent } from '@public/shared/rpc';

@Provider()
export class HorseProvider {
    @Inject(Notifier)
    private notifier: Notifier;

    @Inject(ResourceLoader)
    private resourceLoader: ResourceLoader;

    @Inject(TargetFactory)
    private targetFactory: TargetFactory;

    @Inject(HorseAppearanceService)
    private appearanceService: HorseAppearanceService;

    @Inject(PlayerService)
    private playerService: PlayerService;

    private horseEntity: number | null = null;
    private horseNetId: number | null = null;
    private state: HorseState = HorseState.Despawned;
    private isSpawning = false;
    private savedAppearance = null;
    private riderCloneEntity: number | null = null;
    private followTaskActive = false;
    private mountRequestPending = false;

    @Once(OnceStep.PlayerLoaded)
    public async onPlayerLoaded(): Promise<void> {
        const state = await emitRpc<HorseState>(RpcServerEvent.HORSE_GET_STATE);
        this.state = state ?? HorseState.Despawned;
        // The entity itself is not recreated on resource reload; server remains authoritative.
    }

    public getState(): HorseState {
        return this.state;
    }

    public getHorseEntity(): number | null {
        return this.horseEntity;
    }

    // ------------------------------------------------------------------
    // Spawn / Despawn
    // ------------------------------------------------------------------

    public async spawnHorse(): Promise<void> {
        if (this.isSpawning || this.state !== HorseState.Despawned) return;
        if (!DoesEntityExist(PlayerPedId())) return;

        this.isSpawning = true;

        try {
            const playerPed = PlayerPedId();
            const coords = GetEntityCoords(playerPed) as Vector3;
            const heading = GetEntityHeading(playerPed);

            const spawnCoord = GetOffsetFromCoordAndHeadingInWorldCoords(
                coords[0],
                coords[1],
                coords[2],
                heading,
                0,
                HorseSpawnDistance,
                0
            ) as Vector3;

            if (!(await this.resourceLoader.loadModel(HORSE_MODEL))) {
                this.notifier.error('Impossible de charger le modèle du cheval.');
                return;
            }

            const [x, y, z] = spawnCoord;
            const groundZ = await this.getGroundZ(x, y, z);
            const finalZ = groundZ !== null ? groundZ : z;

            const entity = CreatePed(0, HORSE_MODEL, x, y, finalZ, heading + 180, true, true);

            if (!entity || !DoesEntityExist(entity)) {
                this.resourceLoader.unloadModel(HORSE_MODEL);
                this.notifier.error("Impossible de faire apparaître le cheval ici.");
                return;
            }

            this.horseEntity = entity;

            PlaceObjectOnGroundProperly_2(entity);
            SetEntityAsMissionEntity(entity, true, true);
            SetBlockingOfNonTemporaryEvents(entity, true);
            SetPedFleeAttributes(entity, 0, false);
            SetEntityInvincible(entity, false);

            let networkId = NetworkGetNetworkIdFromEntity(entity);
            let attempts = 0;
            while (!NetworkGetEntityIsNetworked(entity) && attempts < 10) {
                NetworkRegisterEntityAsNetworked(entity);
                networkId = NetworkGetNetworkIdFromEntity(entity);
                attempts += 1;
                await wait(100);
            }

            if (networkId) {
                SetNetworkIdExistsOnAllMachines(networkId, true);
                this.horseNetId = networkId;
            }

            this.state = HorseState.Idle;
            this.registerTarget();

            TriggerServerEvent(ServerEvent.HORSE_SPAWNED, this.horseNetId);
            this.notifier.notify('Votre cheval est arrivé.', 'success');
        } finally {
            this.isSpawning = false;
        }
    }

    public async despawnHorse(): Promise<void> {
        if (this.state === HorseState.Mounted) {
            await this.dismountHorse();
        }

        if (!this.horseEntity || !DoesEntityExist(this.horseEntity)) {
            this.resetLocalState();
            TriggerServerEvent(ServerEvent.HORSE_DESPAWNED);
            return;
        }

        await this.ensureControl(this.horseEntity);

        DeleteEntity(this.horseEntity);
        this.resetLocalState();

        TriggerServerEvent(ServerEvent.HORSE_DESPAWNED);
        this.notifier.notify('Votre cheval est parti.', 'info');
    }

    private resetLocalState(): void {
        if (this.horseEntity && this.riderCloneEntity && DoesEntityExist(this.riderCloneEntity)) {
            DeleteEntity(this.riderCloneEntity);
        }
        this.horseEntity = null;
        this.horseNetId = null;
        this.riderCloneEntity = null;
        this.savedAppearance = null;
        this.followTaskActive = false;
        this.mountRequestPending = false;
        this.state = HorseState.Despawned;
    }

    // ------------------------------------------------------------------
    // Target registration
    // ------------------------------------------------------------------

    private registerTarget(): void {
        if (!this.horseEntity) return;

        this.targetFactory.createForEntity(
            this.horseEntity,
            [
                {
                    label: 'Monter',
                    icon: 'horse/mount',
                    category: 'citizen',
                    canInteract: () =>
                        this.state === HorseState.Idle || this.state === HorseState.Following,
                    action: () => this.mountHorse(),
                },
                {
                    label: 'Suivre',
                    icon: 'pet/follow',
                    category: 'citizen',
                    canInteract: () => this.state === HorseState.Idle,
                    action: () => this.startFollowing(),
                },
                {
                    label: 'Arrêter de suivre',
                    icon: 'pet/stop',
                    category: 'citizen',
                    canInteract: () => this.state === HorseState.Following,
                    action: () => this.stopFollowing(false),
                },
            ],
            HorseInteractDistance
        );
    }

    private unregisterTarget(): void {
        if (this.horseEntity) {
            this.targetFactory.removeForEntity([this.horseEntity]);
        }
    }

    // ------------------------------------------------------------------
    // Following
    // ------------------------------------------------------------------

    public startFollowing(): void {
        if (this.state !== HorseState.Idle) return;
        this.followTaskActive = true;
        this.state = HorseState.Following;
        this.notifier.notify('Votre cheval vous suit.', 'info');
    }

    public stopFollowing(automatic: boolean): void {
        if (this.state !== HorseState.Following) return;
        this.followTaskActive = false;
        this.state = HorseState.Idle;
        if (automatic) {
            this.notifier.notify('Votre cheval s\'est arrêté : vous étiez trop loin.', 'info');
        }
    }

    // ------------------------------------------------------------------
    // Follow loop tick
    // ------------------------------------------------------------------

    @Tick(TickInterval.EVERY_FRAME * 100)
    public async followLoop(): Promise<void> {
        if (this.state !== HorseState.Following || !this.horseEntity || !DoesEntityExist(this.horseEntity)) {
            return;
        }
        if (IsEntityDead(this.horseEntity)) {
            await this.onHorseDied();
            return;
        }

        const ped = PlayerPedId();
        const distance = getDistance(GetEntityCoords(ped) as Vector3, GetEntityCoords(this.horseEntity) as Vector3);

        if (distance > HorseMaxFollowDistance) {
            this.stopFollowing(true);
            return;
        }

        if (IsPedInAnyVehicle(ped, false)) {
            this.stopFollowing(true);
            return;
        }

        await this.ensureControl(this.horseEntity);

        // Only re-task when the player actually moved away or is moving
        const shouldMove =
            !IsEntityStatic(ped) ||
            distance > HorseFollowDistance + HorseFollowDeltaTrigger;

        if (shouldMove) {
            const angle = Math.random() < 0.5 ? -45 : 45;
            TaskGotoEntityOffset(this.horseEntity, ped, -1, HorseFollowDistance, angle, 100, 1);
        }
    }

    // ------------------------------------------------------------------
    // Mount / Dismount
    // ------------------------------------------------------------------

    public async mountHorse(): Promise<void> {
        if (
            this.mountRequestPending ||
            (this.state !== HorseState.Idle && this.state !== HorseState.Following) ||
            !this.horseEntity ||
            !DoesEntityExist(this.horseEntity)
        ) {
            return;
        }

        if (this.mountRequestPending) return;

        this.mountRequestPending = true;
        this.followTaskActive = false;

        TriggerServerEvent(ServerEvent.HORSE_MOUNT_REQUEST, this.horseNetId);

        // Server confirms via ClientEvent.HORSE_SYNC_STATE (Mounted) -> onSyncState
        setTimeout(() => (this.mountRequestPending = false), 2000);
    }

    private async transformIntoHorse(): Promise<void> {
        if (!this.horseEntity || !DoesEntityExist(this.horseEntity)) return;

        // Snapshot before any transformation
        this.savedAppearance = await this.appearanceService.snapshot();

        // Broadcast rider appearance to other clients via the server
        TriggerServerEvent(ServerEvent.HORSE_MOUNTED, this.horseNetId, {
            modelHash: this.savedAppearance.modelHash,
            skin: this.savedAppearance.skin,
            outfit: this.savedAppearance.currentOutfit,
        });

        // Local clone rendering handled by sync provider through broadcast event.
        // Transform the local player into the horse ped.
        SetEntityInvincible(PlayerPedId(), true);

        if (!(await this.resourceLoader.loadModel(HORSE_MODEL))) {
            SetEntityInvincible(PlayerPedId(), false);
            this.notifier.error('Transformation impossible.');
            return;
        }

        const horseCoords = GetEntityCoords(this.horseEntity) as Vector3;
        const horseHeading = GetEntityHeading(this.horseEntity);

        SetPlayerModel(PlayerId(), HORSE_MODEL);
        this.resourceLoader.unloadModel(HORSE_MODEL);

        const ped = PlayerPedId();
        SetEntityCoords(ped, horseCoords[0], horseCoords[1], horseCoords[2], false, false, false, false);
        SetEntityHeading(ped, horseHeading);

        await wait(50);
        SetEntityInvincible(ped, false);

        this.unregisterTarget();
        this.state = HorseState.Mounted;
    }

    @Tick(TickInterval.EVERY_FRAME * 20)
    public async dismountKeyListener(): Promise<void> {
        if (this.state !== HorseState.Mounted) return;

        if (IsDisabledControlJustPressed(0, Control.Enter)) {
            await this.dismountHorse();
            return;
        }

        const ped = PlayerPedId();
        if (IsEntityDead(ped)) {
            await this.dismountHorse();
        }
    }

    public async dismountHorse(): Promise<void> {
        if (this.state !== HorseState.Mounted || !this.savedAppearance) return;

        const mountedPed = PlayerPedId();
        const horseCoords = GetEntityCoords(mountedPed) as Vector3;
        const horseHeading = GetEntityHeading(mountedPed);

        // Restore original player identity
        await this.appearanceService.restorePlayer(this.savedAppearance);

        this.savedAppearance = null;

        // Recreate a fresh horse at the dismount position so it stays in world
        if (!(await this.resourceLoader.loadModel(HORSE_MODEL))) {
            this.notifier.error('Le cheval n\'a pas pu être conservé.');
            return;
        }

        const newHorse = CreatePed(0, HORSE_MODEL, horseCoords[0], horseCoords[1], horseCoords[2], horseHeading, true, true);
        this.resourceLoader.unloadModel(HORSE_MODEL);

        if (newHorse && DoesEntityExist(newHorse)) {
            SetEntityAsMissionEntity(newHorse, true, true);
            SetBlockingOfNonTemporaryEvents(newHorse, true);
            SetPedFleeAttributes(newHorse, 0, false);

            let netId = NetworkGetNetworkIdFromEntity(newHorse);
            let attempts = 0;
            while (!NetworkGetEntityIsNetworked(newHorse) && attempts < 10) {
                NetworkRegisterEntityAsNetworked(newHorse);
                netId = NetworkGetNetworkIdFromEntity(newHorse);
                attempts += 1;
                await wait(100);
            }
            if (netId) SetNetworkIdExistsOnAllMachines(netId, true);

            this.horseEntity = newHorse;
            this.horseNetId = netId;
        } else {
            this.notifier.error('Le cheval n\'a pas pu être conservé.');
            this.resetLocalState();
            return;
        }

        this.registerTarget();

        TriggerServerEvent(ServerEvent.HORSE_DISMOUNTED, this.horseNetId);
        this.state = HorseState.Idle;
    }

    // ------------------------------------------------------------------
    // Mount key proximity check (F to mount when close)
    // ------------------------------------------------------------------

    @Tick(TickInterval.EVERY_FRAME * 50)
    public async proximityMountCheck(): Promise<void> {
        if (this.state !== HorseState.Idle && this.state !== HorseState.Following) return;
        if (!this.horseEntity || !DoesEntityExist(this.horseEntity)) return;

        const ped = PlayerPedId();
        if (IsPedInAnyVehicle(ped, false)) return;

        const distance = getDistance(GetEntityCoords(ped) as Vector3, GetEntityCoords(this.horseEntity) as Vector3);
        if (distance > HorseMountKeyDistance) return;

        if (IsDisabledControlJustPressed(0, Control.Enter)) {
            await this.mountHorse();
        }
    }

    // ------------------------------------------------------------------
    // Death & invalidation handling
    // ------------------------------------------------------------------

    @Tick(TickInterval.EVERY_SECOND)
    public async healthWatchdog(): Promise<void> {
        if ((this.state === HorseState.Idle || this.state === HorseState.Following) && this.horseEntity) {
            if (!DoesEntityExist(this.horseEntity) || IsEntityDead(this.horseEntity)) {
                await this.onHorseDied();
            }
        }
    }

    private async onHorseDied(): Promise<void> {
        if (this.state === HorseState.Despawned) return;

        TriggerServerEvent(ServerEvent.HORSE_DIED, this.horseNetId);

        if (this.horseEntity && DoesEntityExist(this.horseEntity)) {
            await this.ensureControl(this.horseEntity);
            DeleteEntity(this.horseEntity);
        }

        this.resetLocalState();
        this.notifier.notify('Votre cheval est mort.', 'error');
    }

    // ------------------------------------------------------------------
    // Server-driven events
    // ------------------------------------------------------------------

    @OnEvent(ClientEvent.HORSE_SPAWN)
    public async onServerSpawnOrder(): Promise<void> {
        await this.spawnHorse();
    }

    @OnEvent(ClientEvent.HORSE_DESPAWN)
    public async onServerDespawnOrder(): Promise<void> {
        await this.despawnHorse();
    }

    @OnEvent(ClientEvent.HORSE_SYNC_STATE)
    public async onSyncState(state: HorseState): Promise<void> {
        const previous = this.state;
        this.state = state ?? HorseState.Despawned;

        if (state === HorseState.Mounted && previous !== HorseState.Mounted) {
            await this.transformIntoHorse();
        }
    }

    // ------------------------------------------------------------------
    // Utility
    // ------------------------------------------------------------------

    private async ensureControl(entity: number): Promise<boolean> {
        if (NetworkHasControlOfEntity(entity)) return true;

        NetworkRequestControlOfEntity(entity);
        for (let i = 0; i < 20; i++) {
            if (NetworkHasControlOfEntity(entity)) {
                return true;
            }
            await wait(50);
        }
        return NetworkHasControlOfEntity(entity);
    }

    private async getGroundZ(x: number, y: number, z: number): Promise<number | null> {
        const [found, groundZ] = GetGroundZFor_3dCoord(x, y, z, false);
        return found ? groundZ : null;
    }
}
