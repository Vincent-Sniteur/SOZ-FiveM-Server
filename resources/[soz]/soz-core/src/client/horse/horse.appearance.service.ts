import { wait } from '@core/utils';

import { ClothingService } from '@public/client/clothing/clothing.service';
import { PedFactory } from '@public/client/factory/ped.factory';
import { PlayerService } from '@public/client/player/player.service';
import { ResourceLoader } from '@public/client/repository/resource.loader';
import {
    HORSE_DISMOUNT_OFFSET,
    HORSE_SEAT_BONE,
    HORSE_SEAT_OFFSET,
    RiderAppearancePayload,
    SavedAppearance,
} from '@public/shared/horse';

@Provider()
export class HorseAppearanceService {
    @Inject(PedFactory)
    private pedFactory: PedFactory;

    @Inject(ClothingService)
    private clothingService: ClothingService;

    @Inject(PlayerService)
    private playerService: PlayerService;

    @Inject(ResourceLoader)
    private resourceLoader: ResourceLoader;

    public async snapshot(): Promise<SavedAppearance> {
        const ped = PlayerPedId();
        const player = this.playerService.getPlayer();

        return {
            modelHash: GetEntityModel(ped),
            position: GetEntityCoords(ped) as [number, number, number],
            heading: GetEntityHeading(ped),
            health: GetEntityHealth(ped),
            armour: GetPedArmour(ped, true),
            skin: player?.skin ?? null,
            clothConfig: player?.cloth_config ?? null,
            currentOutfit: this.clothingService.getClothSet(ped),
        };
    }

    public async createRiderClone(payload: RiderAppearancePayload): Promise<number> {
        const horse = NetworkGetEntityFromNetworkId(payload.horseNetId);
        if (!DoesEntityExist(horse)) {
            return 0;
        }

        const modelHash = payload.modelHash;
        const coords = GetEntityCoords(horse) as [number, number, number];

        const clone = await this.pedFactory.createPed({
            model: modelHash,
            coords: { x: coords[0], y: coords[1], z: coords[2], w: GetEntityHeading(horse) },
            network: false,
            invincible: true,
            collision: false,
        });

        if (!clone) {
            return 0;
        }

        if (payload.skin) {
            await this.applySkin(clone, payload.skin);
        }
        if (payload.outfit) {
            this.clothingService.applyPedOutfit(clone, payload.outfit);
        }

        const seatBone = GetEntityBoneIndexByName(horse, HORSE_SEAT_BONE);
        AttachEntityToEntity(
            clone,
            horse,
            seatBone,
            HORSE_SEAT_OFFSET[0],
            HORSE_SEAT_OFFSET[1],
            HORSE_SEAT_OFFSET[2],
            0.0,
            0.0,
            0.0,
            false,
            false,
            false,
            true,
            0,
            true
        );

        return clone;
    }

    public removeRiderClone(entity: number): void {
        if (entity && DoesEntityExist(entity)) {
            DeleteEntity(entity);
        }
    }

    public async restorePlayer(appearance: SavedAppearance): Promise<void> {
        const model = appearance.modelHash;

        SetEntityInvincible(PlayerPedId(), true);

        if (await this.resourceLoader.loadModel(model)) {
            SetPlayerModel(PlayerId(), model);
        }

        this.resourceLoader.unloadModel(model);

        await wait(100);

        const ped = PlayerPedId();

        // Restore position next to the horse
        const dismountCoords = GetOffsetFromEntityInWorldCoords(
            ped,
            HORSE_DISMOUNT_OFFSET[0],
            HORSE_DISMOUNT_OFFSET[1],
            HORSE_DISMOUNT_OFFSET[2]
        ) as [number, number, number];
        SetEntityCoords(ped, dismountCoords[0], dismountCoords[1], dismountCoords[2], false, false, false, false);
        SetEntityHeading(ped, appearance.heading);
        SetEntityHealth(ped, Math.max(101, Math.min(appearance.health, GetEntityMaxHealth(ped))));
        SetPedArmour(ped, appearance.armour);

        // Restore visual identity through soz-character standard events
        TriggerEvent('soz-character:Client:ApplyCurrentSkin');
        TriggerEvent('soz-character:Client:ApplyCurrentClothConfig');

        await wait(50);
        SetEntityInvincible(ped, false);
    }

    private applySkin(target: number, skin): void {
        if (skin.Model) {
            SetPedHeadBlendData(
                target,
                skin.Model.Father,
                skin.Model.Mother,
                0,
                skin.Model.Father,
                skin.Model.Mother,
                0,
                skin.Model.ShapeMix,
                skin.Model.SkinMix,
                0,
                false
            );
        }

        if (skin.FaceTrait) {
            SetPedEyeColor(target, skin.FaceTrait.EyeColor);
        }

        if (skin.Tattoos) {
            for (const tattoo of skin.Tattoos) {
                AddPedDecorationFromHashes(target, tattoo.Collection, tattoo.Overlay);
            }
        }

        if (skin.Hair) {
            if (skin.Hair.Collection) {
                SetPedCollectionComponentVariation(target, 2, skin.Hair.Collection, skin.Hair.HairType, 0, 0);
            } else {
                SetPedComponentVariation(target, 2, skin.Hair.HairType, 0, 0);
            }
            SetPedHairColor(target, skin.Hair.HairColor, skin.Hair.HairSecondaryColor || 0);
        }
    }
}
