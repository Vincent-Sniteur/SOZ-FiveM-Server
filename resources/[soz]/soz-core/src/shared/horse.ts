import { Vector3 } from './polyzone/vector';

export const HORSE_MODEL = 'soz_horse';
export const CRAVACHE_ITEM_NAME = 'cravache';

export enum HorseState {
    Despawned = 'DESPAWNED',
    Idle = 'IDLE',
    Following = 'FOLLOWING',
    Mounted = 'MOUNTED',
}

// Distances (metres)
export const HorseSpawnDistance = 1.5;
export const HorseFollowDistance = 2.0;
export const HorseFollowDeltaTrigger = 1.5;
export const HorseMaxFollowDistance = 100;
export const HorseInteractDistance = 2.5;
export const HorseMountKeyDistance = 3.0;

// Seat attachment on the horse ped
export const HORSE_SEAT_BONE = 'SKEL_Spine3';
export const HORSE_SEAT_OFFSET: Vector3 = [0, -0.15, 0.35];
export const HORSE_DISMOUNT_OFFSET: Vector3 = [1.5, 0, 0];

export type SavedAppearance = {
    modelHash: number;
    position: Vector3;
    heading: number;
    health: number;
    armour: number;
    skin: unknown; // Skin - typed loosely to avoid circular import weight at runtime
    clothConfig: unknown; // ClothConfig
    currentOutfit: unknown; // Outfit
};

export type RiderAppearancePayload = {
    horseNetId: number;
    ownerServerId: number;
    modelHash: number;
    skin: unknown;
    outfit: unknown;
};

